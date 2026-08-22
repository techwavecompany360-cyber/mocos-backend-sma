const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const connectDB = require('./db');
const { ObjectId } = require('mongodb');

let io;

function normalizeUser(user) {
  if (!user) return { id: 'unknown', fullName: 'Unknown', role: 'User' };
  const isAdmin =
    user.role === 'admin' ||
    user.role === 'Admin' ||
    (!user.branchId && !user.partnerId && user.username);

  return {
    id: (user.id || user._id || (isAdmin ? 'admin' : '')).toString(),
    fullName: user.fullName || user.username || (isAdmin ? 'MOCOS Admin' : 'Staff'),
    role: isAdmin ? 'Admin' : user.role || 'Staff',
    branchId: user.branchId ? user.branchId.toString() : null,
    branchName: user.branchName || null,
    partnerId: user.partnerId ? user.partnerId.toString() : null,
    isAdmin,
  };
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.ALLOWED_ORIGINS,
      credentials: true,
    },
    pingTimeout: 60000,
  });

  // ── JWT Auth Middleware ────────────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication token required'));
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET);
      socket.user = normalizeUser(decoded);
      next();
    } catch (err) {
      console.error('[Socket Auth Error]', err.message);
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection Handler ─────────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const user = socket.user;
    console.log(`[Chat] Connected: ${user.fullName} (${user.role}) - ID: ${user.id}`);

    // Auto-join appropriate rooms
    if (user.isAdmin) {
      socket.join('admin');
    }
    if (user.partnerId) {
      const partnerRoom = `admin_partner_${user.partnerId}`;
      socket.join(partnerRoom);
      socket.join(`partner_${user.partnerId}`);
    }
    if (user.branchId) {
      socket.join(`branch_${user.branchId}`);
      socket.join(`admin_branch_${user.branchId}`);
      if (user.id) {
        socket.join(`admin_staff_${user.id}`);
      }
    }

    // ── Join room on demand ───────────────────────────────────────────────
    socket.on('join_room', (roomId) => {
      if (roomId) socket.join(roomId);
    });

    // ── Send Message ───────────────────────────────────────────────────────
    socket.on('send_message', async (data) => {
      try {
        const { roomId, content } = data;
        if (!roomId || !content?.trim()) return;

        const db = await connectDB();

        const messageDoc = {
          roomId,
          senderId: user.id,
          senderName: user.fullName,
          senderRole: user.role,
          content: content.trim(),
          type: 'text',
          status: 'sent',
          deliveredAt: null,
          readAt: null,
          readBy: [user.id],
          createdAt: new Date(),
        };

        const result = await db.collection('chat_messages').insertOne(messageDoc);
        const message = { ...messageDoc, _id: result.insertedId.toString() };

        // Emit to all sockets in the room
        io.to(roomId).emit('new_message', message);

        // If sender is non-admin, notify admin room so sidebar unread badges update live
        if (!user.isAdmin) {
          io.to('admin').emit('room_updated', { roomId, lastMessage: message });
        }

        // Check if recipients are in room
        const socketsInRoom = await io.in(roomId).fetchSockets();
        const hasOtherRecipients = socketsInRoom.some(
          (s) => s.user?.id !== user.id
        );

        if (hasOtherRecipients) {
          await db.collection('chat_messages').updateOne(
            { _id: result.insertedId },
            { $set: { status: 'delivered', deliveredAt: new Date() } }
          );
          socket.emit('message_delivered', { messageId: result.insertedId.toString(), roomId });
          io.to(roomId).emit('status_update', {
            messageId: result.insertedId.toString(),
            status: 'delivered',
          });
        }

        // Upsert room info
        await db.collection('chat_rooms').updateOne(
          { roomId },
          {
            $set: {
              lastMessage: { content: content.trim(), createdAt: new Date(), senderName: user.fullName },
              updatedAt: new Date(),
            },
            $addToSet: { participants: user.id },
            $setOnInsert: { roomId, type: getRoomType(roomId), createdAt: new Date() },
          },
          { upsert: true }
        );
      } catch (err) {
        console.error('[Chat] send_message error:', err);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ── Mark Read ─────────────────────────────────────────────────────────
    socket.on('mark_read', async ({ roomId, messageIds }) => {
      try {
        if (!roomId) return;
        const db = await connectDB();

        let filter = { roomId, senderId: { $ne: user.id }, status: { $ne: 'read' } };
        if (messageIds?.length) {
          const objectIds = messageIds
            .filter((id) => ObjectId.isValid(id))
            .map((id) => new ObjectId(id));
          if (objectIds.length) filter._id = { $in: objectIds };
        }

        const updateResult = await db.collection('chat_messages').updateMany(filter, {
          $set: { status: 'read', readAt: new Date() },
          $addToSet: { readBy: user.id },
        });

        if (updateResult.modifiedCount > 0) {
          io.to(roomId).emit('messages_read', {
            roomId,
            readBy: user.id,
          });
        }
      } catch (err) {
        console.error('[Chat] mark_read error:', err);
      }
    });

    // ── Typing Indicators ─────────────────────────────────────────────────
    socket.on('typing_start', ({ roomId }) => {
      if (roomId) {
        socket.to(roomId).emit('typing', {
          roomId,
          userId: user.id,
          name: user.fullName,
        });
      }
    });

    socket.on('typing_stop', ({ roomId }) => {
      if (roomId) {
        socket.to(roomId).emit('typing_stop', {
          roomId,
          userId: user.id,
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Chat] Disconnected: ${user.fullName}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

function getRoomType(roomId) {
  if (roomId.startsWith('branch_')) return 'branch';
  if (roomId.startsWith('admin_branch_')) return 'admin_branch';
  if (roomId.startsWith('admin_partner_')) return 'admin_partner';
  return 'custom';
}

module.exports = { initSocket, getIO, normalizeUser };
