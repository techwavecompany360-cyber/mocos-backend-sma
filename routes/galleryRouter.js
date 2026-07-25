const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const jwt = require('jsonwebtoken');

const config = require('../config');

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

// Set up multer for file uploads
const uploadDir = path.join(__dirname, '../public/gallery');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}`);
  }
});
// Allow up to 30MB image file size
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// POST /api/gallery - upload image
router.post('/', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    const db = await connectDB();
    const alt = req.body.alt || '';
    const url = `/gallery/${req.file.filename}`;
    const doc = { url, alt };
    const result = await db.collection('gallery').insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), url, alt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/gallery - list images
router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const images = await db.collection('gallery').find().toArray();
    res.json(images.map(img => ({ id: img._id.toString(), url: img.url, alt: img.alt })));
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
    // Remove file
    const filePath = path.join(uploadDir, path.basename(image.url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await db.collection('gallery').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
