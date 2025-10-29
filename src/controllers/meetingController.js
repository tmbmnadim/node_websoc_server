const callService = require('../services/callService');

exports.create = (req, res) => {
  const {name, hostUserId, participantIds, type } = req.body;
  if (!hostUserId) return res.status(400).json({ message: 'hostUserId required' });
  const meeting = callService.createMeeting({ name, hostUserId, participantIds, type });
  return res.status(201).json(meeting);
};

exports.get = (req, res) => {
  const { meetingId } = req.params;
  const meeting = callService.getMeeting(meetingId);
  if (!meeting) return res.status(404).json({ message: 'Not found' });
  return res.json(meeting);
};

exports.end = (req, res) => {
  const { meetingId } = req.params;
  const meeting = callService.endMeeting(meetingId);
  if (!meeting) return res.status(404).json({ message: 'Not found' });
  return res.json(meeting);
};

exports.list = (req, res) => {
  const meetings = callService.listMeetings();
  return res.json(meetings);
};
