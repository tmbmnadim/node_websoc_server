/**
 * userService: thin layer over the model.
 */
const userModel = require('../models/userModel');

module.exports = {
  createUser: (name) => userModel.create(name),
  listUsers: () => userModel.list(),
  getUser: (id) => userModel.get(id),
  deleteUser: (id) => userModel.delete(id),
};
