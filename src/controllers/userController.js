const userService = require('../services/userService');

exports.create = (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ message: 'name is required' });
  }
  const user = userService.createUser(name);
  return res.status(201).json(user);
};

exports.list = (req, res) => {
  const users = userService.listUsers();
  return res.json(users);
};

exports.get = (req, res) => {
  const { id } = req.params;
  const user = userService.getUser(id);
  if (!user) return res.status(404).json({ message: 'Not found' });
  return res.json(user);
};

exports.delete = (req, res) => {
  const { id } = req.params;
  const ok = userService.deleteUser(id);
  if (!ok) return res.status(404).json({ message: 'Not found' });
  return res.status(204).send();
};
