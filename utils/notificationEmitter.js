const connectDB = require('./db');
const { ObjectId } = require('mongodb');

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
 * Broadcast notification to all active SSE clients and save to DB
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

    // Broadcast to connected SSE clients
    const sseData = `data: ${JSON.stringify(notification)}\n\n`;
    sseClients.forEach((c) => {
      try {
        c.res.write(sseData);
      } catch (err) {
        console.error(`[Notification SSE] Error writing to client ${c.id}:`, err.message);
      }
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
