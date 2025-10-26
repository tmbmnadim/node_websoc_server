/**
 * Handles WebSocket connections for WebRTC signaling.
 */
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const socketService = require('../services/socketService');

function setupWebSocketServer() {
  const wss = new WebSocketServer({ port: config.wsPort });
  

  wss.on('connection', (ws) => {
    const clientId = socketService.addSocket(ws);
    logger.info(`🟢 WebSocket connected: ${clientId}`);

    ws.on('message', (message) => {
      handleMessage(clientId, message);
    });

    ws.on('close', () => {
      logger.info(`🔴 WebSocket closed: ${clientId}`);
      socketService.removeSocket(clientId);
    });

    ws.on('error', (err) => {
      logger.error(`⚠️ WebSocket error for client ${clientId}:`, err);
    });
  });

  logger.info(`✅ WebSocket server started on port ${config.wsPort}`);
}

function handleMessage(clientId, message) {
  try {
    const msg = JSON.parse(message);
    const { type, data } = msg;

    const meta = socketService.getMeta(clientId) || {};
    const { userId, meetingId } = meta;

    switch (type) {
      case 'register':
        if (!data?.userId) throw new Error('userId is required for registration');
        socketService.bindUser(clientId, data.userId);
        logger.info(`Client ${clientId} registered as user ${data.userId}`);

        // Confirm registration
        socketService.getWsByClientId(clientId)?.send(
          JSON.stringify({ type: 'registered', data: { userId: data.userId } })
        );
        break;

      case 'join':
        if (!userId) throw new Error('Client must be registered to join a meeting');
        if (!data?.meetingId) throw new Error('meetingId is required to join');
        socketService.bindMeeting(clientId, data.meetingId);
        logger.info(`User ${userId} joined meeting ${data.meetingId}`);
        notifyMeetingParticipants(
          data.meetingId,
          clientId,
          { type: 'participant-joined', data: { userId } }
        );
        break;

      case 'leave':
        if (!userId) throw new Error('Client must be registered to leave a meeting');
        if (!meetingId) throw new Error('Client must be in a meeting to leave');
        logger.info(`User ${userId} left meeting ${meetingId}`);
        notifyMeetingParticipants(
          meetingId,
          clientId,
          { type: 'participant-left', data: { userId } }
        );
        socketService.bindMeeting(clientId, null);
        break;

      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice-candidate': {
        if (!userId || !meetingId)
          throw new Error('Client must be in a meeting for WebRTC signaling');
        if (!data?.targetUserId)
          throw new Error('targetUserId is required for WebRTC signaling');

        const targetClientId = socketService.getClientIdByUser(data.targetUserId);
        if (targetClientId) {
          const targetWs = socketService.getWsByClientId(targetClientId);
          targetWs?.send(
            JSON.stringify({
              type,
              data: { ...data, senderUserId: userId },
            })
          );
        }
        break;
      }

      case 'chat':
        if (!userId || !meetingId)
          throw new Error('Client must be in a meeting to chat');
        notifyMeetingParticipants(
          meetingId,
          clientId,
          {
            type: 'chat-message',
            data: {
              userId,
              message: data?.message || '',
              timestamp: new Date().toISOString(),
            },
          }
        );
        break;

      default:
        logger.warn(`Unknown message type received from ${clientId}: ${type}`);
        break;
    }
  } catch (err) {
    logger.error(`Error handling message from ${clientId}:`, err);
    socketService.getWsByClientId(clientId)?.send(
      JSON.stringify({ type: 'error', data: { message: err.message } })
    );
  }
}

function notifyMeetingParticipants(meetingId, excludeClientId, message) {
  const allClients = socketService.listClients();
  allClients.forEach((clientId) => {
    if (clientId !== excludeClientId) {
      const meta = socketService.getMeta(clientId);
      if (meta?.meetingId === meetingId) {
        const ws = socketService.getWsByClientId(clientId);
        ws?.send(JSON.stringify(message));
      }
    }
  });
}

module.exports = setupWebSocketServer;
