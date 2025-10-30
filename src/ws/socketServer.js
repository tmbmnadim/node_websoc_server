/**
 * Enhanced WebSocket Signaling Server for WebRTC
 * Supports:
 *  - Meetings (multi-user)
 *  - Direct calls (targetUserId)
 *  - ICE + SDP synchronization
 *  - Detailed logging and error tracing
 */

const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const socketService = require('../services/socketService');

// meetingId -> { participants:Set, iceCandidates:{}, sdps:{} }
const meetings = {};

// direct calls -> { key: { [userId]: [candidates] } }
const directIce = {};

/**
 * Initialize WebSocket server
 */
function setupWebSocketServer(server) {
  // Bind WS to existing HTTP server
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const clientId = socketService.addSocket(ws);
    logger.info(`🟢 [CONNECT] WS connected: ${clientId}`);

    ws.on('message', (message) => handleMessage(clientId, message));

    ws.on('close', () => {
      const meta = socketService.getMeta(clientId);
      logger.info(`🔴 [CLOSE] Client ${clientId} disconnected: ${JSON.stringify(meta)}`);
      if (meta && meta.meetingId && meta.userId) {
        removeUserFromMeeting(meta.userId, meta.meetingId);
      }
      socketService.removeSocket(clientId);
    });

    ws.on('error', (err) => {
      logger.error(`❌ [ERROR] WebSocket error on ${clientId}: ${err.message}`);
    });
  });

  logger.info(`🚀 WebSocket server attached to HTTP server at path /ws`);
}


/**
 * Handle all incoming WebSocket messages
 */
function handleMessage(clientId, message) {
  try {
    const msg = JSON.parse(message);
    const { type, data } = msg;
    const meta = socketService.getMeta(clientId) || {};
    const { userId, meetingId } = meta;

    logger.info(
      `📩 [MESSAGE RECEIVED]
Type: ${type}
From: ${userId || clientId}
Meeting: ${meetingId || 'none'}
Payload: ${JSON.stringify(data, null, 2)}`
    );

    switch (type) {
      case 'register':
        return handleRegister(clientId, data);

      case 'join':
        return handleJoin(userId, clientId, data);

      case 'leave':
        return handleLeave(userId, meetingId, clientId);

      case 'webrtc-ice-candidate':
        return handleIceCandidate(userId, meetingId, data, clientId);

      case 'webrtc-offer':
      case 'webrtc-answer':
        return handleSdpMessage(type, userId, meetingId, data, clientId);

      default:
        logger.warn(`⚠️ [UNKNOWN TYPE] ${type}`);
        sendToClient(clientId, {
          type: 'error',
          data: { message: `Unknown type: ${type}` },
        });
    }
  } catch (err) {
    logger.error(`💥 [HANDLE MESSAGE ERROR] ${err.stack}`);
    sendToClient(clientId, { type: 'error', data: { message: err.message } });
  }
}

/**
 * REGISTER a user
 */
function handleRegister(clientId, data) {
  if (!data.userId) throw new Error('userId required');
  socketService.bindUser(clientId, data.userId);
  logger.info(`✅ [REGISTER] Client ${clientId} -> userId ${data.userId}`);

  sendToClient(clientId, {
    type: 'registered',
    data: { userId: data.userId },
  });
}

/**
 * JOIN meeting
 */
function handleJoin(userId, clientId, data) {
  if (!userId) throw new Error('Must register first');
  if (!data.meetingId) throw new Error('meetingId required');

  const { meetingId } = data;
  socketService.bindMeeting(clientId, meetingId);

  if (!meetings[meetingId]) {
    meetings[meetingId] = { participants: new Set(), iceCandidates: {}, sdps: {} };
  }

  meetings[meetingId].participants.add(userId);
  logger.info(`👥 [JOIN] ${userId} joined meeting ${meetingId}`);

  // Notify others
  broadcastToMeeting(meetingId, null, {
    type: 'participant-joined',
    data: { userId, meetingId },
  });

  // Send meeting state
  sendToClient(clientId, {
    type: 'meeting-state',
    data: {
      meetingId,
      participants: Array.from(meetings[meetingId].participants),
      iceMap: meetings[meetingId].iceCandidates,
      sdpMap: meetings[meetingId].sdps,
    },
  });

  broadcastIceMap(meetingId);
}

/**
 * LEAVE meeting
 */
function handleLeave(userId, meetingId, clientId) {
  if (!userId || !meetingId) throw new Error('Not in a meeting');
  removeUserFromMeeting(userId, meetingId);
  socketService.bindMeeting(clientId, null);
  logger.info(`🚪 [LEAVE] ${userId} left meeting ${meetingId}`);
}

/**
 * Handle WebRTC ICE Candidate (supports both meeting + direct)
 */
