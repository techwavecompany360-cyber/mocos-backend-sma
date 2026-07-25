const express = require('express');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const { addClient, broadcastNotification } = require('../utils/notificationEmitter');

const router = express.Router();

// SSE Stream Endpoint (Public/Client connection)
router.get('/stream', (req, res) => {
  addClient(req, res);
});

// GET past notifications (Limit 50)
router.get('/', async (req, res) => {
  try {
    const db = await connectDB();
    const notifications = await db
      .collection('notifications')
      .find()
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    res.json(
      notifications.map((n) => ({
        id: n._id.toString(),
        type: n.type,
        title: n.title,
        message: n.message,
        link: n.link,
        data: n.data,
        read: !!n.read,
        createdAt: n.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT mark single notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid notification ID' });
    }
    const db = await connectDB();
    await db.collection('notifications').updateOne({ _id: new ObjectId(id) }, { $set: { read: true } });
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT mark all notifications as read
router.put('/read-all', async (req, res) => {
  try {
    const db = await connectDB();
    await db.collection('notifications').updateMany({ read: false }, { $set: { read: true } });
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE single notification
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid notification ID' });
    }
    const db = await connectDB();
    await db.collection('notifications').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST test endpoint to trigger a sample notification
router.post('/test', async (req, res) => {
  try {
    const sample = await broadcastNotification({
      type: 'test',
      title: '🔔 Test Push Notification',
      message: 'This is a test web request push notification from Mocos Backend!',
      link: '/bookings',
      data: { test: true }
    });
    res.json({ success: true, notification: sample });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
