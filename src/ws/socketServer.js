// src/ws/socketServer.js
const WebSocket = require('ws');
const logger = require('../utils/logger');
const socketService = require('../services/socketService');

// meetingId -> { participants: Set<userId>, iceCandidates: { [userId]: [] }, sdps: { [userId]: {sdp,sdpType} } }
const meetings = new Map();

/**
 * Setup WebSocket server attached to existing HTTP server
 * @param {http.Server} server
 * @param {string} wsPath (defaults to '/ws')
 */
function setupWebSocketServer(server, wsPath = '/ws') {
  const wss = new WebSocket.Server({ server, path: wsPath });

  logger.info('🚀 WebSocket attached at path', wsPath);

  wss.on('connection', (ws, req) => {
    const clientId = socketService.addSocket(ws);
    logger.info(`[CONNECT] clientId=${clientId} remote=${req.socket.remoteAddress}`);

    ws.on('message', (msg) => {
      handleMessage(clientId, msg);
    });

    ws.on('close', () => {
      const meta = socketService.getMeta(clientId);
      logger.info(`[CLOSE] clientId=${clientId} meta=${JSON.stringify(meta)}`);
      if (meta && meta.meetingId && meta.userId) {
        removeUserFromMeeting(meta.userId, meta.meetingId);
      }
      socketService.removeSocket(clientId);
    });

    ws.on('error', (err) => {
      logger.error(`[WS ERROR] clientId=${clientId}`, err);
    });
  });

  return wss;
}

/* ------------------- message handling ------------------- */

function handleMessage(clientId, rawMessage) {
  try {
    // try parse
    let msg = rawMessage;
    if (typeof msg !== 'string') msg = msg.toString();
    const parsed = JSON.parse(msg);

    const { type, data } = parsed || {};
    const meta = socketService.getMeta(clientId) || {};
    const currentUserId = meta.userId;
    const currentMeetingId = meta.meetingId;

    logger.info(`📩 Received Message\nType: ${type}\nFrom(clientId): ${clientId}\nMeta: ${JSON.stringify(meta)}\nPayload: ${JSON.stringify(data)}`);

    switch (type) {
      case 'register':
        return handleRegister(clientId, data);
      case 'join_request':
        return handleJoinRequest(clientId, data);
      case 'offer':
        return handleOffer(clientId, data);
      case 'answer':
        return handleAnswer(clientId, data);
      case 'ice_candidate':
        return handleIceCandidate(clientId, data);
      case 'leave':
        return handleLeave(clientId, data);
      default:
        logger.warn(`[UNKNOWN] type=${type}`);
        sendToClient(clientId, { type: 'error', data: { message: `Unknown message type: ${type}` } });
    }
  } catch (err) {
    logger.error('[HANDLE ERROR]', err);
    sendToClient(clientId, { type: 'error', data: { message: err.message } });
  }
}

/* ------------------- helpers & handlers ------------------- */

function sendToClient(clientId, payload) {
  const ws = socketService.getWsByClientId(clientId);
  if (!ws) {
    logger.warn(`[SEND FAIL] client not found ${clientId}`);
    return;
  }
  try {
    const s = JSON.stringify(payload);
    ws.send(s);
    const meta = socketService.getMeta(clientId) || {};
    logger.info(`Sending Message\nto clientId:${clientId}\nuser:${meta.userId || 'unknown'}\nPayload:${s}`);
  } catch (err) {
    logger.error('[SEND ERROR]', err);
  }
}

function broadcastToMeeting(meetingId, excludeClientId, payload) {
  for (const clientId of socketService.listClients()) {
    if (clientId === excludeClientId) continue;
    const meta = socketService.getMeta(clientId);
    if (meta && meta.meetingId === meetingId) {
      sendToClient(clientId, payload);
    }
  }
  logger.info(`📣 [BROADCAST] meeting=${meetingId} type=${payload.type}`);
}

/* ------------------- register ------------------- */
/**
 * data: { from: "userId", name: "Nadim" }
 * - 'from' must be the user id created earlier via /api/users (but we don't enforce strictly)
 */
