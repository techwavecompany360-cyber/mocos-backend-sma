const express = require('express');
const connectDB = require('../utils/db');

const router = express.Router();

// GET public VAPID key (frontend needs this to subscribe)
router.get('/vapid-key', (req, res) => {
  const config = require('../config');
  res.json({ publicKey: config.VAPID_PUBLIC_KEY });
});

// POST save a push subscription
router.post('/subscribe', async (req, res) => {
  try {
    const subscription = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'Invalid push subscription object' });
    }

    const db = await connectDB();
    const collection = db.collection('push_subscriptions');

    // Upsert by endpoint to avoid duplicates
    await collection.updateOne(
      { endpoint: subscription.endpoint },
      {
        $set: {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    console.log('[Web Push] Subscription saved:', subscription.endpoint.substring(0, 60) + '...');
    res.status(201).json({ success: true, message: 'Push subscription saved' });
  } catch (error) {
    console.error('[Web Push] Error saving subscription:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE remove a push subscription
router.delete('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    const db = await connectDB();
    await db.collection('push_subscriptions').deleteOne({ endpoint });

    console.log('[Web Push] Subscription removed:', endpoint.substring(0, 60) + '...');
    res.json({ success: true, message: 'Push subscription removed' });
  } catch (error) {
    console.error('[Web Push] Error removing subscription:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
