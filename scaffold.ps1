# Requires PowerShell 5 or higher
# Create directory structure with New-Item and -Force
$folders = "src/config", "src/controllers", "src/models", "src/routes", "src/services", "src/utils", "src/ws"
foreach ($folder in $folders) {
    New-Item -ItemType Directory -Path $folder -Force
}

# Create .env.example file with Set-Content and a here-string
Set-Content -Path ".env.example" -Value @"
PORT=3000
WS_PORT=8080
NODE_ENV=development
"@

# Create package.json file
Set-Content -Path "package.json" -Value @"
{
  "name": "webrtc-ws-server",
  "version": "1.0.0",
  "description": "Simple Node server with WebSocket signaling for WebRTC + user management (in-memory).",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js"
  },
  "author": "Generated",
  "license": "MIT",
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "uuid": "^9.0.0",
    "ws": "^8.13.0",
    "dotenv": "^16.0.3",
    "morgan": "^1.10.0"
  },
  "devDependencies": {
    "nodemon": "^2.0.22"
  }
}
"@

# Create README.md file
Set-Content -Path "README.md" -Value @"
# WebRTC Signaling + User Management Server

Features:
- HTTP API for users and meetings (in-memory store)
- WebSocket server (signaling for WebRTC: offer/answer/candidates, join/leave, chat)
- Simple, clean project structure

Install:
1. npm install
2. cp .env.example .env
3. npm start

WebSocket URL: ws://localhost:8080/ws
HTTP base: http://localhost:3000/api

See file headers for message formats.
"@

# Create src/server.js file
Set-Content -Path "src/server.js" -Value @"
/**
 * Entry point. Starts Express HTTP server and the WebSocket server.
 */
require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');
const logger = require('./utils/logger');
const userRoutes = require('./routes/userRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const startWebSocketServer = require('./ws/socketServer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Health
app.get('/', (req, res) => res.send({ status: 'ok', env: config.env }));

// API routes
app.use('/api/users', userRoutes);
app.use('/api/meetings', meetingRoutes);

const server = http.createServer(app);

server.listen(config.port, () => {
  logger.info(`HTTP server listening on ${config.port}`);
});

// start ws server (separate port)
startWebSocketServer();
"@

# Create src/config/index.js file
Set-Content -Path "src/config/index.js" -Value @"
/**
 * Basic configuration loader
 */
require('dotenv').config();
module.exports = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  wsPort: process.env.WS_PORT ? Number(process.env.WS_PORT) : 8080,
  env: process.env.NODE_ENV || 'development',
};
"@

# Create src/utils/logger.js file
Set-Content -Path "src/utils/logger.js" -Value @"
/**
 * Minimal logger wrapper (swap with pino/winston if desired)
 */
module.exports = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};
"@

# Create src/models/userModel.js file
Set-Content -Path "src/models/userModel.js" -Value @"
/**
 * Minimal in-memory user model.
 * For production swap with a DB (Mongo/Postgres).
 */
const { v4: uuidv4 } = require('uuid');

class UserModel {
  constructor() {
    this.users = new Map(); // id -> user
  }

  create(name) {
    const id = uuidv4();
    const user = { id, name, createdAt: new Date().toISOString() };
    this.users.set(id, user);
    return user;
  }

  list() {
    return Array.from(this.users.values());
  }

  get(id) {
    return this.users.get(id) || null;
  }

  delete(id) {
    return this.users.delete(id);
  }

  clear() {
    this.users.clear();
  }
}

module.exports = new UserModel();
"@

# Create src/services/userService.js file
Set-Content -Path "src/services/userService.js" -Value @"
/**
 * userService: thin layer over the model.
 */
const userModel = require('../models/userModel');

module.exports = {
  createUser: (name) => userModel.create(name),
  listUsers: () => userModel.list(),
  getUser: (id) => userModel.get(id),
  deleteUser: (id) => userModel.delete(id),
};
"@

# Create src/services/callService.js file
Set-Content -Path "src/services/callService.js" -Value @"
/**
 * callService: very small in-memory meeting store.
 * Meeting contains: meetingId, hostUserId, participantIds[], type, startedAt, endedAt|null
 */
const { v4: uuidv4 } = require('uuid');

class CallService {
  constructor() {
    this.meetings = new Map();
  }

  createMeeting({ hostUserId, participantIds = [], type = 'conference' }) {
    const meetingId = uuidv4();
    const meeting = {
      meetingId,
      hostUserId,
      participantIds: Array.from(new Set([...(participantIds || []), hostUserId].filter(Boolean))),
      type,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.meetings.set(meetingId, meeting);
    return meeting;
  }

  getMeeting(meetingId) {
    return this.meetings.get(meetingId) || null;
  }

  endMeeting(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.endedAt = new Date().toISOString();
    this.meetings.set(meetingId, m);
    return m;
  }

  listMeetings() {
    return Array.from(this.meetings.values());
  }
}

module.exports = new CallService();
"@

# Create src/services/socketService.js file
Set-Content -Path "src/services/socketService.js" -Value @"
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
"@

# Create src/controllers/userController.js file
Set-Content -Path "src/controllers/userController.js" -Value @"
const userService = require('../services/userService');

exports.create = (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ message: 'name is required' });
  }
  const user = userService.createUser(name);
  return res.status(201).json(user);
};

exports.list = (req, res) => {
  const users = userService.listUsers();
  return res.json(users);
};

exports.get = (req, res) => {
  const { id } = req.params;
  const user = userService.getUser(id);
  if (!user) return res.status(404).json({ message: 'Not found' });
  return res.json(user);
};

