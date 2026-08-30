const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

/**
 * Helper: Normalize phone numbers (strips spaces, hyphens, plus signs, brackets)
 */
function normalizePhone(phoneStr) {
  if (!phoneStr) return '';
  return String(phoneStr).replace(/[^\d]/g, '');
}

/**
 * Helper: Generate a unique 8-digit wallet number
 */
async function generateUniqueWalletNumber(db) {
  let unique = false;
  let walletNumber = '';
  let attempts = 0;

  while (!unique && attempts < 100) {
    attempts++;
    // Generate random 8-digit number between 10000000 and 99999999
    walletNumber = String(Math.floor(10000000 + Math.random() * 90000000));
    const existing = await db.collection('customers').findOne({ 'wallet.accountNumber': walletNumber });
    if (!existing) {
      unique = true;
    }
  }

  if (!unique) {
    throw new Error('Failed to generate unique wallet number. Please try again.');
  }

  return walletNumber;
}

/**
 * Middleware: Verify Customer JWT Token
 */
function authenticateCustomer(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. Token missing.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.customer = decoded;
    next();
  });
}

// Customer Registration Endpoint
router.post('/register', async (req, res) => {
  try {
    const db = await connectDB();
    const { fullName, phone, email, password } = req.body;

    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ error: 'Full Name is required.' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Phone Number is required.' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
    }

    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 8) {
      return res.status(400).json({ error: 'Please enter a valid phone number (at least 8 digits).' });
    }

    const cleanEmail = email ? email.trim().toLowerCase() : null;

    // Check if phone number ALREADY exists anywhere in DB (primary phone OR wallet phoneNumbers)
    const existingPhone = await db.collection('customers').findOne({
      $or: [
        { phone: cleanPhone },
        { 'wallet.phoneNumbers': cleanPhone }
      ]
    });

    if (existingPhone) {
      return res.status(409).json({ error: 'This phone number is already registered to another account.' });
    }

    // Check if email ALREADY exists (if provided)
    if (cleanEmail) {
      const existingEmail = await db.collection('customers').findOne({ email: cleanEmail });
      if (existingEmail) {
        return res.status(409).json({ error: 'This email address is already registered to an account.' });
      }
    }

    // Generate unique 8-digit wallet number
    const walletNumber = await generateUniqueWalletNumber(db);
    const hashedPassword = await bcrypt.hash(password, 10);

    const newCustomer = {
      fullName: fullName.trim(),
      phone: cleanPhone,
      email: cleanEmail,
      password: hashedPassword,
      wallet: {
        accountNumber: walletNumber,
        balance: 0,
        phoneNumbers: [cleanPhone], // Primary phone is automatically added as a recharge number
        createdAt: new Date()
      },
      createdAt: new Date()
    };

    const result = await db.collection('customers').insertOne(newCustomer);
    const customerId = result.insertedId.toString();

    // Create JWT token
    const token = jwt.sign(
      { id: customerId, phone: cleanPhone, walletNumber },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      token,
      customer: {
        id: customerId,
        fullName: newCustomer.fullName,
        phone: newCustomer.phone,
        email: newCustomer.email,
        wallet: newCustomer.wallet
      }
    });
  } catch (error) {
    console.error('[Customer Register Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Customer Login Endpoint (Accepts Phone OR Email)
router.post('/login', async (req, res) => {
  try {
    const db = await connectDB();
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Phone/Email and password are required.' });
    }

    const inputClean = identifier.trim();
    const cleanPhone = normalizePhone(inputClean);
    const cleanEmail = inputClean.toLowerCase();

    // Search by primary phone, email, or added wallet phone numbers
    const customer = await db.collection('customers').findOne({
      $or: [
        { phone: cleanPhone },
        { 'wallet.phoneNumbers': cleanPhone },
        { email: cleanEmail }
      ]
    });

    if (!customer) {
      return res.status(401).json({ error: 'Invalid phone/email or password.' });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, customer.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid phone/email or password.' });
    }

    // Create JWT token
    const token = jwt.sign(
      { id: customer._id.toString(), phone: customer.phone, walletNumber: customer.wallet?.accountNumber },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Logged in successfully!',
      token,
      customer: {
        id: customer._id.toString(),
        fullName: customer.fullName,
        phone: customer.phone,
        email: customer.email,
        wallet: customer.wallet
      }
    });
  } catch (error) {
    console.error('[Customer Login Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Current Customer Profile
router.get('/me', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();
    const customer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });

    if (!customer) {
      return res.status(404).json({ error: 'Customer account not found.' });
    }

    res.json({
      id: customer._id.toString(),
      fullName: customer.fullName,
      phone: customer.phone,
      email: customer.email,
      wallet: customer.wallet,
      createdAt: customer.createdAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Public Account Deletion Request Endpoint (Web & Android Google Play Compliance)
router.post('/request-deletion', async (req, res) => {
  try {
    const db = await connectDB();
    const { identifier, reason, confirmCheck } = req.body;

    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ error: 'Registered Phone Number or Email is required.' });
    }

    if (!confirmCheck) {
      return res.status(400).json({ error: 'Please confirm that you understand account data deletion is permanent.' });
    }

    const inputClean = identifier.trim();
    const cleanPhone = normalizePhone(inputClean);
    const cleanEmail = inputClean.toLowerCase();

    // Check if account exists
    const customer = await db.collection('customers').findOne({
      $or: [
        { phone: cleanPhone },
        { 'wallet.phoneNumbers': cleanPhone },
        { email: cleanEmail }
      ]
    });

    // Record the deletion request in DB regardless to allow processing/audit
    const deletionRecord = {
      identifier: inputClean,
      matchedCustomerId: customer ? customer._id.toString() : null,
      customerName: customer ? customer.fullName : 'Unknown / Unregistered',
      customerPhone: customer ? customer.phone : cleanPhone,
      customerEmail: customer ? customer.email : cleanEmail,
      reason: reason ? reason.trim() : 'No reason provided',
      status: 'pending', // 'pending', 'processed', 'rejected'
      requestedAt: new Date()
    };

    const result = await db.collection('deletion_requests').insertOne(deletionRecord);

    // Notify admin via system notification / email if available
    try {
      const emailService = require('../utils/emailService');
      if (emailService && emailService.sendMail) {
        await emailService.sendMail({
          to: 'mocoservicesinfo@gmail.com',
          subject: `⚠️ Account Deletion Request: ${customer ? customer.fullName : inputClean}`,
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
              <h2 style="color: #dc2626;">Account Deletion Request Received</h2>
              <p>A customer has requested permanent account and data deletion via the web privacy portal.</p>
              <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #ddd;">Request ID:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${result.insertedId}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #ddd;">Identifier Provided:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${inputClean}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #ddd;">Account Name:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${customer ? customer.fullName : 'Not Found'}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #ddd;">Reason:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${deletionRecord.reason}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #ddd;">Requested At:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${new Date().toLocaleString()}</td></tr>
              </table>
              <p style="margin-top: 20px; font-size: 12px; color: #777;">Process this request in the Mocos Admin Panel or database within 30 days per Google Play Data Deletion requirements.</p>
            </div>
          `
        }).catch(err => console.error('[Deletion Email Error]:', err.message));
      }
    } catch (e) {
      // Non-blocking
    }

    res.status(200).json({
      success: true,
      message: 'Account deletion request submitted successfully. Our team will verify and process your deletion within 72 hours.',
      requestId: result.insertedId.toString()
    });
  } catch (error) {
    console.error('[Account Deletion Request Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Authenticated Direct Account Deletion Endpoint
router.delete('/delete-account', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password confirmation is required to delete your account.' });
    }

    const customer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });
    if (!customer) {
      return res.status(404).json({ error: 'Customer account not found.' });
    }

    const isPasswordValid = await bcrypt.compare(password, customer.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Incorrect password. Account deletion aborted.' });
    }

    // Perform deletion of customer document
    await db.collection('customers').deleteOne({ _id: new ObjectId(req.customer.id) });

    // Mark associated wallet transactions as anonymized/deleted customer
    await db.collection('wallet_transactions').updateMany(
      { customerId: req.customer.id },
      { $set: { customerAnonymized: true, customerPhone: '[Deleted User]' } }
    );

    res.json({
      success: true,
      message: 'Your Mocos account and associated data have been permanently deleted.'
    });
  } catch (error) {
    console.error('[Customer Delete Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────
// These require the standard admin JWT token (same as dataRouter's authenticateToken).

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. Admin token missing.' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired admin token.' });
    req.adminUser = decoded;
    next();
  });
}

/**
 * GET /api/customer/admin/users
 * List all registered website customers with wallet summary.
 * Query params: search (name/phone/email/wallet#), page, limit
 */
router.get('/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { search = '', page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = {};
    if (search && search.trim()) {
      const s = search.trim();
      query = {
        $or: [
          { fullName: { $regex: s, $options: 'i' } },
          { phone: { $regex: s, $options: 'i' } },
          { email: { $regex: s, $options: 'i' } },
          { 'wallet.accountNumber': { $regex: s, $options: 'i' } },
          { 'wallet.phoneNumbers': { $regex: s, $options: 'i' } }
        ]
      };
    }

    const [customers, total] = await Promise.all([
      db.collection('customers')
        .find(query, { projection: { password: 0 } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray(),
      db.collection('customers').countDocuments(query)
    ]);

    // Aggregate wallet stats
    const statsAgg = await db.collection('customers').aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          totalWalletBalance: { $sum: '$wallet.balance' },
          newThisMonth: {
            $sum: {
              $cond: [
                { $gte: ['$createdAt', new Date(new Date().getFullYear(), new Date().getMonth(), 1)] },
                1, 0
              ]
            }
          }
        }
      }
    ]).toArray();

    const stats = statsAgg[0] || { totalUsers: 0, totalWalletBalance: 0, newThisMonth: 0 };

    res.json({
      customers: customers.map(c => ({
        id: c._id.toString(),
        fullName: c.fullName,
        phone: c.phone,
        email: c.email || null,
        wallet: {
          accountNumber: c.wallet?.accountNumber || null,
          balance: c.wallet?.balance || 0,
          phoneNumbers: c.wallet?.phoneNumbers || [],
          addedPhoneCount: c.wallet?.addedPhoneCount || 0,
          createdAt: c.wallet?.createdAt || null
        },
        createdAt: c.createdAt
      })),
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      },
      stats: {
        totalUsers: stats.totalUsers,
        totalWalletBalance: stats.totalWalletBalance,
        newThisMonth: stats.newThisMonth
      }
    });
  } catch (error) {
    console.error('[Admin Users List Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/customer/admin/users/:id
 * Get a single customer's full profile + wallet + paginated transaction history.
 */
router.get('/admin/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const txPage = parseInt(req.query.txPage) || 1;
    const txLimit = parseInt(req.query.txLimit) || 10;
    const txType = req.query.txType || '';
    const txSort = req.query.txSort === 'asc' ? 1 : -1;
    const txSearch = req.query.txSearch || '';
    const txSkip = (txPage - 1) * txLimit;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid customer ID.' });
    }

    const customer = await db.collection('customers').findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0 } }
    );

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    // Build filter query for transactions
    const txQuery = { customerId: id };
    if (txType && txType !== 'all') {
      txQuery.type = txType;
    }
    if (txSearch && txSearch.trim()) {
      txQuery.$or = [
        { description: { $regex: txSearch.trim(), $options: 'i' } },
        { performedBy: { $regex: txSearch.trim(), $options: 'i' } }
      ];
    }

    // Fetch paginated transactions for this customer
    const [transactions, txTotal] = await Promise.all([
      db.collection('wallet_transactions')
        .find(txQuery)
        .sort({ createdAt: txSort })
        .skip(txSkip)
        .limit(txLimit)
        .toArray(),
      db.collection('wallet_transactions').countDocuments(txQuery)
    ]);

    // Booking requests by this customer
    const bookings = await db.collection('bookData')
      .find({
        $or: [
          { phone: customer.phone },
          { phone: { $in: customer.wallet?.phoneNumbers || [] } }
        ]
      })
      .sort({ submittedAt: -1 })
      .limit(20)
      .toArray();

    res.json({
      customer: {
        id: customer._id.toString(),
        fullName: customer.fullName,
        phone: customer.phone,
        email: customer.email || null,
        wallet: {
          accountNumber: customer.wallet?.accountNumber || null,
          balance: customer.wallet?.balance || 0,
          phoneNumbers: customer.wallet?.phoneNumbers || [],
          addedPhoneCount: customer.wallet?.addedPhoneCount || 0,
          createdAt: customer.wallet?.createdAt || null
        },
        createdAt: customer.createdAt
      },
      transactions: transactions.map(t => ({
        id: t._id.toString(),
        type: t.type,
        amount: t.amount,
        oldBalance: t.oldBalance,
        newBalance: t.newBalance,
        description: t.description,
        performedBy: t.performedBy || 'System',
        status: t.status || 'completed',
        createdAt: t.createdAt
      })),
      transactionsPagination: {
        total: txTotal,
        page: txPage,
        limit: txLimit,
        pages: Math.ceil(txTotal / txLimit) || 1
      },
      bookings: bookings.map(b => ({
        id: b._id.toString(),
        bookName: b.bookName || b.name,
        bookDevice: b.bookDevice || b.device,
        status: b.status || b.new || 'pending',
        submittedAt: b.submittedAt || b.date
      }))
    });
  } catch (error) {
    console.error('[Admin User Detail Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/customer/admin/users/:id/transactions
 * Fetch paginated transaction history for a specific customer with filter, sort and search.
 */
router.get('/admin/users/:id/transactions', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const type = req.query.type || '';
    const sort = req.query.sort === 'asc' ? 1 : -1;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid customer ID.' });
    }

    const txQuery = { customerId: id };
    if (type && type !== 'all') {
      txQuery.type = type;
    }
    if (search && search.trim()) {
      txQuery.$or = [
        { description: { $regex: search.trim(), $options: 'i' } },
        { performedBy: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    const [transactions, total] = await Promise.all([
      db.collection('wallet_transactions')
        .find(txQuery)
        .sort({ createdAt: sort })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection('wallet_transactions').countDocuments(txQuery)
    ]);

    res.json({
      transactions: transactions.map(t => ({
        id: t._id.toString(),
        type: t.type,
        amount: t.amount,
        oldBalance: t.oldBalance,
        newBalance: t.newBalance,
        description: t.description,
        performedBy: t.performedBy || 'System',
        status: t.status || 'completed',
        createdAt: t.createdAt
      })),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    console.error('[Admin User Transactions Pagination Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/customer/admin/users/:id
 * Admin hard-deletes a customer account and anonymises their transactions.
 */
router.delete('/admin/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid customer ID.' });
    }

    const customer = await db.collection('customers').findOne({ _id: new ObjectId(id) });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    await db.collection('customers').deleteOne({ _id: new ObjectId(id) });

    // Anonymize related transactions
    await db.collection('wallet_transactions').updateMany(
      { customerId: id },
      { $set: { customerAnonymized: true, customerName: '[Deleted by Admin]' } }
    );

    res.json({
      success: true,
      message: `Customer "${customer.fullName}" has been permanently deleted.`
    });
  } catch (error) {
    console.error('[Admin Delete Customer Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/customer/admin/deletion-requests
 * Fetch all account deletion requests submitted by users.
 */
router.get('/admin/deletion-requests', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const requests = await db.collection('deletion_requests')
      .find()
      .sort({ requestedAt: -1 })
      .toArray();

    res.json(requests.map(r => ({
      id: r._id.toString(),
      identifier: r.identifier,
      customerName: r.customerName || 'Unknown',
      customerPhone: r.customerPhone || '—',
      customerEmail: r.customerEmail || '—',
      reason: r.reason || 'No reason provided',
      status: r.status || 'pending',
      requestedAt: r.requestedAt
    })));
  } catch (error) {
    console.error('[Admin Deletion Requests Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/customer/admin/deletion-requests/:id/status
 * Update status of an account deletion request ('pending', 'processed', 'rejected').
 */
router.patch('/admin/deletion-requests/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid deletion request ID.' });
    }

    const validStatuses = ['pending', 'processed', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    await db.collection('deletion_requests').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } }
    );

    res.json({ success: true, message: `Deletion request marked as ${status}.` });
  } catch (error) {
    console.error('[Admin Update Deletion Status Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  router,
  authenticateCustomer,
  normalizePhone
};
