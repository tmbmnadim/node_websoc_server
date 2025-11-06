// ws/socketServer.js
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const socketService = require('../services/socketService');

/**
 * In-memory meeting state:
 * meetings[meetingId] = {
 *   participants: Set<userId>,
 *   sdps: { userId: { sdp, sdpType } },   // optional cached sdps
 *   iceCandidates: { userId: [candidate, ...] }
 * }
 *
 * waitingAnswers[joinerKey] = {
 *   expected: Set<userId>,
 *   collected: { userId: answerObject },
 *   collectedCandidates: { userId: [candidate...] },
 *   joinerClientId,
 *   timer
 * }
 */

const meetings = {};
const waitingAnswers = {};

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setupWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const clientId = socketService.addSocket(ws);
    logger.info(`🟢 [CONNECT] client ${clientId}`);

    ws.on('message', (raw) => handleMessage(clientId, raw));
    ws.on('close', () => handleClose(clientId));
    ws.on('error', (err) => logger.error(`❌ [WS ERROR] client ${clientId}: ${err && err.message}`));
  });

  logger.info(`🚀 WebSocket attached at path ${config.wsPath}`);
}

/* -------------------------
   Message handling
   ------------------------- */
function handleMessage(clientId, raw) {
  const parsed = tryParse(raw);
  if (!parsed) {
    logger.warn('[MSG] invalid json from', clientId);
    sendToClient(clientId, { type: 'error', data: { message: 'invalid json' } });
    return;
  }

  const type = parsed.type;
  const data = parsed.data || {};
  const meta = socketService.getMeta(clientId) || {};
  const boundUser = meta.userId || data.from || null;
  const boundMeeting = meta.meetingId || data.meeting_id || data.meetingId || null;

  logger.info(`📩 [RECV] type:${type} from(client:${clientId},user:${boundUser}) meeting:${boundMeeting}`);
  logger.debug('payload:', JSON.stringify(data));

  try {
    switch (type) {
      case 'register':
        return handleRegister(clientId, data);
      case 'join_request':
        return handleJoinRequest(clientId, boundUser, data);
      case 'offer':
        return handleOffer(clientId, boundUser, data);
      case 'answer':
        return handleAnswer(clientId, boundUser, data);
      case 'ice_candidate':
        return handleIceCandidate(clientId, boundUser, data);
      case 'leave':
        return handleLeave(clientId, boundUser, boundMeeting);
      default:
        logger.warn(`[MSG] unknown type ${type}`);
        sendToClient(clientId, { type: 'error', data: { message: `unknown type: ${type}` } });
    }
  } catch (err) {
    logger.error('[HANDLE ERROR]', err && err.stack ? err.stack : err);
    sendToClient(clientId, { type: 'error', data: { message: err.message || String(err) } });
  }
}

/* -------------------------
   Handlers
   ------------------------- */

function handleRegister(clientId, data) {
  if (!data || !data.from) throw new Error('register requires from (userId)');
  const userId = data.from;
  socketService.bindUser(clientId, userId);
  logger.info(`[REGISTER] client ${clientId} -> user ${userId}`);
  sendToClient(clientId, { type: 'registered', data: { from: userId } });
}

/**
 * join_request -> respond with participants: [userId...]
 */
function handleJoinRequest(clientId, fromUser, data) {
  if (!fromUser) throw new Error('Must register before join_request');
  const meetingId = data.meeting_id;
  if (!meetingId) throw new Error('join_request requires meeting_id');

  if (!meetings[meetingId]) {
    meetings[meetingId] = { participants: new Set(), sdps: {}, iceCandidates: {} };
  }

  const participants = Array.from(meetings[meetingId].participants || []);
  logger.info(`[JOIN_REQUEST] ${fromUser} asked participants for ${meetingId}: ${participants.length} participants`);
  sendToClient(clientId, { type: 'participants', data: { meeting_id: meetingId, participants } });
}

/**
 * offer: { from, meeting_id?, offers: [{from,to,sdp_details}, ...] }
 * - forward each offer as type 'offer' with single-item offers array to the target user
 * - if meeting flow (meeting_id present) set up waitingAnswers aggregator for joiner
 */
