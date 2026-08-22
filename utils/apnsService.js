const http2 = require('http2');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const connectDB = require('./db');

let cachedApnsJwt = null;
let apnsJwtExpiry = 0;

/**
 * Generate JWT for APNs Authentication (.p8 key)
 * APNs JWTs can be reused for up to 60 minutes.
 */
function getApnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedApnsJwt && now < apnsJwtExpiry - 60) {
    return cachedApnsJwt;
  }

  if (!config.APNS_KEY_ID || !config.APNS_TEAM_ID || !config.APNS_KEY_PATH) {
    return null;
  }

  try {
    const keyPath = path.isAbsolute(config.APNS_KEY_PATH)
      ? config.APNS_KEY_PATH
      : path.join(__dirname, '..', config.APNS_KEY_PATH);

    if (!fs.existsSync(keyPath)) {
      console.warn(`[APNs] Key file not found at: ${keyPath}`);
      return null;
    }

    const privateKey = fs.readFileSync(keyPath, 'utf8');

    const token = jwt.sign({}, privateKey, {
      algorithm: 'ES256',
      keyid: config.APNS_KEY_ID,
      issuer: config.APNS_TEAM_ID,
      expiresIn: '55m'
    });

    cachedApnsJwt = token;
    apnsJwtExpiry = now + 55 * 60;
    return token;
  } catch (error) {
    console.error('[APNs] Error generating APNs JWT:', error.message);
    return null;
  }
}

/**
 * Send APNs notification to a single device token using HTTP/2
 */
function sendSingleApnsNotification(deviceToken, notificationPayload, bearerToken) {
  return new Promise((resolve) => {
    const host = config.APNS_PRODUCTION
      ? 'api.push.apple.com'
      : 'api.sandbox.push.apple.com';

    const client = http2.connect(`https://${host}:443`);

    client.on('error', (err) => {
      console.error(`[APNs] HTTP/2 Connection error: ${err.message}`);
      resolve({ success: false, deviceToken, error: err.message });
    });

    const payload = JSON.stringify({
      aps: {
        alert: {
          title: notificationPayload.title || 'MOCOS Alert',
          body: notificationPayload.message || 'You have a new update.'
        },
        sound: 'default',
        badge: 1
      },
      link: notificationPayload.link || '/',
      id: notificationPayload.id,
      type: notificationPayload.type
    });

    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${bearerToken}`,
      'apns-topic': config.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    };

    const req = client.request(headers);

    let status = 0;
    let responseData = '';

    req.on('response', (resHeaders) => {
      status = resHeaders[':status'];
    });

    req.on('data', (chunk) => {
      responseData += chunk;
    });

    req.on('end', async () => {
      client.close();
      if (status === 200) {
        resolve({ success: true, deviceToken });
      } else {
        console.warn(`[APNs] Failed for ${deviceToken.substring(0, 10)}... Status: ${status}, Response: ${responseData}`);
        
        // Remove bad tokens (410 Gone / 400 BadDeviceToken / 400 Unregistered)
        if (status === 410 || responseData.includes('BadDeviceToken') || responseData.includes('Unregistered')) {
          try {
            const db = await connectDB();
            await db.collection('apns_device_tokens').deleteOne({ deviceToken });
            console.log(`[APNs] Removed invalid device token: ${deviceToken.substring(0, 10)}...`);
          } catch (e) {
            console.error('[APNs] Error removing invalid token:', e.message);
          }
        }
        resolve({ success: false, deviceToken, status, responseData });
      }
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send APNs notification to all stored iOS device tokens
 */
async function sendAPNsToAll(notification) {
  const token = getApnsJwt();
  if (!token) {
    // APNs not configured or key file missing
    return;
  }

  try {
    const db = await connectDB();
    const devices = await db.collection('apns_device_tokens').find().toArray();

    if (devices.length === 0) {
      console.log('[APNs] No iOS device tokens found, skipping APNs push');
      return;
    }

    console.log(`[APNs] Sending APNs push to ${devices.length} iOS device(s)`);

    const results = await Promise.allSettled(
      devices.map((device) => sendSingleApnsNotification(device.deviceToken, notification, token))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    const failed = devices.length - succeeded;
    console.log(`[APNs] Results: ${succeeded} delivered, ${failed} failed`);
  } catch (error) {
    console.error('[APNs] Error in sendAPNsToAll:', error.message);
  }
}

module.exports = {
  sendAPNsToAll,
  getApnsJwt
};
