/**
 * socketService: keep track of connected WebSocket clients and mapping to users.
 * - sockets: Map(clientId -> ws)
 * - userToSocket: Map(userId -> clientId)
 * - socketMeta: Map(clientId -> { userId, meetingId })
 *
 * We use 'clientId' (uuid) for each ws connection.
 */
const { v4: uuidv4 } = require('uuid');

class SocketService {
  constructor() {
    this.sockets = new Map();
    this.userToClient = new Map();
    this.meta = new Map();
  }

  addSocket(ws) {
    const clientId = uuidv4();
    this.sockets.set(clientId, ws);
    return clientId;
  }

  removeSocket(clientId) {
    const ws = this.sockets.get(clientId);
    if (ws) ws.terminate && ws.terminate();
    this.sockets.delete(clientId);
    const meta = this.meta.get(clientId);
    if (meta && meta.userId) this.userToClient.delete(meta.userId);
    this.meta.delete(clientId);
  }

  bindUser(clientId, userId) {
    this.userToClient.set(userId, clientId);
    const m = this.meta.get(clientId) || {};
    m.userId = userId;
    this.meta.set(clientId, m);
  }

  bindMeeting(clientId, meetingId) {
    const m = this.meta.get(clientId) || {};
    m.meetingId = meetingId;
    this.meta.set(clientId, m);
  }

  setMeta(clientId, meta) {
    this.meta.set(clientId, meta);
  }

  getWsByClientId(clientId) {
    return this.sockets.get(clientId) || null;
  }

  getClientIdByUser(userId) {
    return this.userToClient.get(userId) || null;
  }

  getMeta(clientId) {
    return this.meta.get(clientId) || null;
  }

  listClients() {
    return Array.from(this.sockets.keys());
  }
}

module.exports = new SocketService();
