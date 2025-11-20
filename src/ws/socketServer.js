// server/src/ws/socketServer.js
const WebSocket = require('ws');
const logger = require('../utils/logger');
const socketService = require('../services/socketService');

const meetings = new Map();

function setupWebSocketServer(server, wsPath = '/ws') {
  const wss = new WebSocket.Server({ server, path: wsPath });

  logger.info('✅ WebSocket Server attached successfully');

  // ---------------- HEARTBEAT SETUP ----------------
  // Check connection health every 30 seconds
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false; // Mark as dead, wait for Pong to revive
      
      // Send Application-Level Ping
      // We use a try-catch because sending to a closing socket throws
      try {
        ws.send(JSON.stringify({ type: 'ping', data: {} }));
      } catch (e) {
        // Socket likely closed
      }
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));
  // ------------------------------------------------

  wss.on('connection', (ws, req) => {
    const clientId = socketService.addSocket(ws);
    const ip = req.socket.remoteAddress.replace('::ffff:', '');
    
    // Mark new connection as alive
    ws.isAlive = true;
    logger.info(`[CONN] New Client Connected | ID: ${clientId} | IP: ${ip}`);

    ws.on('message', (msg) => {
      // 💓 Heartbeat: Any message makes the socket "Alive"
      ws.isAlive = true;
      handleMessage(clientId, ws, msg);
    });

    ws.on('close', () => {
      handleDisconnect(clientId);
    });

    ws.on('error', (err) => {
      logger.error(`[ERR] Client: ${clientId}`, err.message);
    });
  });

  return wss;
}

function handleMessage(clientId, ws, rawMessage) {
  try {
    let msgString = rawMessage;
    if (typeof msgString !== 'string') msgString = msgString.toString();
    const parsed = JSON.parse(msgString);

    const { type, data } = parsed || {};

    // 💓 Handle Pong from Client
    if (type === 'pong') {
      // Just keep alive, no logging needed to avoid spam
      return; 
    }

    // Normal processing...
    const meta = socketService.getMeta(clientId) || {};
    const userId = meta.userId || 'Guest';
    
    logger.info(`📩 [${type.toUpperCase()}] from ${userId}`);

    switch (type) {
      case 'register': return handleRegister(clientId, data);
      case 'join_request': return handleJoinRequest(clientId, data);
      case 'offer': return handleOffer(clientId, data);
      case 'answer': return handleAnswer(clientId, data);
      case 'ice_candidate': return handleIceCandidate(clientId, data);
      case 'leave': return handleLeave(clientId, data);
      default: logger.warn(`⚠️ Unknown type: ${type}`);
    }
  } catch (err) {
    logger.error(`❌ Handle Error`, err);
  }
}

// ... [Keep the rest of your helper functions like handleRegister, handleOffer, etc.] ...
// (They remain exactly the same as the previous version)

/* =========================================
   EVENT HANDLERS (Copy these from previous code)
   ========================================= */
function handleRegister(clientId, data) {
    if (!data || !data.from) return;
    const userId = data.from;
    const name = data.name || 'Unknown';
    socketService.bindUser(clientId, userId);
    sendToClient(clientId, { type: 'registered', data: { id: userId, name, is_online: true } });
    logger.info(`👤 User Registered: ${name} (${userId})`);
}
// ... Include handleJoinRequest, handleOffer, handleAnswer, handleIceCandidate, handleLeave ...
// ... Include helper functions sendToClient, broadcastToMeeting ...

// Copy logic from the file I generated in the previous turn for these functions.
// I'm omitting them here to save space, but ensure they are present!

// --- Re-adding the essential helpers for context ---
function sendToClient(clientId, payload) {
  const ws = socketService.getWsByClientId(clientId);
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handleOffer(clientId, data) {
    if (!data.offers) return;
    data.offers.forEach((offer) => {
        const targetId = offer.to;
        const targetClient = socketService.getClientIdByUser(targetId);
        if (targetClient) sendToClient(targetClient, { type: 'offer', data: { offers: [offer] } });
    });
}
function handleAnswer(clientId, data) {
    if (!data.answers) return;
    data.answers.forEach((ans) => {
        const targetId = ans.to;
        const targetClient = socketService.getClientIdByUser(targetId);
        if (targetClient) sendToClient(targetClient, { type: 'answer', data: { answers: [ans] } });
    });
}
function handleIceCandidate(clientId, data) {
    if (!data.candidates) return;
    const targetId = data.to;
    const targetClient = socketService.getClientIdByUser(targetId);
    if (targetClient) sendToClient(targetClient, { type: 'ice_candidate', data });
}
function handleLeave(clientId, data) {
    // Logic to remove user from meeting
    const userId = data?.from;
    // ... (Use logic from previous code)
}
function handleDisconnect(clientId) {
    socketService.removeSocket(clientId);
}

module.exports = setupWebSocketServer;