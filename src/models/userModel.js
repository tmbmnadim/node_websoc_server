/**
 * Minimal in-memory user model.
 * For production swap with a DB (Mongo/Postgres).
 */
const { v4: uuidv4 } = require('uuid');

class UserModel {
  constructor() {
    this.users = new Map(); // id -> user
  }

  create(name) {
    const id = uuidv4();
    const user = { id, name, createdAt: new Date().toISOString() };
    this.users.set(id, user);
    return user;
  }

  list() {
    return Array.from(this.users.values());
  }

  get(id) {
    return this.users.get(id) || null;
  }

  delete(id) {
    return this.users.delete(id);
  }

  clear() {
    this.users.clear();
  }
}

module.exports = new UserModel();
