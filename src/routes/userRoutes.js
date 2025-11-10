// src/routes/userRoutes.js
const express = require('express');
const { LiveUser } = require('../models/userModel');
const { users } = require('../data/store');

const router = express.Router();

/**
 * Create user
 * POST /api/users
 * body: { name: "Nadim" }
 */
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });

  const user = new LiveUser({ name });
  users.set(user.id, user.toJSON());
  return res.status(201).json(user.toJSON());
});

/**
 * GET /api/users
 */
router.get('/', (req, res) => {
  return res.json(Array.from(users.values()));
});

module.exports = router;
