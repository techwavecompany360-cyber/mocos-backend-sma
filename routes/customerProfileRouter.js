const express = require('express');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const connectDB = require('../utils/db');
const config = require('../config');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

function authenticateAny(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired session token' });
    if (!user.role && (user.username || user.id)) user.role = 'Admin';
    req.staff = user;
    next();
  });
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/[\s\-\(\)\+]/g, '').trim();
}

// POST /find-or-create
router.post('/find-or-create', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { fullName, phoneNumber, email } = req.body;
    if (!phoneNumber && !fullName) return res.status(400).json({ error: 'phoneNumber or fullName required' });

    const normalized = phoneNumber ? normalizePhone(phoneNumber) : null;
    let customer = null;

    if (normalized) {
      customer = await db.collection('customers').findOne({ 'phoneNumbers.normalized': normalized });
    }
    if (!customer && fullName && email) {
      customer = await db.collection('customers').findOne({
        primaryName: { $regex: '^' + fullName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' },
        primaryEmail: email.trim().toLowerCase(),
      });
    }

    if (customer) {
      if (normalized && !customer.phoneNumbers.some(p => p.normalized === normalized)) {
        await db.collection('customers').updateOne(
          { _id: customer._id },
          { $push: { phoneNumbers: { number: phoneNumber.trim(), normalized, label: 'additional', addedAt: new Date() } }, $set: { updatedAt: new Date() } }
        );
        customer = await db.collection('customers').findOne({ _id: customer._id });
      }
      return res.json({ customer, created: false });
    }

    const now = new Date();
    const newCustomer = {
      primaryName: fullName ? fullName.trim() : 'Unknown',
      primaryEmail: email ? email.trim().toLowerCase() : '',
      phoneNumbers: normalized ? [{ number: phoneNumber.trim(), normalized, label: 'primary', addedAt: now }] : [],
      notes: '',
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection('customers').insertOne(newCustomer);
    newCustomer._id = result.insertedId;
    res.status(201).json({ customer: newCustomer, created: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /search
router.get('/search', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ customers: [] });
    const term = q.trim();
    const normalizedTerm = normalizePhone(term);
    const customers = await db.collection('customers').find({
      $or: [
        { primaryName: { $regex: term, $options: 'i' } },
        { primaryEmail: { $regex: term, $options: 'i' } },
        { 'phoneNumbers.number': { $regex: term, $options: 'i' } },
        { 'phoneNumbers.normalized': { $regex: normalizedTerm, $options: 'i' } },
      ]
    }).limit(20).toArray();
    res.json({ customers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET / - list all customers
router.get('/', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.search) {
      const term = req.query.search.trim();
      const normalizedTerm = normalizePhone(term);
      filter.$or = [
        { primaryName: { $regex: term, $options: 'i' } },
        { primaryEmail: { $regex: term, $options: 'i' } },
        { 'phoneNumbers.number': { $regex: term, $options: 'i' } },
        { 'phoneNumbers.normalized': { $regex: normalizedTerm, $options: 'i' } },
      ];
    }
    const [customers, total] = await Promise.all([
      db.collection('customers').find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection('customers').countDocuments(filter),
    ]);
    res.json({ customers, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /:id
router.get('/:id', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid customer ID' });
    const customer = await db.collection('customers').findOne({ _id: new ObjectId(id) });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const phoneNormalized = customer.phoneNumbers.map(p => p.normalized);
    const phoneRaw = customer.phoneNumbers.map(p => p.number);
    const serviceRequests = await db.collection('service_requests').find({
      $or: [
        { customerId: id },
        { customerId: customer._id.toString() },
        { 'customerInfo.phoneNumber': { $in: phoneRaw } },
        { 'customerInfo.phoneNormalized': { $in: phoneNormalized } },
      ]
    }).sort({ createdAt: -1 }).toArray();
    const seen = new Set();
    const dedupedRequests = serviceRequests.filter(r => {
      const key = r._id.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json({ customer, serviceRequests: dedupedRequests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /:id/history
router.get('/:id/history', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid customer ID' });
    const customer = await db.collection('customers').findOne({ _id: new ObjectId(id) });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const phoneNormalized = customer.phoneNumbers.map(p => p.normalized);
    const phoneRaw = customer.phoneNumbers.map(p => p.number);
    const serviceRequests = await db.collection('service_requests').find({
      $or: [
        { customerId: id },
        { customerId: customer._id.toString() },
        { 'customerInfo.phoneNumber': { $in: phoneRaw } },
        { 'customerInfo.phoneNormalized': { $in: phoneNormalized } },
      ]
    }).sort({ createdAt: -1 }).toArray();
    const seen = new Set();
    const history = serviceRequests.filter(r => {
      const key = r._id.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const totalSpent = history.filter(r => r.paymentStatus === 'paid').reduce((sum, r) => sum + (r.totalCost || 0), 0);
    const deviceSet = new Set(history.map(r => (r.deviceInfo?.brandName || '') + '|' + (r.deviceInfo?.model || '')));
    res.json({
      customer,
      history,
      summary: { totalJobs: history.length, totalSpent, uniqueDevices: deviceSet.size, phoneNumbers: customer.phoneNumbers }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST / - create customer
router.post('/', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { fullName, phoneNumber, email, label } = req.body;
    if (!fullName || !phoneNumber) return res.status(400).json({ error: 'fullName and phoneNumber are required' });
    const normalized = normalizePhone(phoneNumber);
    const existing = await db.collection('customers').findOne({ 'phoneNumbers.normalized': normalized });
    if (existing) return res.json({ customer: existing, created: false });
    const now = new Date();
    const newCustomer = {
      primaryName: fullName.trim(),
      primaryEmail: email ? email.trim().toLowerCase() : '',
      phoneNumbers: [{ number: phoneNumber.trim(), normalized, label: label || 'primary', addedAt: now }],
      notes: '',
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection('customers').insertOne(newCustomer);
    newCustomer._id = result.insertedId;
    res.status(201).json({ customer: newCustomer, created: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /:id
router.patch('/:id', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid customer ID' });
    const { primaryName, primaryEmail, notes, tags } = req.body;
    const updates = { updatedAt: new Date() };
    if (primaryName !== undefined) updates.primaryName = primaryName.trim();
    if (primaryEmail !== undefined) updates.primaryEmail = primaryEmail.trim().toLowerCase();
    if (notes !== undefined) updates.notes = notes;
    if (tags !== undefined) updates.tags = tags;
    const result = await db.collection('customers').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: 'after' }
    );
    const customer = result?.value || result;
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /:id/phone-numbers
router.post('/:id/phone-numbers', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid customer ID' });
    const { phoneNumber, label } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });
    const normalized = normalizePhone(phoneNumber);
    const conflictCustomer = await db.collection('customers').findOne({
      _id: { $ne: new ObjectId(id) },
      'phoneNumbers.normalized': normalized,
    });
    if (conflictCustomer) {
      return res.status(409).json({
        error: 'This phone number is already linked to another customer',
        conflictCustomer: { id: conflictCustomer._id.toString(), name: conflictCustomer.primaryName, phones: conflictCustomer.phoneNumbers.map(p => p.number) }
      });
    }
    const existingCustomer = await db.collection('customers').findOne({ _id: new ObjectId(id) });
    if (!existingCustomer) return res.status(404).json({ error: 'Customer not found' });
    if (existingCustomer.phoneNumbers.some(p => p.normalized === normalized)) {
      return res.status(409).json({ error: 'This phone number is already linked to this customer' });
    }
    const newPhone = { number: phoneNumber.trim(), normalized, label: label || 'additional', addedAt: new Date() };
    const result = await db.collection('customers').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $push: { phoneNumbers: newPhone }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const customer = result?.value || result;
    // Link existing service_requests using this phone
    await db.collection('service_requests').updateMany(
      { $or: [{ 'customerInfo.phoneNumber': phoneNumber.trim() }, { 'customerInfo.phoneNormalized': normalized }], customerId: { $exists: false } },
      { $set: { customerId: id } }
    );
    res.json({ customer, phoneAdded: newPhone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /:id/phone-numbers/:normalized
router.delete('/:id/phone-numbers/:normalized', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { id, normalized } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid customer ID' });
    const customer = await db.collection('customers').findOne({ _id: new ObjectId(id) });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (customer.phoneNumbers.length <= 1) return res.status(400).json({ error: 'Cannot remove the only phone number' });
    const result = await db.collection('customers').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $pull: { phoneNumbers: { normalized } }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    res.json({ customer: result?.value || result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /merge
router.post('/merge', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const { sourceId, targetId } = req.body;
    if (!ObjectId.isValid(sourceId) || !ObjectId.isValid(targetId)) return res.status(400).json({ error: 'Invalid customer IDs' });
    if (sourceId === targetId) return res.status(400).json({ error: 'Cannot merge a customer with themselves' });
    const [source, target] = await Promise.all([
      db.collection('customers').findOne({ _id: new ObjectId(sourceId) }),
      db.collection('customers').findOne({ _id: new ObjectId(targetId) }),
    ]);
    if (!source) return res.status(404).json({ error: 'Source customer not found' });
    if (!target) return res.status(404).json({ error: 'Target customer not found' });
    const existingNormalized = new Set(target.phoneNumbers.map(p => p.normalized));
    const phonesToAdd = source.phoneNumbers.filter(p => !existingNormalized.has(p.normalized));
    await db.collection('customers').updateOne(
      { _id: new ObjectId(targetId) },
      { $push: { phoneNumbers: { $each: phonesToAdd } }, $set: { updatedAt: new Date() } }
    );
    const sourcePhones = source.phoneNumbers.map(p => p.number);
    const sourceNormalized = source.phoneNumbers.map(p => p.normalized);
    await db.collection('service_requests').updateMany(
      { $or: [{ customerId: sourceId }, { 'customerInfo.phoneNumber': { $in: sourcePhones } }, { 'customerInfo.phoneNormalized': { $in: sourceNormalized } }] },
      { $set: { customerId: targetId } }
    );
    await db.collection('customers').deleteOne({ _id: new ObjectId(sourceId) });
    const updatedTarget = await db.collection('customers').findOne({ _id: new ObjectId(targetId) });
    res.json({ message: 'Customers merged successfully', customer: updatedTarget });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