function handleRegister(clientId, data) {
  if (!data || !data.from) {
    throw new Error('register requires from (userId)');
  }
  const userId = data.from;
  const name = data.name || 'unknown';

  // bind socket <-> user
  socketService.bindUser(clientId, userId);

  // respond
  sendToClient(clientId, {
    type: 'registered',
    data: { id: userId, name, is_online: true, created_at: new Date().toISOString() },
  });
  logger.info(`[REGISTER] clientId=${clientId} user=${userId} name=${name}`);
}

/* ------------------- join_request ------------------- */
/**
 * data: { from: "userId", meeting_id: "m-..." }
 * Response to requester: { type: 'participants', data: { participants: [userId,...] } }
 * Server also NOTIFIES existing participants via 'participant_joined' broadcast
 */
function handleJoinRequest(clientId, data) {
  if (!data || !data.from || !data.meeting_id) {
    throw new Error('join_request requires from and meeting_id');
  }
  const userId = data.from;
  const meetingId = data.meeting_id;

  // bind meeting
  socketService.bindMeeting(clientId, meetingId);

  if (!meetings.has(meetingId)) {
    meetings.set(meetingId, {
      participants: new Set(),
      iceCandidates: {},
      sdps: {},
    });
  }
  const meeting = meetings.get(meetingId);
  const prev = Array.from(meeting.participants);
  meeting.participants.add(userId);

  // reply with participant list
  sendToClient(clientId, { type: 'participants', data: { participants: prev } });

  // notify others that a participant joined (they can expect offers from new participant soon)
  broadcastToMeeting(meetingId, clientId, { type: 'participant_joined', data: { userId, meetingId } });

  // also send meeting state (ice + sdps) to the new user
  sendToClient(clientId, {
    type: 'meeting_state',
    data: {
      meetingId,
      participants: Array.from(meeting.participants),
      iceMap: meeting.iceCandidates,
      sdpMap: meeting.sdps,
    },
  });

  logger.info(`[JOIN] user=${userId} meeting=${meetingId}`);
}

/* ------------------- offer ------------------- */
/**
 * data either:
 *  - { offers: [ {from,to,sdp_details}, ... ] } // meeting or list-based
 *  - { offers: [ ... ], to: "targetUserId" } // optional to override and send direct
 *
 * If 'to' provided at top-level -> forward offers directly to that user (1:1).
 * Otherwise for each offer, send offer to the 'to' target.
 */
function handleOffer(clientId, data) {
  if (!data || !data.offers || !Array.isArray(data.offers)) {
    throw new Error('offer requires offers array');
  }

  const topLevelTo = data.to; // optional shorthand target
  if (topLevelTo) {
    const targetClient = socketService.getClientIdByUser(topLevelTo);
    if (!targetClient) {
      sendToClient(clientId, { type: 'error', data: { message: 'Target not online' } });
      return;
    }
    sendToClient(targetClient, { type: 'offer', data: { offers: data.offers } });
    return;
  }

  // per-offer routing
  data.offers.forEach((offer) => {
    const to = offer.to;
    if (!to) return;
    const targetClient = socketService.getClientIdByUser(to);
    if (targetClient) {
      sendToClient(targetClient, { type: 'offer', data: { offers: [offer] } });
      logger.info(`[OFFER] forwarded from ${offer.from} -> ${to}`);
    } else {
      logger.warn(`[OFFER] target ${to} not online`);
    }

    // Also store SDP in meeting sdps if meeting_id provided on offer (optional)
    if (offer.meeting_id) {
      const m = meetings.get(offer.meeting_id);
      if (m) {
        m.sdps[offer.from] = offer.sdp_details;
      }
    }
  });
}

/* ------------------- answer ------------------- */
/**
 * data:
 *  - { answers: [ {from,to,sdp_details, meeting_id?}, ... ] }  // meeting or list
 *  - or top-level `to` to direct
 *
 * Server forwards answers to target(s) and stores in meeting map if meeting_id present.
 */
