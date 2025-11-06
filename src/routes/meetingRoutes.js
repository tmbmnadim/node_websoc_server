// routes/meetingRoutes.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const meetings = new Map(); // id -> { id, name, created_at }

router.post('/', (req, res) => {
  const name = req.body.name || `meeting-${Math.floor(Math.random() * 1000)}`;
  const id = uuidv4();
  const meeting = { id, name, created_at: new Date().toISOString() };
  meetings.set(id, meeting);
  res.json(meeting);
});

router.get('/', (req, res) => {
  res.json(Array.from(meetings.values()));
});

router.get('/:id', (req, res) => {
  const meeting = meetings.get(req.params.id);
  if (!meeting) return res.status(404).json({ message: 'not found' });
  res.json(meeting);
});

module.exports = router;
