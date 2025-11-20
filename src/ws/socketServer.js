// server/src/ws/socketServer.js
const WebSocket = require('ws');
const logger = require('../utils/logger');
const socketService = require('../services/socketService');

/* =========================================
   STATE MANAGEMENT
   ========================================= */
// Stores active meeting participants.
// Structure: meetingId -> { participants: Set<userId> }
// Note: SDPs and ICE Candidates are NOT stored here; they are routed P2P.
const meetings = new Map();

/**
 * Sets up the WebSocket server.
 * @param {http.Server} server - The HTTP server instance.
 * @param {string} wsPath - The path to listen on (e.g., '/ws').
 */
function setupWebSocketServer(server, wsPath = '/ws') {
  const wss = new WebSocket.Server({ server, path: wsPath });

  logger.info('✅ WebSocket Server attached successfully');

  wss.on('connection', (ws, req) => {
    // 1. Register new socket connection
    const clientId = socketService.addSocket(ws);
    const ip = req.socket.remoteAddress.replace('::ffff:', '');
    logger.info(`[CONN] New Client Connected | ID: ${clientId} | IP: ${ip}`);

    // 2. Handle incoming messages
    ws.on('message', (msg) => {
      handleMessage(clientId, msg);
    });

    // 3. Handle disconnection
    ws.on('close', () => {
      handleDisconnect(clientId);
    });

    // 4. Handle errors
    ws.on('error', (err) => {
      logger.error(`[ERR] Socket Error (Client: ${clientId})`, err.message);
    });
  });

  return wss;
}

/* =========================================
   MESSAGE HANDLING LOGIC
   ========================================= */

function handleMessage(clientId, rawMessage) {
  try {
    // Parse message
    let msgString = rawMessage;
    if (typeof msgString !== 'string') msgString = msgString.toString();
    const parsed = JSON.parse(msgString);

    const { type, data } = parsed || {};
    const meta = socketService.getMeta(clientId) || {};
    const userId = meta.userId || 'Guest';

    // Log the message (Truncated for readability)
    logger.info(`📩 [${type.toUpperCase()}] from ${userId} | Data: ${JSON.stringify(getLoggablePayload(data))}`);

    // Route based on message type
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
        logger.warn(`⚠️  Unknown message type received: ${type}`);
    }
  } catch (err) {
    logger.error(`❌ Error handling message from ${clientId}`, err);
  }
}

/* =========================================
   EVENT HANDLERS
   ========================================= */

/**
 * ASSOCIATE SOCKET WITH USER ID
 */
function handleRegister(clientId, data) {
  if (!data || !data.from) return;
  const userId = data.from;
  const name = data.name || 'Unknown';

  socketService.bindUser(clientId, userId);

  // Acknowledge registration
  sendToClient(clientId, {
    type: 'registered',
    data: { id: userId, name, is_online: true },
  });
  logger.info(`👤 User Registered: ${name} (${userId})`);
}

/**
 * HANDLE MEETING JOIN REQUEST
 */
function handleJoinRequest(clientId, data) {
  if (!data || !data.from || !data.meeting_id) return;
  const userId = data.from;
  const meetingId = data.meeting_id;

  // 1. Bind socket to meeting
  socketService.bindMeeting(clientId, meetingId);

  // 2. Initialize meeting if it doesn't exist
  if (!meetings.has(meetingId)) {
    meetings.set(meetingId, { participants: new Set() });
    logger.info(`🆕 New Meeting Created: ${meetingId}`);
  }
  const meeting = meetings.get(meetingId);

  // 3. Get list of EXISTING participants (excluding self)
  const existingParticipants = Array.from(meeting.participants).filter((id) => id !== userId);

  // 4. Add new user to the list
  meeting.participants.add(userId);

  // 5. Send existing participants list to the NEW user
  sendToClient(clientId, {
    type: 'participants',
    data: { participants: existingParticipants },
  });

  // 6. Broadcast to OTHERS that a new user joined
  broadcastToMeeting(meetingId, clientId, {
    type: 'participant_joined',
    data: { userId, meetingId },
  });

  logger.info(`🤝 [JOIN] ${userId} joined meeting ${meetingId}. (Total: ${meeting.participants.size})`);
}

/**
 * FORWARD WEBRTC OFFERS
 * Expects data.offers = [ { to: "targetId", ... }, ... ]
 */
function handleOffer(clientId, data) {
  if (!data || !data.offers || !Array.isArray(data.offers)) return;

  data.offers.forEach((offer) => {
    const targetId = offer.to;
    const targetClientId = socketService.getClientIdByUser(targetId);

    if (targetClientId) {
      // Forward offer directly to target
      sendToClient(targetClientId, {
        type: 'offer',
        data: { offers: [offer] },
      });
      logger.info(`👉 [OFFER] Forwarded: ${offer.from} -> ${targetId}`);
    } else {
      logger.warn(`⚠️ [OFFER] Target Offline: ${targetId}`);
    }
  });
}

/**
 * FORWARD WEBRTC ANSWERS
 * Expects data.answers = [ { to: "targetId", ... }, ... ]
 */
