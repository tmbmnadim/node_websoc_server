/**
 * callService: very small in-memory meeting store.
 * Meeting contains: meetingId, hostUserId, participantIds[], type, startedAt, endedAt|null
 */
const { v4: uuidv4 } = require('uuid');

class CallService {
  constructor() {
    this.meetings = new Map();
  }

  createMeeting({name, hostUserId, participantIds = [], type = 'conference' }) {
    const meetingId = uuidv4();
    const meeting = {
      meetingId,
      name,
      hostUserId,
      participantIds: Array.from(new Set([...(participantIds || []), hostUserId].filter(Boolean))),
      type,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.meetings.set(meetingId, meeting);
    return meeting;
  }

  getMeeting(meetingId) {
    return this.meetings.get(meetingId) || null;
  }

  endMeeting(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.endedAt = new Date().toISOString();
    this.meetings.set(meetingId, m);
    return m;
  }

  listMeetings() {
    return Array.from(this.meetings.values());
  }
}

module.exports = new CallService();
