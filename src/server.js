// server/src/server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');

// Import Routes
const userRoutes = require('./routes/userRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const setupWebSocketServer = require('./ws/socketServer');

const app = express();

/* =========================================
   1. MIDDLEWARE SETUP
   ========================================= */
// Allow all Cross-Origin requests (Essential for development/ngrok)
app.use(cors());
// Parse JSON bodies (as sent by API clients)
app.use(express.json());

/* =========================================
   2. API ROUTE DEFINITIONS
   ========================================= */
// Basic Welcome Route (Check if server is reachable)
app.get('/', (req, res) => {
  res.send(`
    <div style="font-family: monospace; padding: 20px;">
      <h2>🚀 WebRTC Signaling Server Running</h2>
      <p><strong>HTTP API:</strong> http://0.0.0.0:${config.httpPort}/api</p>
      <p><strong>WebSocket:</strong> ${config.wsPath}</p>
      <p><em>Status: Online and ready for connections.</em></p>
    </div>
  `);
});

// Mount resource routes
app.use('/api/users', userRoutes);
app.use('/api/meetings', meetingRoutes);

// Simple Health Check Endpoint
app.get('/api', (req, res) => res.json({ message: 'Signaling API is healthy' }));

/* =========================================
   3. SERVER INITIALIZATION
   ========================================= */
const server = http.createServer(app);

// Attach the WebSocket Server to the HTTP server
// This allows both HTTP and WS traffic on the same port
setupWebSocketServer(server, config.wsPath);

// Start listening
server.listen(config.httpPort, '0.0.0.0', () => {
  logger.info(`---------------------------------------------------`);
  logger.info(`🚀 HTTP Server listening on http://0.0.0.0:${config.httpPort}`);
  logger.info(`📡 WebSocket endpoint at ws://0.0.0.0:${config.httpPort}${config.wsPath}`);
  logger.info(`---------------------------------------------------`);
});