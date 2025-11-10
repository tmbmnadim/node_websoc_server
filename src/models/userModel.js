// src/models/userModel.js
const { v4: uuidv4 } = require('uuid');

class LiveUser {
  constructor({ id = null, name, isOnline = false, createdAt = null }) {
    this.id = id || uuidv4();
    this.name = name;
    this.is_online = isOnline;
    this.created_at = createdAt ? (new Date(createdAt)).toISOString() : new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      is_online: this.is_online,
      created_at: this.created_at,
    };
  }
}

module.exports = { LiveUser };
