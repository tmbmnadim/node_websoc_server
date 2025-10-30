const express = require('express');
const http = require('http');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');

// Import routes
const userRoutes = require('./routes/userRoutes');
const meetingRoutes = require('./routes/meetingRoutes');

// Import WebSocket setup
const setupWebSocketServer = require('./ws/socketServer');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send(`
    <h2>🚀 WebRTC WebSocket Server</h2>
    <p>HTTP API base: <code>http://localhost:${config.httpPort}/api</code></p>
    <p>WebSocket URL: <code>ws://localhost:${config.wsPort}/ws</code></p>
  `);
});

// Base API routes
app.use('/api/users', userRoutes);
app.use('/api/meetings', meetingRoutes);

// Root endpoint (optional)
app.get('/api', (req, res) => {
  res.json({ message: '✅ WebRTC WebSocket API is running' });
});

// Create the HTTP server
const server = http.createServer(app);

// Start WebSocket server separately
setupWebSocketServer(server); // Starts ws://localhost:8080/ws

// Start HTTP API server
server.listen(config.httpPort, '10.10.10.29', () => {
  logger.info(`HTTP API server running on http://0.0.0.0:${config.httpPort}`);
  logger.info(`WebSocket server running on ws://0.0.0.0:${config.wsPort}/ws`);
});