function handleOffer(clientId, fromUser, data) {
  if (!fromUser) throw new Error('Must register to send offers');
  const meetingId = data.meeting_id || null;
  const offers = data.offers;
  if (!offers || !Array.isArray(offers) || offers.length === 0) throw new Error('offers array required');

  // collect distinct targets
  const targets = new Set();
  for (const o of offers) {
    if (o && o.to) targets.add(o.to);
  }

  let joinerKey = null;
  if (meetingId) {
    joinerKey = `${meetingId}:${fromUser}`;
    waitingAnswers[joinerKey] = {
      expected: new Set(Array.from(targets)),
      collected: {},
      collectedCandidates: {},
      joinerClientId: clientId,
      timer: null,
    };
    // small aggregation window for answers
    waitingAnswers[joinerKey].timer = setTimeout(() => flushWaitingAnswers(joinerKey), 3000);
  }

  // Forward each single offer to its target as 'offer'
  for (const o of offers) {
    const target = o.to;
    const payload = {
      type: 'offer',
      data: {
        offers: [ { from: o.from, to: o.to, sdp_details: o.sdp_details } ],
        meeting_id: meetingId,
      },
    };

    const targetClientId = socketService.getClientIdByUser(target);
    if (targetClientId) {
      sendToClient(targetClientId, payload);
      logger.info(`[FORWARD OFFER] ${o.from} -> ${target} (client ${targetClientId})`);
    } else {
      logger.warn(`[FORWARD OFFER] target ${target} not online`);
      // Optionally notify joiner: sendToClient(clientId, {type:'denied', data:{message:`target ${target} offline`}});
      // Also, remove expected target so waitingAnswers won't wait forever
      if (joinerKey && waitingAnswers[joinerKey]) {
        waitingAnswers[joinerKey].expected.delete(target);
      }
    }

    // Add target user to meeting participants if meeting flow (they are already participants in existing meeting typically)
    if (meetingId) {
      if (!meetings[meetingId]) meetings[meetingId] = { participants: new Set(), sdps: {}, iceCandidates: {} };
      meetings[meetingId].participants.add(o.to);
    }
  }

  // ack to sender
  sendToClient(clientId, { type: 'offer', data: { from: fromUser, status: 'sent' } });
}

/**
 * answer: { from, meeting_id?, answers: [{from,to,sdp_details}], candidates: [{user_id, candidates: [...]}, ...] }
 *
 * Behavior:
 * - For each answer entry: if there is a waitingAnswers entry for key `${meetingId}:${to}` (joiner flow),
 *   collect the answer and candidates.
 * - If waiting entry doesn't exist -> forward immediately to the `to` user as type 'answer'
 */
function handleAnswer(clientId, fromUser, data) {
  if (!fromUser) throw new Error('Must register to send answers');
  const answers = data.answers;
  const candidateGroups = data.candidates || []; // array of { user_id, candidates }
  const meetingId = data.meeting_id || null;

  if (!answers || !Array.isArray(answers) || answers.length === 0) throw new Error('answers array required');

  // build a helper map from candidateGroups for easy lookups
  const candidatesMap = {};
  if (Array.isArray(candidateGroups)) {
    for (const g of candidateGroups) {
      if (g && g.user_id) {
        candidatesMap[g.user_id] = g.candidates || [];
      }
    }
  }

  for (const ans of answers) {
    const toUser = ans.to;
    const joinerKey = meetingId ? `${meetingId}:${toUser}` : null;

    if (joinerKey && waitingAnswers[joinerKey]) {
      // collect answer for aggregator
      waitingAnswers[joinerKey].collected[fromUser] = ans;
      waitingAnswers[joinerKey].collectedCandidates[fromUser] = candidatesMap[fromUser] || [];
      logger.info(`[COLLECT ANSWER] from ${fromUser} for joiner ${toUser} (meeting ${meetingId})`);

      const expected = waitingAnswers[joinerKey].expected;
      const collectedKeys = Object.keys(waitingAnswers[joinerKey].collected);
      const haveAll = Array.from(expected).every((u) => collectedKeys.includes(u));
      if (haveAll) {
        flushWaitingAnswers(joinerKey);
      }
    } else {
      // no aggregator -> forward immediately
      const targetClientId = socketService.getClientIdByUser(toUser);
      if (targetClientId) {
        const payload = {
          type: 'answer',
          data: {
            answers: [ ans ],
            candidates: candidateGroups // forward candidateGroups as-is
          }
        };
        sendToClient(targetClientId, payload);
        logger.info(`[FORWARD ANSWER] ${fromUser} -> ${toUser}`);
      } else {
        logger.warn(`[FORWARD ANSWER] target ${toUser} not online`);
      }
    }
  }

  // ack
  sendToClient(clientId, { type: 'answer', data: { from: fromUser, status: 'received' } });
}

/**
 * flushWaitingAnswers(joinerKey)
 * -> build aggregated answers array and combined candidates array of {user_id, candidates}
 * -> send one 'answer' message to joiner
 */
