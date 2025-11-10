// src/data/store.js
// simple in-memory store used by API routes
const users = new Map();     // userId -> userObject
const meetings = new Map();  // meetingId -> meetingObject (simple object)

module.exports = { users, meetings };