function handleAnswer(clientId, data) {
  if (!data || !data.answers || !Array.isArray(data.answers)) {
    throw new Error('answer requires answers array');
  }

  const topLevelTo = data.to;
  if (topLevelTo) {
    const targetClient = socketService.getClientIdByUser(topLevelTo);
    if (!targetClient) {
      sendToClient(clientId, { type: 'error', data: { message: 'Target not online' } });
      return;
    }
    sendToClient(targetClient, { type: 'answer', data: { answers: data.answers } });
    return;
  }

  data.answers.forEach((ans) => {
    const to = ans.to;
    if (!to) return;
    const targetClient = socketService.getClientIdByUser(to);
    if (targetClient) {
      sendToClient(targetClient, { type: 'answer', data: { answers: [ans] } });
      logger.info(`[ANSWER] forwarded from ${ans.from} -> ${to}`);
    } else {
      logger.warn(`[ANSWER] target ${to} not online`);
    }

    // store in meeting map if provided
    if (ans.meeting_id) {
      const m = meetings.get(ans.meeting_id);
      if (m) m.sdps[ans.from] = ans.sdp_details;
    }
  });
}

/* ------------------- ice_candidate ------------------- */
/**
 * data:
 *  - { from: userId, candidates: [ { user_id: targetId, candidates: [ {candidate,sdpMid,sdpMLineIndex}, ... ] }, ... ], to?: targetId }
 *
 * If data.to exists -> forward to that user (direct)
 * Otherwise -> treat as meeting candidates and store + broadcast
 */
function handleIceCandidate(clientId, data) {
  if (!data || !data.from || !data.candidates || !Array.isArray(data.candidates)) {
    throw new Error('ice_candidate requires from and candidates array');
  }

  const topLevelTo = data.to;
  if (topLevelTo) {
    const targetClient = socketService.getClientIdByUser(topLevelTo);
    if (!targetClient) {
      sendToClient(clientId, { type: 'error', data: { message: 'Target not online' } });
      return;
    }
    // forward candidate payload directly
    sendToClient(targetClient, { type: 'ice_candidate', data: { from: data.from, candidates: data.candidates } });
    logger.info(`[ICE] Direct forwarded from ${data.from} -> ${topLevelTo}`);
    return;
  }

  // meeting-based: for each { user_id, candidates: [...] } entry
  data.candidates.forEach((entry) => {
    const targetUserId = entry.user_id;
    // store candidate in meeting that contains both (if any)
    // find meeting(s) where from and targetUserId are both present (simple linear check)
    for (const [meetingId, meeting] of meetings.entries()) {
      if (meeting.participants.has(data.from)) {
        // ensure array exists
        if (!meeting.iceCandidates[data.from]) meeting.iceCandidates[data.from] = [];
        meeting.iceCandidates[data.from].push(...entry.candidates);
      }
    }

    // forward candidates to the target user if online
    const targetClient = socketService.getClientIdByUser(targetUserId);
    if (targetClient) {
      sendToClient(targetClient, { type: 'ice_candidate', data: { from: data.from, candidates: [entry] } });
      logger.info(`[ICE] forwarded ${data.from} -> ${targetUserId}`);
    }
  });

  // option: broadcast full ice map to meeting participants (if you want)
}

/* ------------------- leave ------------------- */
function handleLeave(clientId, data) {
  if (!data || !data.from) {
    throw new Error('leave requires from');
  }
  const userId = data.from;
  const meetingId = data.meeting_id || socketService.getMeta(clientId).meetingId;

  if (meetingId && meetings.has(meetingId)) {
    removeUserFromMeeting(userId, meetingId);
  }

  // optionally remove socket->user mapping if this user logs out
  // socketService.removeSocket(clientId) -> handled on close
  logger.info(`[LEAVE] user=${userId} meeting=${meetingId || 'none'}`);
}

/* ------------------- meeting helpers ------------------- */
function removeUserFromMeeting(userId, meetingId) {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  meeting.participants.delete(userId);
  delete meeting.iceCandidates[userId];
  delete meeting.sdps[userId];

  // broadcast participant_left
  broadcastToMeeting(meetingId, null, { type: 'participant_left', data: { from: userId } });
  logger.info(`[REMOVE] user=${userId} removed from meeting=${meetingId}`);
}

module.exports = setupWebSocketServer;
