const express = require('express');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { broadcastNotification } = require('../utils/notificationEmitter');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// Middleware to protect routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// GET all subscribers (protected)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const subscribers = await db.collection('newsletter_subscribers').find().toArray();
    res.json(subscribers.map(({ _id, email, subscribedAt }) => ({
      id: _id.toString(),
      email,
      subscribedAt: new Date(subscribedAt).toISOString().split('T')[0]
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST add a subscriber (public)
router.post('/', async (req, res) => {
  try {
    const db = await connectDB();
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required and must be a string' });
    }
    // Simple email validation
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const exists = await db.collection('newsletter_subscribers').findOne({ email });
    if (exists) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    const doc = {
      email,
      subscribedAt: new Date()
    };
    const result = await db.collection('newsletter_subscribers').insertOne(doc);

    // Broadcast real-time push notification
    broadcastNotification({
      type: "newsletter",
      title: "New Newsletter Subscriber",
      message: `${email} has subscribed to the newsletter.`,
      link: "/subscribers",
      data: { email }
    });

    res.status(201).json({
      id: result.insertedId.toString(),
      email: doc.email,
      subscribedAt: doc.subscribedAt.toISOString().split('T')[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE remove a subscriber (protected)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid subscriber id' });
    }
    const result = await db.collection('newsletter_subscribers').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
