// src/routes/meetingRoutes.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { meetings } = require('../data/store');

const router = express.Router();

/**
 * Create meeting
 * POST /api/meetings
 * body: { title: "Meeting", host_id: "userId" }  (host_id optional)
 */
router.post('/', (req, res) => {
  const { title = 'Meeting', host_id = null } = req.body;
  const id = `m-${uuidv4()}`;
  const meeting = {
    id,
    title,
    host_id,
    created_at: new Date().toISOString(),
  };
  meetings.set(id, meeting);
  res.status(201).json(meeting);
});

/**
 * GET /api/meetings
 */
router.get('/', (req, res) => {
  return res.json(Array.from(meetings.values()));
});

module.exports = router;
