// services/socketService.js
const { v4: uuidv4 } = require('uuid');

/**
 * Minimal in-memory socket service
 * - addSocket(ws) -> clientId
 * - removeSocket(clientId)
 * - bindUser(clientId, userId)
 * - bindMeeting(clientId, meetingId) (nullable)
 * - getWsByClientId(clientId)
 * - getClientIdByUser(userId)
 * - getMeta(clientId) -> { userId, meetingId }
 * - listClients() -> [clientId]
 */

const clients = new Map(); // clientId -> ws
const metas = new Map(); // clientId -> { userId, meetingId }
const userToClient = new Map(); // userId -> clientId

function addSocket(ws) {
  const clientId = uuidv4();
  clients.set(clientId, ws);
  metas.set(clientId, { userId: null, meetingId: null });
  return clientId;
}

function removeSocket(clientId) {
  const m = metas.get(clientId);
  if (m && m.userId) {
    userToClient.delete(m.userId);
  }
  metas.delete(clientId);
  clients.delete(clientId);
}

function bindUser(clientId, userId) {
  const meta = metas.get(clientId) || {};
  meta.userId = userId;
  metas.set(clientId, meta);
  userToClient.set(userId, clientId);
}

function bindMeeting(clientId, meetingId) {
  const meta = metas.get(clientId) || {};
  meta.meetingId = meetingId;
  metas.set(clientId, meta);
}

function getWsByClientId(clientId) {
  return clients.get(clientId) || null;
}

function getClientIdByUser(userId) {
  return userToClient.get(userId) || null;
}

function getMeta(clientId) {
  return metas.get(clientId) || null;
}

function listClients() {
  return Array.from(clients.keys());
}

module.exports = {
  addSocket,
  removeSocket,
  bindUser,
  bindMeeting,
  getWsByClientId,
  getClientIdByUser,
  getMeta,
  listClients,
};
