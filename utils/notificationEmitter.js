const connectDB = require('./db');
const { ObjectId } = require('mongodb');
const webpush = require('web-push');
const config = require('../config');
const { sendAPNsToAll } = require('./apnsService');
const { sendAdminUpdateEmail } = require('./emailService');


// Configure web-push with VAPID keys
if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    config.VAPID_SUBJECT,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY
  );
  console.log('[Web Push] VAPID keys configured successfully');
} else {
  console.warn('[Web Push] VAPID keys not configured — Web Push notifications will be disabled');
}

let sseClients = [];

/**
 * Add a new SSE client connection
 */
function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const clientId = Date.now() + Math.random().toString(36).substring(2, 9);
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  console.log(`[Notification SSE] Client connected: ${clientId} (Total: ${sseClients.length})`);

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Notification stream connected' })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
    console.log(`[Notification SSE] Client disconnected: ${clientId} (Remaining: ${sseClients.length})`);
  });
}

/**
 * Send heartbeat ping to keep connections alive
 */
setInterval(() => {
  sseClients.forEach((c) => {
    try {
      c.res.write(':ping\n\n');
    } catch (e) {
      // Ignore write errors
    }
  });
}, 25000);

/**
 * Send Web Push to all stored subscriptions
 */
async function sendWebPushToAll(notification) {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) {
    return; // Web Push not configured
  }

  try {
    const db = await connectDB();
    const subscriptions = await db.collection('push_subscriptions').find().toArray();

    if (subscriptions.length === 0) {
      console.log('[Web Push] No subscriptions found, skipping push');
      return;
    }

    const payload = JSON.stringify({
      title: notification.title || 'MOCOS Notification',
      body: notification.message || 'You have a new notification',
      icon: '/logo.png',
      badge: '/logo.png',
      tag: notification.id || 'mocos-' + Date.now(),
      data: {
        link: notification.link || '/',
        id: notification.id,
        type: notification.type
      }
    });

    console.log(`[Web Push] Sending push to ${subscriptions.length} subscription(s)`);

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload
          );
        } catch (error) {
          // If subscription is expired or invalid (410 Gone / 404), remove it
          if (error.statusCode === 410 || error.statusCode === 404) {
            console.log(`[Web Push] Removing expired subscription: ${sub.endpoint.substring(0, 50)}...`);
            await db.collection('push_subscriptions').deleteOne({ endpoint: sub.endpoint });
          } else {
            console.error(`[Web Push] Error sending to ${sub.endpoint.substring(0, 50)}...:`, error.message);
          }
          throw error; // Re-throw so Promise.allSettled marks as rejected
        }
      })
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    console.log(`[Web Push] Results: ${succeeded} delivered, ${failed} failed`);
  } catch (error) {
    console.error('[Web Push] Error in sendWebPushToAll:', error.message);
  }
}

/**
 * Broadcast notification to all active SSE clients, save to DB, and send Web Push
 */
async function broadcastNotification(payload) {
  try {
    const notification = {
      type: payload.type || 'web_request', // booking, sell, repair, newsletter, comment
      title: payload.title || 'New Web Request',
      message: payload.message || 'A new request was received from the website.',
      link: payload.link || '/',
      data: payload.data || {},
      read: false,
      createdAt: new Date()
    };

    // Save to database
    const db = await connectDB();
    const result = await db.collection('notifications').insertOne(notification);
    notification.id = result.insertedId.toString();

    console.log(`[Notification SSE] Broadcasting notification "${notification.title}" to ${sseClients.length} clients`);

    // Broadcast to connected SSE clients (for in-app real-time updates)
    const sseData = `data: ${JSON.stringify(notification)}\n\n`;
    sseClients.forEach((c) => {
      try {
        c.res.write(sseData);
      } catch (err) {
        console.error(`[Notification SSE] Error writing to client ${c.id}:`, err.message);
      }
    });

    // Send Web Push notifications (for when browser is closed)
    sendWebPushToAll(notification);

    // Send APNs Push notifications (for native iOS app)
    sendAPNsToAll(notification);

    // Send Email Update to Admin recipient via updates@mocos.co.tz
    sendAdminUpdateEmail(notification).catch(err => {
      console.error('[Email Notification] Error sending admin update email:', err.message);
    });

    return notification;
  } catch (error) {
    console.error('[Notification SSE] Error broadcasting notification:', error.message);
  }
}


module.exports = {
  addClient,
  broadcastNotification
};