exports.delete = (req, res) => {
  const { id } = req.params;
  const ok = userService.deleteUser(id);
  if (!ok) return res.status(404).json({ message: 'Not found' });
  return res.status(204).send();
};
"@

# Create src/controllers/meetingController.js file
Set-Content -Path "src/controllers/meetingController.js" -Value @"
const callService = require('../services/callService');

exports.create = (req, res) => {
  const { hostUserId, participantIds, type } = req.body;
  if (!hostUserId) return res.status(400).json({ message: 'hostUserId required' });
  const meeting = callService.createMeeting({ hostUserId, participantIds, type });
  return res.status(201).json(meeting);
};

exports.get = (req, res) => {
  const { meetingId } = req.params;
  const meeting = callService.getMeeting(meetingId);
  if (!meeting) return res.status(404).json({ message: 'Not found' });
  return res.json(meeting);
};

exports.end = (req, res) => {
  const { meetingId } = req.params;
  const meeting = callService.endMeeting(meetingId);
  if (!meeting) return res.status(404).json({ message: 'Not found' });
  return res.json(meeting);
};

exports.list = (req, res) => {
  const meetings = callService.listMeetings();
  return res.json(meetings);
};
"@

# Create src/routes/userRoutes.js file
Set-Content -Path "src/routes/userRoutes.js" -Value @"
const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.post('/', userController.create);
router.get('/', userController.list);
router.get('/:id', userController.get);
router.delete('/:id', userController.delete);

module.exports = router;
"@

# Create src/routes/meetingRoutes.js file
Set-Content -Path "src/routes/meetingRoutes.js" -Value @"
const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');

router.post('/', meetingController.create);
router.get('/', meetingController.list);
router.get('/:meetingId', meetingController.get);
router.put('/:meetingId/end', meetingController.end);

module.exports = router;
"@

# Create src/ws/socketServer.js file
Set-Content -Path "src/ws/socketServer.js" -Value @"
/**
 * Handles WebSockets connections for WebRTC signaling.
 */
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const socketService = require('../services/socketService');

function setupWebSocketServer() {
  const wss = new WebSocketServer({ port: config.wsPort });

  wss.on('connection', (ws) => {
    const clientId = socketService.addSocket(ws);
    logger.info(`New client connected: ${clientId}`);

    ws.on('message', (message) => {
      handleMessage(clientId, message);
    });

    ws.on('close', () => {
      logger.warn(`Client disconnected: ${clientId}`);
      socketService.removeSocket(clientId);
    });

    ws.on('error', (err) => {
      logger.error(`WebSocket error for client ${clientId}:`, err);
    });
  });

  logger.info(`WebSocket server started on port ${config.wsPort}`);
}

function handleMessage(clientId, message) {
  try {
    const msg = JSON.parse(message);
    const { type, data } = msg;

    const meta = socketService.getMeta(clientId) || {};
    const { userId, meetingId } = meta;

    switch (type) {
      case 'register':
        if (!data.userId) throw new Error('userId is required for registration');
        socketService.bindUser(clientId, data.userId);
        logger.info(`Client ${clientId} registered as user ${data.userId}`);
        // Optionally send a confirmation back
        socketService.getWsByClientId(clientId).send(JSON.stringify({
          type: 'registered',
          data: { userId: data.userId }
        }));
        break;

      case 'join':
        if (!userId) throw new Error('Client must be registered to join a meeting');
        if (!data.meetingId) throw new Error('meetingId is required to join');
        socketService.bindMeeting(clientId, data.meetingId);
        logger.info(`User ${userId} joined meeting ${data.meetingId}`);
        // Notify other participants in the meeting
        notifyMeetingParticipants(meetingId, clientId, { type: 'participant-joined', data: { userId } });
        break;

      case 'leave':
        if (!userId) throw new Error('Client must be registered to leave a meeting');
        if (!meetingId) throw new Error('Client must be in a meeting to leave');
        logger.info(`User ${userId} left meeting ${meetingId}`);
        notifyMeetingParticipants(meetingId, clientId, { type: 'participant-left', data: { userId } });
        socketService.bindMeeting(clientId, null);
        break;

      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice-candidate':
        if (!userId || !meetingId) throw new Error('Client must be in a meeting for WebRTC signaling');
        if (!data.targetUserId) throw new Error('targetUserId is required for WebRTC signaling');
        const targetClientId = socketService.getClientIdByUser(data.targetUserId);
        if (targetClientId) {
          const targetWs = socketService.getWsByClientId(targetClientId);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type,
              data: { ...data, senderUserId: userId },
            }));
          }
        }
        break;

      case 'chat':
        if (!userId || !meetingId) throw new Error('Client must be in a meeting to chat');
        notifyMeetingParticipants(meetingId, clientId, { type: 'chat-message', data: { userId, message: data.message, timestamp: new Date().toISOString() } });
        break;

      default:
        logger.warn(`Unknown message type received from ${clientId}: ${type}`);
        break;
    }
  } catch (err) {
    logger.error(`Error handling message from ${clientId}:`, err);
    // Optionally send an error message back to the client
    if (socketService.getWsByClientId(clientId)) {
      socketService.getWsByClientId(clientId).send(JSON.stringify({ type: 'error', data: { message: err.message } }));
    }
  }
}

function notifyMeetingParticipants(meetingId, excludeClientId, message) {
  const allClients = socketService.listClients();
  allClients.forEach(clientId => {
    if (clientId !== excludeClientId) {
      const meta = socketService.getMeta(clientId);
      if (meta && meta.meetingId === meetingId) {
        const ws = socketService.getWsByClientId(clientId);
        if (ws) {
          ws.send(JSON.stringify(message));
        }
      }
    }
  });
}

module.exports = setupWebSocketServer;
"@