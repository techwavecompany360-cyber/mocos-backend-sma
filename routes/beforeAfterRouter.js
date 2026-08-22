const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const jwt = require('jsonwebtoken');
const config = require('../config');
const gcsStorage = require('../utils/gcsStorage');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// ── Auth Middleware ────────────────────────────────────
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ── Multer Setup for Before/After Images ────────────────
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// ── Helper: format doc ────────────────────────────────
function formatDoc(doc) {
  return {
    _id: doc._id.toString(),
    device: doc.device,
    service: doc.service,
    badge: doc.badge || '',
    turnaround: doc.turnaround || '',
    cases: (doc.cases || []).map((c, i) => ({
      index: i,
      title: c.title,
      beforeImage: c.beforeImage,
      afterImage: c.afterImage,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── ROUTES ────────────────────────────────────────────

// GET /api/before-after — Public: list all showcase devices
router.get('/', async (req, res) => {
  try {
    const db = await connectDB();
    const docs = await db.collection('before_after_showcase').find().sort({ createdAt: 1 }).toArray();
    res.json(docs.map(formatDoc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/before-after — Admin: create a new device showcase entry
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { device, service, badge, turnaround } = req.body;
    if (!device || !device.trim()) {
      return res.status(400).json({ error: 'Device name is required' });
    }
    const db = await connectDB();
    const doc = {
      device: device.trim(),
      service: (service || '').trim(),
      badge: (badge || '').trim(),
      turnaround: (turnaround || '').trim(),
      cases: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection('before_after_showcase').insertOne(doc);
    res.status(201).json(formatDoc({ ...doc, _id: result.insertedId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/before-after/:id — Admin: update device metadata
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const { device, service, badge, turnaround } = req.body;
    const db = await connectDB();
    const updateFields = { updatedAt: new Date() };
    if (device !== undefined) updateFields.device = device.trim();
    if (service !== undefined) updateFields.service = service.trim();
    if (badge !== undefined) updateFields.badge = badge.trim();
    if (turnaround !== undefined) updateFields.turnaround = turnaround.trim();

    const result = await db.collection('before_after_showcase').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ message: 'Updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/before-after/:id — Admin: delete a device entry and all its images
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const db = await connectDB();
    const doc = await db.collection('before_after_showcase').findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ error: 'Device not found' });

    // Delete all associated image files from GCS
    for (const c of (doc.cases || [])) {
      for (const key of ['beforeImage', 'afterImage']) {
        if (c[key]) {
          const gcsPath = c[key].startsWith('http')
            ? gcsStorage.extractGcsPath(c[key])
            : `before-after/${path.basename(c[key])}`;
          if (gcsPath) await gcsStorage.deleteFile(gcsPath);
        }
      }
    }

    await db.collection('before_after_showcase').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Device showcase deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/before-after/:id/cases — Admin: upload a before/after image pair (max 3)
router.post('/:id/cases', authenticateAdmin, upload.fields([
  { name: 'beforeImage', maxCount: 1 },
  { name: 'afterImage', maxCount: 1 },
]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const db = await connectDB();
    const doc = await db.collection('before_after_showcase').findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ error: 'Device not found' });

    if ((doc.cases || []).length >= 3) {
      return res.status(400).json({ error: 'Maximum of 3 image pairs allowed per device. Remove one first.' });
    }

    if (!req.files?.beforeImage?.[0] || !req.files?.afterImage?.[0]) {
      return res.status(400).json({ error: 'Both before and after images are required' });
    }

    const beforeFile = req.files.beforeImage[0];
    const afterFile = req.files.afterImage[0];

    const beforeFilename = gcsStorage.generateFilename('ba-before', beforeFile.originalname);
    const beforeDestPath = `before-after/${beforeFilename}`;
    const beforeImage = await gcsStorage.uploadFile(beforeFile.buffer, beforeDestPath, beforeFile.mimetype);

    const afterFilename = gcsStorage.generateFilename('ba-after', afterFile.originalname);
    const afterDestPath = `before-after/${afterFilename}`;
    const afterImage = await gcsStorage.uploadFile(afterFile.buffer, afterDestPath, afterFile.mimetype);

    const title = (req.body.title || '').trim() || `${doc.device} Repair`;
    const newCase = { title, beforeImage, afterImage };

    await db.collection('before_after_showcase').updateOne(
      { _id: new ObjectId(id) },
      { $push: { cases: newCase }, $set: { updatedAt: new Date() } }
    );

    res.status(201).json(newCase);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/before-after/:id/cases/:caseIndex — Admin: remove a specific before/after pair
router.delete('/:id/cases/:caseIndex', authenticateAdmin, async (req, res) => {
  try {
    const { id, caseIndex } = req.params;
    const idx = parseInt(caseIndex, 10);

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    if (isNaN(idx)) return res.status(400).json({ error: 'Invalid case index' });

    const db = await connectDB();
    const doc = await db.collection('before_after_showcase').findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ error: 'Device not found' });
    if (!doc.cases || !doc.cases[idx]) return res.status(404).json({ error: 'Image pair not found' });

    const caseToRemove = doc.cases[idx];

    // Delete image files from GCS
    for (const key of ['beforeImage', 'afterImage']) {
      if (caseToRemove[key]) {
        const gcsPath = caseToRemove[key].startsWith('http')
          ? gcsStorage.extractGcsPath(caseToRemove[key])
          : `before-after/${path.basename(caseToRemove[key])}`;
        if (gcsPath) await gcsStorage.deleteFile(gcsPath);
      }
    }

    // Remove the case from array by index
    const updatedCases = doc.cases.filter((_, i) => i !== idx);
    await db.collection('before_after_showcase').updateOne(
      { _id: new ObjectId(id) },
      { $set: { cases: updatedCases, updatedAt: new Date() } }
    );

    res.json({ message: 'Image pair removed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
