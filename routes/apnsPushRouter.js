const express = require('express');
const connectDB = require('../utils/db');
const config = require('../config');

const router = express.Router();

// GET APNs Configuration Status
router.get('/status', (req, res) => {
  const isConfigured = !!(config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_KEY_PATH);
  res.json({
    configured: isConfigured,
    bundleId: config.APNS_BUNDLE_ID,
    environment: config.APNS_PRODUCTION ? 'production' : 'sandbox'
  });
});

// POST save APNs device token
router.post('/subscribe', async (req, res) => {
  try {
    const { deviceToken, platform, appVersion, deviceModel, osVersion } = req.body;

    if (!deviceToken) {
      return res.status(400).json({ error: 'Device token is required' });
    }

    const db = await connectDB();
    const collection = db.collection('apns_device_tokens');

    // Upsert by deviceToken to prevent duplicate entries
    await collection.updateOne(
      { deviceToken },
      {
        $set: {
          deviceToken,
          platform: platform || 'ios',
          appVersion: appVersion || '1.0',
          deviceModel: deviceModel || 'iPhone',
          osVersion: osVersion || 'iOS',
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    console.log('[APNs] Device token registered:', deviceToken.substring(0, 30) + '...');
    res.status(201).json({ success: true, message: 'APNs device token registered' });
  } catch (error) {
    console.error('[APNs] Error registering device token:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE unregister APNs device token
router.delete('/unsubscribe', async (req, res) => {
  try {
    const { deviceToken } = req.body;

    if (!deviceToken) {
      return res.status(400).json({ error: 'Device token is required' });
    }

    const db = await connectDB();
    await db.collection('apns_device_tokens').deleteOne({ deviceToken });

    console.log('[APNs] Device token unregistered:', deviceToken.substring(0, 30) + '...');
    res.json({ success: true, message: 'APNs device token unregistered' });
  } catch (error) {
    console.error('[APNs] Error unregistering device token:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