function handleIceCandidate(userId, meetingId, data, clientId) {
  logger.info(`[ICE] Handling ICE candidate from ${userId}`);

  if (!userId) throw new Error('Must be registered first');
  if (!data.candidate) throw new Error('Candidate data required');

  const { targetUserId } = data;

  // 🎯 Direct 1:1 call
  if (targetUserId) {
    const targetClientId = socketService.getClientIdByUser(targetUserId);
    const targetMeta = targetClientId ? socketService.getMeta(targetClientId) : null;

    if (!targetClientId || !targetMeta) {
      sendToClient(clientId, { type: 'error', data: { message: 'Target not online' } });
      return;
    }

    const key = [userId, targetUserId].sort().join('-');
    if (!directIce[key]) directIce[key] = {};
    if (!directIce[key][userId]) directIce[key][userId] = [];
    directIce[key][userId].push(data.candidate);

    sendToClient(targetClientId, {
      type: 'webrtc-ice-candidate',
      data: { fromId: userId, candidate: data.candidate },
    });

    logger.info(`❄️ [DIRECT ICE] Forwarded ICE from ${userId} → ${targetUserId}`);
    return;
  }

  // 👥 Meeting ICE
  if (meetingId) {
    addIceCandidate(userId, meetingId, data.candidate);
    broadcastIceMap(meetingId);
    return;
  }

  throw new Error('Either targetUserId or meetingId must be provided for ICE candidate');
}

/**
 * Handle WebRTC Offer/Answer
 */
function handleSdpMessage(type, userId, meetingId, data, clientId) {
  const { targetUserId, sdp, sdpType } = data;
  if (!sdp || !sdpType) throw new Error('Both sdp and sdpType are required');

  // 🎯 Direct target (1:1 call)
  if (targetUserId) {
    const targetClientId = socketService.getClientIdByUser(targetUserId);
    const targetMeta = targetClientId ? socketService.getMeta(targetClientId) : null;

    if (!targetClientId || !targetMeta) {
      sendToClient(clientId, { type: 'error', data: { message: 'Target not online' } });
      return;
    }

    if (targetMeta.meetingId && targetMeta.meetingId !== meetingId) {
      sendToClient(clientId, { type: 'error', data: { message: 'User is busy' } });
      return;
    }

    const payload = {
      type,
      data: { fromId: userId, sdp, sdpType },
    };

    sendToClient(targetClientId, payload);
    logger.info(`📤 [SDP] ${type} forwarded from ${userId} → ${targetUserId}`);
    return;
  }

  // 👥 Meeting-based broadcast
  if (meetingId) {
    if (!meetings[meetingId]) return;

    meetings[meetingId].sdps[userId] = { sdp, sdpType };

    const payload = {
      type,
      data: { userId, sdp, sdpType },
    };

    broadcastToMeeting(meetingId, clientId, payload);
    logger.info(`📡 [SDP BROADCAST] ${type} for meeting ${meetingId}`);
    return;
  }

  throw new Error('Either targetUserId or meetingId must be provided for SDP message');
}

/**
 * Add ICE candidate to a meeting
 */
function addIceCandidate(userId, meetingId, candidate) {
  if (!meetings[meetingId]) return;
  const iceMap = meetings[meetingId].iceCandidates;
  if (!iceMap[userId]) iceMap[userId] = [];
  iceMap[userId].push(candidate);
  logger.info(`🧊 [ICE ADD] Added for ${userId} in meeting ${meetingId}`);
}

/**
 * Broadcast ICE map to all meeting participants
 */
function broadcastIceMap(meetingId) {
  const meeting = meetings[meetingId];
  if (!meeting) return;

  const payload = {
    type: 'ice-sync',
    data: { meetingId, iceMap: meeting.iceCandidates },
  };

  broadcastToMeeting(meetingId, null, payload);
  logger.info(`📡 [ICE BROADCAST] for meeting ${meetingId}`);
}

/**
 * Remove user from meeting
 */
function removeUserFromMeeting(userId, meetingId) {
  const meeting = meetings[meetingId];
  if (!meeting) return;

  meeting.participants.delete(userId);
  delete meeting.iceCandidates[userId];
  delete meeting.sdps[userId];

  broadcastToMeeting(meetingId, null, {
    type: 'participant-left',
    data: { userId },
  });

  broadcastIceMap(meetingId);
  logger.info(`👋 [REMOVE] User ${userId} left meeting ${meetingId}`);
}

/**
 * Send message to specific client
 */
function sendToClient(clientId, payload) {
  const ws = socketService.getWsByClientId(clientId);
  if (ws) {
    ws.send(JSON.stringify(payload));
  } else {
    logger.warn(`[SEND FAIL] Client ${clientId} socket not found`);
  }
}

/**
 * Broadcast message to all meeting participants
 */
function broadcastToMeeting(meetingId, excludeClientId, message) {
  const allClients = socketService.listClients();
  allClients.forEach((clientId) => {
    if (clientId === excludeClientId) return;
    const meta = socketService.getMeta(clientId);
    if (meta && meta.meetingId === meetingId) {
      const ws = socketService.getWsByClientId(clientId);
      if (ws) ws.send(JSON.stringify(message));
    }
  });
  logger.info(`📣 [BROADCAST] to meeting ${meetingId}`);
}

module.exports = setupWebSocketServer;
