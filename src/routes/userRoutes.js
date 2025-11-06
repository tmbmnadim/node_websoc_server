// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const users = new Map(); // id -> { id, name, is_online, created_at }

router.post('/', (req, res) => {
  const name = req.body.name || `user-${Math.floor(Math.random() * 1000)}`;
  const id = uuidv4();
  const user = { id, name, is_online: false, created_at: new Date().toISOString() };
  users.set(id, user);
  res.json(user);
});

router.get('/', (req, res) => {
  res.json(Array.from(users.values()));
});

router.get('/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ message: 'not found' });
  res.json(user);
});

module.exports = router;
