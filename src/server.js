// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');

const userRoutes = require('./routes/userRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const setupWebSocketServer = require('./ws/socketServer');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send(`
    <h2>🚀 WebRTC Signaling Server</h2>
    <p>HTTP API base: <code>http://0.0.0.0:${config.httpPort}/api</code></p>
    <p>WebSocket path: <code>${config.wsPath}</code></p>
  `);
});

app.use('/api/users', userRoutes);
app.use('/api/meetings', meetingRoutes);
app.get('/api', (req, res) => res.json({ message: 'WebSocket signaling API up' }));

const server = http.createServer(app);

// attach websocket server to same HTTP server at config.wsPath
setupWebSocketServer(server);

// listen on all interfaces
server.listen(config.httpPort, '0.0.0.0', () => {
  logger.info(`HTTP server listening on http://0.0.0.0:${config.httpPort}`);
  logger.info(`WebSocket path: ws://0.0.0.0:${config.httpPort}${config.wsPath}`);
});
