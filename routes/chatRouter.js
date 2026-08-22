const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');
const { normalizeUser, getIO } = require('../utils/socketManager');

const router = express.Router();

// ── Auth Middleware ─────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = normalizeUser(decoded);
    next();
  });
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
      if (!err) req.user = normalizeUser(decoded);
    });
  }
  next();
}

// ── GET /api/chat/rooms — List rooms for current user ───────────────────────
router.get('/rooms', authenticate, async (req, res) => {
  try {
    const db = await connectDB();
    const user = req.user;

    let roomDocs = [];
    if (user.isAdmin) {
      roomDocs = await db.collection('chat_rooms')
        .find({})
        .sort({ 'lastMessage.createdAt': -1 })
        .toArray();
    } else {
      const allowedRooms = [];
      if (user.partnerId) {
        allowedRooms.push(`admin_partner_${user.partnerId}`);
      } else if (user.branchId) {
        allowedRooms.push(`branch_${user.branchId}`);
        allowedRooms.push(`admin_branch_${user.branchId}`);
        if (user.id) {
          allowedRooms.push(`admin_staff_${user.id}`);
        }
      }

      roomDocs = await db.collection('chat_rooms')
        .find({ roomId: { $in: allowedRooms } })
        .sort({ 'lastMessage.createdAt': -1 })
        .toArray();

      if (user.partnerId) {
        const pRoomId = `admin_partner_${user.partnerId}`;
        if (!roomDocs.some((r) => r.roomId === pRoomId)) {
          roomDocs.push({
            roomId: pRoomId,
            type: 'admin_partner',
            name: 'MOCOS Admin',
            subtitle: 'HQ Direct Message',
            lastMessage: null,
          });
        }
      } else if (user.branchId) {
        const bRoomId = `branch_${user.branchId}`;
        const abRoomId = `admin_branch_${user.branchId}`;
        const asRoomId = user.id ? `admin_staff_${user.id}` : null;

        let bName = user.branchName;
        if (!bName && ObjectId.isValid(user.branchId)) {
          const b = await db.collection('branches').findOne({ _id: new ObjectId(user.branchId) });
          if (b) bName = b.name;
        }

        if (!roomDocs.some((r) => r.roomId === bRoomId)) {
          roomDocs.push({
            roomId: bRoomId,
            type: 'branch',
            name: `${bName || 'Branch'} Team`,
            subtitle: 'Branch Group Chat',
            lastMessage: null,
          });
        }
        if (!roomDocs.some((r) => r.roomId === abRoomId)) {
          roomDocs.push({
            roomId: abRoomId,
            type: 'admin_branch',
            name: 'MOCOS Admin (Branch Group)',
            subtitle: 'HQ Communication with Entire Branch',
            lastMessage: null,
          });
        }
        if (asRoomId && !roomDocs.some((r) => r.roomId === asRoomId)) {
          roomDocs.push({
            roomId: asRoomId,
            type: 'admin_staff',
            name: 'MOCOS Admin (Direct Private)',
            subtitle: 'Private Direct Message from HQ Admin',
            lastMessage: null,
          });
        }
      }
    }

    const enriched = await Promise.all(
      roomDocs.map(async (room) => {
        const unread = await db.collection('chat_messages').countDocuments({
          roomId: room.roomId,
          senderId: { $ne: user.id },
          status: { $ne: 'read' },
          readBy: { $ne: user.id },
        });
        return {
          ...room,
          _id: room._id ? room._id.toString() : room.roomId,
          unreadCount: unread,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('[Chat] GET /rooms error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/rooms/admin/branches — Admin: list all branch rooms with assigned staff ──
router.get('/rooms/admin/branches', optionalAuth, async (req, res) => {
  try {
    const db = await connectDB();
    const branches = await db.collection('branches').find({}).toArray();

    const enriched = await Promise.all(
      branches.map(async (branch) => {
        const branchIdStr = branch._id.toString();
        const roomId = `admin_branch_${branchIdStr}`;
        const room = await db.collection('chat_rooms').findOne({ roomId });
        const unread = await db.collection('chat_messages').countDocuments({
          roomId,
          senderId: { $ne: 'admin' },
          status: { $ne: 'read' },
        });

        // Fetch staff assigned to this branch
        const staffMembers = await db.collection('branch_staff').find({ branchId: branchIdStr }).toArray();

        const staffRooms = await Promise.all(
          staffMembers.map(async (s) => {
            const sId = s._id.toString();
            const sRoomId = `admin_staff_${sId}`;
            const sRoom = await db.collection('chat_rooms').findOne({ roomId: sRoomId });
            const sUnread = await db.collection('chat_messages').countDocuments({
              roomId: sRoomId,
              senderId: { $ne: 'admin' },
              status: { $ne: 'read' },
            });

            return {
              roomId: sRoomId,
              staffId: sId,
              branchId: branchIdStr,
              branchName: branch.name,
              name: s.fullName,
              role: s.role,
              email: s.email,
              phoneNumber: s.phoneNumber,
              lastMessage: sRoom?.lastMessage || null,
              unreadCount: sUnread,
              type: 'admin_staff',
            };
          })
        );

        return {
          roomId,
          branchId: branchIdStr,
          name: branch.name,
          region: branch.region,
          lastMessage: room?.lastMessage || null,
          unreadCount: unread,
          type: 'admin_branch',
          staff: staffRooms,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('[Chat] GET /rooms/admin/branches error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/rooms/admin/partners — Admin: list all partner rooms ───────
router.get('/rooms/admin/partners', optionalAuth, async (req, res) => {
  try {
    const db = await connectDB();
    const partners = await db.collection('partners').find({}).toArray();

    const enriched = await Promise.all(
      partners.map(async (partner) => {
        const roomId = `admin_partner_${partner._id}`;
        const room = await db.collection('chat_rooms').findOne({ roomId });
        const unread = await db.collection('chat_messages').countDocuments({
          roomId,
          senderId: { $ne: 'admin' },
          status: { $ne: 'read' },
        });
        return {
          roomId,
          partnerId: partner._id.toString(),
          name: partner.fullName || partner.businessName,
          businessName: partner.businessName,
          region: partner.region,
          lastMessage: room?.lastMessage || null,
          unreadCount: unread,
          type: 'admin_partner',
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('[Chat] GET /rooms/admin/partners error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/rooms/:roomId/messages — Paginated message history ─────────
router.get('/rooms/:roomId/messages', optionalAuth, async (req, res) => {
  try {
    const db = await connectDB();
    const { roomId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before;

    const query = { roomId };
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await db
      .collection('chat_messages')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    messages.reverse();

    const userId = req.user?.id || 'admin';
    const undelivered = messages.filter((m) => m.status === 'sent' && m.senderId !== userId);
    if (undelivered.length) {
      const ids = undelivered.map((m) => m._id);
      await db.collection('chat_messages').updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'delivered', deliveredAt: new Date() } }
      );
    }

    res.json(messages.map((m) => ({ ...m, _id: m._id.toString() })));
  } catch (err) {
    console.error('[Chat] GET messages error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/rooms/:roomId/messages — REST Send Message Fallback ───────
router.post('/rooms/:roomId/messages', optionalAuth, async (req, res) => {
  try {
    const db = await connectDB();
    const { roomId } = req.params;
    const { content } = req.body;
    const user = req.user || { id: 'admin', fullName: 'Admin', role: 'Admin' };

    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

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

    try {
      const io = getIO();
      io.to(roomId).emit('new_message', message);
    } catch {}

    await db.collection('chat_rooms').updateOne(
      { roomId },
      {
        $set: {
          lastMessage: { content: content.trim(), createdAt: new Date(), senderName: user.fullName },
          updatedAt: new Date(),
        },
        $addToSet: { participants: user.id },
        $setOnInsert: { roomId, createdAt: new Date() },
      },
      { upsert: true }
    );

    res.json(message);
  } catch (err) {
    console.error('[Chat] POST message error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/chat/rooms/:roomId/read — Mark messages as read ───────────────
router.patch('/rooms/:roomId/read', optionalAuth, async (req, res) => {
  try {
    const db = await connectDB();
    const { roomId } = req.params;
    const userId = req.user?.id || 'admin';

    await db.collection('chat_messages').updateMany(
      {
        roomId,
        senderId: { $ne: userId },
        status: { $ne: 'read' },
      },
      {
        $set: { status: 'read', readAt: new Date() },
        $addToSet: { readBy: userId },
      }
    );

    try {
      const io = getIO();
      io.to(roomId).emit('messages_read', { roomId, readBy: userId });
    } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error('[Chat] PATCH /read error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/rooms/:roomId/unread — Unread count ───────────────────────
router.get('/rooms/:roomId/unread', optionalAuth, async (req, res) => {
  try {
    const db = await connectDB();
    const { roomId } = req.params;
    const userId = req.user?.id || 'admin';

    const count = await db.collection('chat_messages').countDocuments({
      roomId,
      senderId: { $ne: userId },
      status: { $ne: 'read' },
      readBy: { $ne: userId },
    });

    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
