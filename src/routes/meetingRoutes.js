const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');

router.post('/', meetingController.create);
router.get('/', meetingController.list);
router.get('/:meetingId', meetingController.get);
router.put('/:meetingId/end', meetingController.end);

module.exports = router;
