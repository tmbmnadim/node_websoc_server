const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.post('/', userController.create);
router.get('/', userController.list);
router.get('/:id', userController.get);
router.delete('/:id', userController.delete);

module.exports = router;
