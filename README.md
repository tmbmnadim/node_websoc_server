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