function handleAnswer(clientId, data) {
  if (!data || !data.answers || !Array.isArray(data.answers)) return;

  data.answers.forEach((ans) => {
    const targetId = ans.to;
    const targetClientId = socketService.getClientIdByUser(targetId);

    if (targetClientId) {
      sendToClient(targetClientId, {
        type: 'answer',
        data: { answers: [ans] },
      });
      logger.info(`👈 [ANSWER] Forwarded: ${ans.from} -> ${targetId}`);
    } else {
      logger.warn(`⚠️ [ANSWER] Target Offline: ${targetId}`);
    }
  });
}

/**
 * FORWARD ICE CANDIDATES
 * Expects data = { to: "targetId", candidates: [...] }
 */
function handleIceCandidate(clientId, data) {
  if (!data || !data.to || !data.candidates) return;

  const targetId = data.to;
  const targetClientId = socketService.getClientIdByUser(targetId);
  const candidateCount = data.candidates.length;

  if (targetClientId) {
    sendToClient(targetClientId, {
      type: 'ice_candidate',
      data: {
        from: data.from,
        to: targetId,
        candidates: data.candidates,
      },
    });
    // We don't log the full candidate string, just the count
    logger.info(`❄️ [ICE] Forwarded ${candidateCount} candidates: ${data.from} -> ${targetId}`);
  } else {
    logger.warn(`⚠️ [ICE] Target Offline: ${targetId}`);
  }
}

/**
 * HANDLE DISCONNECT / LEAVE
 */
function handleLeave(clientId, data) {
  const userId = data?.from;
  const meta = socketService.getMeta(clientId);
  const meetingId = data?.meeting_id || (meta ? meta.meetingId : null);

  if (userId && meetingId) {
    removeUserFromMeeting(userId, meetingId);
  }
}

function handleDisconnect(clientId) {
  const meta = socketService.getMeta(clientId);
  if (meta) {
    const { userId, meetingId } = meta;
    logger.info(`🔌 [DISCONNECT] Client: ${clientId} (User: ${userId || 'None'})`);

    if (userId && meetingId) {
      removeUserFromMeeting(userId, meetingId);
    }
  }
  socketService.removeSocket(clientId);
}

/* =========================================
   HELPER FUNCTIONS
   ========================================= */

/**
 * Removes a user from a meeting and notifies others.
 */
function removeUserFromMeeting(userId, meetingId) {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;

  meeting.participants.delete(userId);

  // Notify remaining participants
  broadcastToMeeting(meetingId, null, {
    type: 'participant_left',
    data: { from: userId },
  });

  logger.info(`👋 [LEAVE] ${userId} left meeting ${meetingId}.`);

  // Cleanup empty meetings
  if (meeting.participants.size === 0) {
    meetings.delete(meetingId);
    logger.info(`🗑️ Meeting ${meetingId} is empty and has been removed.`);
  }
}

/**
 * Broadcasts a message to all participants in a meeting (except sender).
 */
function broadcastToMeeting(meetingId, excludeClientId, payload) {
  const clients = socketService.listClients();
  for (const clientId of clients) {
    if (clientId === excludeClientId) continue;
    
    const meta = socketService.getMeta(clientId);
    if (meta && meta.meetingId === meetingId) {
      sendToClient(clientId, payload);
    }
  }
}

/**
 * Sends a JSON payload to a specific client.
 */
function sendToClient(clientId, payload) {
  const ws = socketService.getWsByClientId(clientId);
  if (!ws) return;

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (err) {
    logger.error('[SEND ERROR]', err);
  }
}

/**
 * Creates a truncated version of the data object for clean logging.
 * Hides massive SDP strings and Candidate lists.
 */
function getLoggablePayload(data) {
  if (!data) return null;
  const clone = { ...data }; // Shallow copy

  // 1. Truncate SDPs in Offer/Answer Arrays
  if (clone.offers && Array.isArray(clone.offers)) {
    clone.offers = clone.offers.map(o => ({
      ...o,
      sdpDetails: o.sdpDetails ? { ...o.sdpDetails, sdp: truncateString(o.sdpDetails.sdp) } : 'N/A'
    }));
  }
  if (clone.answers && Array.isArray(clone.answers)) {
    clone.answers = clone.answers.map(a => ({
      ...a,
      sdpDetails: a.sdpDetails ? { ...a.sdpDetails, sdp: truncateString(a.sdpDetails.sdp) } : 'N/A'
    }));
  }

  // 2. Truncate Candidates
  if (clone.candidates && Array.isArray(clone.candidates)) {
    // Instead of printing the array, print the count
    clone.candidates = `[Array of ${clone.candidates.length} candidate bundles]`;
  }

  return clone;
}

/**
 * Returns a shortened string (e.g. "v=0\r\no=... [truncated]")
 */
function truncateString(str, maxLength = 50) {
  if (!str) return 'null';
  if (str.length <= maxLength) return str;
  return `${str.substring(0, maxLength)}... (len:${str.length})`;
}

module.exports = setupWebSocketServer;