function flushWaitingAnswers(joinerKey) {
  const entry = waitingAnswers[joinerKey];
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  const collectedAnswers = [];
  const combinedCandidates = [];

  for (const userId of Object.keys(entry.collected)) {
    const ans = entry.collected[userId];
    collectedAnswers.push(ans);

    const cands = entry.collectedCandidates[userId] || [];
    if (Array.isArray(cands) && cands.length > 0) {
      combinedCandidates.push({ user_id: userId, candidates: cands });
    }
  }

  const joinerClientId = entry.joinerClientId;
  if (joinerClientId) {
    const payload = {
      type: 'answer',
      data: {
        answers: collectedAnswers,
        candidates: combinedCandidates
      }
    };
    sendToClient(joinerClientId, payload);
    logger.info(`[FLUSH ANSWERS] Sent ${collectedAnswers.length} answers to joiner (client ${joinerClientId})`);
  } else {
    logger.warn(`[FLUSH ANSWERS] joiner client not found for ${joinerKey}`);
  }

  delete waitingAnswers[joinerKey];
}

/**
 * ice_candidate handler (incremental)
 * - If data.to provided -> forward to that user
 * - Else if data.meeting_id provided -> add to meeting map and broadcast aggregated ice info
 * Note: your primary candidate flow is in answers.candidates; this incremental handler is optional.
 */
function handleIceCandidate(clientId, fromUser, data) {
  if (!fromUser) throw new Error('must register first');
  if (!data.candidate) throw new Error('candidate missing');

  const toUser = data.to || null;
  const meetingId = data.meeting_id || data.meetingId || null;

  if (toUser) {
    const targetClientId = socketService.getClientIdByUser(toUser);
    if (!targetClientId) {
      sendToClient(clientId, { type: 'error', data: { message: `target ${toUser} offline` } });
      return;
    }
    sendToClient(targetClientId, { type: 'ice_candidate', data: { from: fromUser, to: toUser, candidate: data.candidate } });
    logger.info(`[ICE FORWARD] ${fromUser} -> ${toUser}`);
    return;
  }

  if (meetingId) {
    if (!meetings[meetingId]) meetings[meetingId] = { participants: new Set(), sdps: {}, iceCandidates: {} };
    const map = meetings[meetingId].iceCandidates;
    if (!map[fromUser]) map[fromUser] = [];
    map[fromUser].push(data.candidate);

    const payload = { type: 'ice_candidate', data: { meeting_id: meetingId, ice_map: meetings[meetingId].iceCandidates } };
    broadcastToMeeting(meetingId, null, payload);
    logger.info(`[ICE BROADCAST] from ${fromUser} in meeting ${meetingId}`);
    return;
  }

  throw new Error('either to or meeting_id required for ice_candidate');
}

/**
 * handleLeave
 */
function handleLeave(clientId, fromUser, meetingId) {
  if (!fromUser) throw new Error('not in meeting');
  if (!meetingId) throw new Error('meetingId required');
  removeUserFromMeeting(fromUser, meetingId);
  socketService.bindMeeting(clientId, null);
  sendToClient(clientId, { type: 'leave', data: { from: fromUser } });
}

/* -------------------------
   Helpers
   ------------------------- */

function handleClose(clientId) {
  const meta = socketService.getMeta(clientId) || {};
  logger.info(`[CLOSE] client ${clientId} disconnected meta: ${JSON.stringify(meta)}`);
  if (meta && meta.userId && meta.meetingId) {
    removeUserFromMeeting(meta.userId, meta.meetingId);
  }
  socketService.removeSocket(clientId);
}

function removeUserFromMeeting(userId, meetingId) {
  const meeting = meetings[meetingId];
  if (!meeting) return;
  meeting.participants.delete(userId);
  delete meeting.sdps[userId];
  delete meeting.iceCandidates[userId];

  broadcastToMeeting(meetingId, null, { type: 'participant_left', data: { from: userId } });

  const payload = { type: 'ice_candidate', data: { meeting_id: meetingId, ice_map: meeting.iceCandidates } };
  broadcastToMeeting(meetingId, null, payload);

  logger.info(`[REMOVE] ${userId} removed from meeting ${meetingId}`);
}

function sendToClient(clientId, payload) {
  const ws = socketService.getWsByClientId(clientId);
  if (!ws) {
    logger.warn(`[SEND FAIL] client ${clientId} socket not found`);
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
    logger.info(`[SEND] client ${clientId} <- ${payload.type}`);
  } catch (e) {
    logger.error('[SEND ERROR]', e && e.message ? e.message : e);
  }
}

function broadcastToMeeting(meetingId, excludeClientId, message) {
  const all = socketService.listClients();
  all.forEach((clientId) => {
    if (clientId === excludeClientId) return;
    const meta = socketService.getMeta(clientId);
    if (meta && meta.meetingId === meetingId) {
      sendToClient(clientId, message);
    }
  });
  logger.info(`[BROADCAST] meeting ${meetingId} -> ${message.type}`);
}

module.exports = setupWebSocketServer;
