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

// Set up multer with memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// POST /api/gallery - upload image (Max 12 images)
router.post('/', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    const db = await connectDB();

    const count = await db.collection('gallery').countDocuments();
    if (count >= 12) {
      return res.status(400).json({ error: 'Gallery is full (maximum 12 pictures allowed). Please delete an existing picture before uploading a new one.' });
    }

    const alt = (req.body.alt || req.body.caption || '').trim();
    const title = (req.body.title || alt || '').trim();
    const filename = gcsStorage.generateFilename('gallery', req.file.originalname);
    const destPath = `gallery/${filename}`;
    const url = await gcsStorage.uploadFile(req.file.buffer, destPath, req.file.mimetype);
    const doc = {
      url,
      alt: alt || 'Workshop Gallery',
      title: title || 'Our Workshop & Repairs',
      gcsPath: destPath,
      createdAt: new Date(),
      order: count + 1
    };
    const result = await db.collection('gallery').insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), url, alt: doc.alt, title: doc.title, createdAt: doc.createdAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/gallery - list images (public for website & dashboard)
router.get('/', async (req, res) => {
  try {
    const db = await connectDB();
    const images = await db.collection('gallery').find().sort({ createdAt: 1 }).toArray();
    res.json(images.map(img => ({
      id: img._id.toString(),
      url: img.url,
      alt: img.alt || img.title || 'Our Work & Workshop',
      title: img.title || img.alt || 'Our Work & Workshop',
      createdAt: img.createdAt || null
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/gallery/:id - delete image
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid image id' });
    const image = await db.collection('gallery').findOne({ _id: new ObjectId(id) });
    if (!image) return res.status(404).json({ error: 'Image not found' });
    
    const gcsPath = image.gcsPath || (image.url && image.url.startsWith('http') ? gcsStorage.extractGcsPath(image.url) : `gallery/${path.basename(image.url)}`);
    if (gcsPath) await gcsStorage.deleteFile(gcsPath);

    await db.collection('gallery').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
