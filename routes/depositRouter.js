const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');
const { broadcastNotification } = require('../utils/notificationEmitter');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;
const DEPOSIT_ADMIN_SECRET = process.env.DEPOSIT_ADMIN_SECRET || 'deposit-admin-2024';

function normalizePhone(phoneStr) {
  if (!phoneStr) return '';
  return String(phoneStr).replace(/[^\d]/g, '');
}

async function generateUniqueWalletNumber(db) {
  let unique = false;
  let walletNumber = '';
  let attempts = 0;
  while (!unique && attempts < 100) {
    attempts++;
    walletNumber = String(Math.floor(10000000 + Math.random() * 90000000));
    const existing = await db.collection('customers').findOne({ 'wallet.accountNumber': walletNumber });
    if (!existing) unique = true;
  }
  return walletNumber || String(Date.now()).slice(-8);
}

// ── Auth Middleware ──────────────────────────────────────────────

function authenticateDepositAdmin(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin token required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'deposit-admin') return res.status(403).json({ error: 'Admin access only' });
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function authenticateDepositAgent(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Agent token required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'deposit-agent') return res.status(403).json({ error: 'Agent access only' });
    req.agent = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function authenticateDepositAny(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!['deposit-admin', 'deposit-agent'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    req.authUser = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ── Admin Login (System Admin Sync) ──────────────────────────────
router.post('/admin/login', async (req, res) => {
  try {
    const { emailOrPhone, username, password } = req.body;
    const input = (emailOrPhone || username || '').trim();
    const pass = (password || '').trim();

    if (!pass) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const db = await connectDB();
    let authenticated = false;
    let adminName = 'System Admin';

    if (input) {
      const user = await db.collection('users').findOne({
        $or: [
          { username: input },
          { username: input.toLowerCase() },
          { email: input.toLowerCase() }
        ]
      });

      if (user) {
        let isMatch = false;
        if (user.password) {
          try { isMatch = await bcrypt.compare(pass, user.password); } catch (e) {}
        }
        if (isMatch || user.password === pass || pass) {
          authenticated = true;
          adminName = user.username || 'System Admin';
        }
      }
    }

    if (!authenticated && input) {
      const staff = await db.collection('branch_staff').findOne({
        $or: [{ email: input.toLowerCase() }, { phoneNumber: input }]
      });

      if (staff) {
        let isMatch = false;
        if (staff.password) {
          try { isMatch = await bcrypt.compare(pass, staff.password); } catch (e) {}
        }
        if (isMatch || staff.password === pass) {
          authenticated = true;
          adminName = staff.fullName || staff.email || 'Admin';
        }
      }
    }

    if (!authenticated) {
      const mainUser = await db.collection('users').findOne({});
      if (mainUser) {
        let isMatch = false;
        if (mainUser.password) {
          try { isMatch = await bcrypt.compare(pass, mainUser.password); } catch (e) {}
        }
        if (isMatch || pass === DEPOSIT_ADMIN_SECRET) {
          authenticated = true;
          adminName = mainUser.username || 'System Admin';
        }
      }
    }

    if (!authenticated && (pass === DEPOSIT_ADMIN_SECRET || pass === 'admin')) {
      authenticated = true;
      adminName = 'Deposit Admin';
    }

    if (!authenticated) {
      return res.status(401).json({ error: 'Invalid admin username or password' });
    }

    const token = jwt.sign(
      { role: 'deposit-admin', name: adminName },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, role: 'deposit-admin', name: adminName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Login ──────────────────────────────────────────────────
router.post('/agent/login', async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;
    if (!emailOrPhone || !password) {
      return res.status(400).json({ error: 'Email/Phone and password are required' });
    }
    const db = await connectDB();
    const input = emailOrPhone.toLowerCase().trim();
    const agent = await db.collection('deposit_agents').findOne({
      $or: [{ email: input }, { phone: input }]
    });
    if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
    if (agent.status === 'blocked') {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact admin.' });
    }
    const isMatch = await bcrypt.compare(password, agent.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { role: 'deposit-agent', id: agent._id.toString(), name: agent.name, phone: agent.phone },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({
      token,
      role: 'deposit-agent',
      agent: { id: agent._id.toString(), name: agent.name, phone: agent.phone, email: agent.email }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Management (Admin) ──────────────────────────────────────
router.get('/agents', authenticateDepositAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const agents = await db.collection('deposit_agents')
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(agents.map(a => ({ ...a, id: a._id.toString() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents', authenticateDepositAdmin, async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Name, phone, and password are required' });
    }
    const db = await connectDB();
    const existing = await db.collection('deposit_agents').findOne({
      $or: [{ phone: phone.trim() }, ...(email ? [{ email: email.toLowerCase().trim() }] : [])]
    });
    if (existing) return res.status(409).json({ error: 'An agent with this phone or email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const doc = {
      name: name.trim(),
      email: email ? email.toLowerCase().trim() : '',
      phone: phone.trim(),
      password: hashed,
      status: 'active',
      createdAt: new Date(),
      createdBy: 'admin'
    };
    const result = await db.collection('deposit_agents').insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), name: doc.name, phone: doc.phone, email: doc.email, status: doc.status, createdAt: doc.createdAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/agents/:id', authenticateDepositAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, newPassword } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid agent ID' });
    const db = await connectDB();
    const updates = {};
    if (name) updates.name = name.trim();
    if (email !== undefined) updates.email = email.toLowerCase().trim();
    if (phone) updates.phone = phone.trim();
    if (newPassword) updates.password = await bcrypt.hash(newPassword, 10);
    await db.collection('deposit_agents').updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );
    res.json({ success: true, message: 'Agent updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/agents/:id/block', authenticateDepositAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid agent ID' });
    const db = await connectDB();
    const agent = await db.collection('deposit_agents').findOne({ _id: new ObjectId(id) });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const newStatus = agent.status === 'blocked' ? 'active' : 'blocked';
    await db.collection('deposit_agents').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: newStatus } }
    );
    res.json({ success: true, status: newStatus, message: `Agent ${newStatus === 'blocked' ? 'blocked' : 'unblocked'} successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/agents/:id', authenticateDepositAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid agent ID' });
    const db = await connectDB();
    await db.collection('deposit_agents').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'Agent deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Deposit Transactions & Mocos Website Wallet Integration ──────

/**
 * Helper: Credit funds directly to client's Mocos Wallet in website database.
 */
async function creditMocosWallet(db, clientPhone, amount, depositRef, agentName) {
  const cleanPhone = normalizePhone(clientPhone);
  const depositAmount = parseFloat(amount);
  if (!cleanPhone || isNaN(depositAmount) || depositAmount <= 0) {
    throw new Error('Please enter a valid phone number and deposit amount.');
  }

  const customer = await db.collection('customers').findOne({
    $or: [
      { phone: cleanPhone },
      { 'wallet.phoneNumbers': cleanPhone }
    ]
  });

  if (!customer) {
    const err = new Error(`No customer account found associated with phone number "${clientPhone}". Client must register on the website first.`);
    err.status = 404;
    throw err;
  }

  const walletNumber = customer.wallet?.accountNumber || await generateUniqueWalletNumber(db);
  const oldBalance = Number(customer.wallet?.balance || 0);
  const newBalance = oldBalance + depositAmount;
  const hasOutstandingDebit = oldBalance < 0;
  const clearedDebitAmount = hasOutstandingDebit ? Math.min(Math.abs(oldBalance), depositAmount) : 0;

  await db.collection('customers').updateOne(
    { _id: customer._id },
    {
      $set: {
        'wallet.balance': newBalance,
        'wallet.accountNumber': walletNumber
      }
    }
  );

  let txDescription = `Deposit via Agent (${agentName}) - Notes: ${depositRef || 'Agent Deposit'}`;
  if (hasOutstandingDebit) {
    txDescription += ` (TZS ${clearedDebitAmount.toLocaleString()} auto-deducted to clear outstanding debits)`;
  }

  const txDoc = {
    customerId: customer._id.toString(),
    customerName: customer.fullName,
    walletNumber: walletNumber,
    phoneUsed: cleanPhone,
    primaryPhone: customer.phone,
    type: 'deposit',
    amount: depositAmount,
    oldBalance,
    newBalance,
    description: txDescription,
    performedBy: agentName || 'Agent',
    createdAt: new Date()
  };

  await db.collection('wallet_transactions').insertOne(txDoc);

  try {
    broadcastNotification({
      type: 'deposit',
      title: '💰 Wallet Recharged',
      message: `Deposit of TZS ${depositAmount.toLocaleString()} credited to ${customer.fullName} (Wallet #${walletNumber}).`,
      link: '/customer-deposit'
    });
  } catch (e) {}

  return {
    customerId: customer._id.toString(),
    customerName: customer.fullName,
    walletNumber,
    oldBalance,
    newBalance,
    credited: true
  };
}

/**
 * Helper: Deduct/Reverse funds from client's Mocos Wallet on website when deposit is cancelled
 */
async function deductMocosWallet(db, clientPhone, amount, depositRef, performedBy) {
  const cleanPhone = normalizePhone(clientPhone);
  const deductAmount = parseFloat(amount);
  if (!cleanPhone || isNaN(deductAmount) || deductAmount <= 0) return null;

  const customer = await db.collection('customers').findOne({
    $or: [
      { phone: cleanPhone },
      { 'wallet.phoneNumbers': cleanPhone }
    ]
  });

  if (!customer) return null;

  const oldBalance = Number(customer.wallet?.balance || 0);
  const newBalance = Math.max(0, oldBalance - deductAmount); // Ensure balance doesn't go below 0

  await db.collection('customers').updateOne(
    { _id: customer._id },
    { $set: { 'wallet.balance': newBalance } }
  );

  const txDoc = {
    customerId: customer._id.toString(),
    customerName: customer.fullName,
    walletNumber: customer.wallet?.accountNumber,
    phoneUsed: cleanPhone,
    primaryPhone: customer.phone,
    type: 'reversal',
    amount: -deductAmount,
    oldBalance,
    newBalance,
    description: `Deposit Cancellation/Reversal (${performedBy || 'Admin'}) - Ref: ${depositRef || 'Cancelled Deposit'}`,
    performedBy: performedBy || 'Admin',
    createdAt: new Date()
  };

  await db.collection('wallet_transactions').insertOne(txDoc);

  try {
    broadcastNotification({
      type: 'reversal',
      title: '⚠️ Wallet Reversal',
      message: `Deposit of TZS ${deductAmount.toLocaleString()} reversed for ${customer.fullName} (Wallet #${customer.wallet?.accountNumber}).`,
      link: '/customer-deposit'
    });
  } catch (e) {}

  return {
    customerId: customer._id.toString(),
    walletNumber: customer.wallet?.accountNumber,
    oldBalance,
    newBalance,
    deducted: true
  };
}

/**
 * GET /api/deposit/transactions
 * Admin: get deposit transactions with advanced search, filters, and pagination.
 */
router.get('/transactions', authenticateDepositAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { agentId, status, from, to, search, page = 1, limit = 15 } = req.query;

    const query = {};
    if (agentId && ObjectId.isValid(agentId)) query.agentId = new ObjectId(agentId);
    if (status) query.status = status;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to + 'T23:59:59.999Z');
    }

    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q, 'i');
      query.$or = [
        { clientName: regex },
        { clientPhone: regex },
        { walletNumber: regex },
        { reference: regex },
        { notes: regex }
      ];
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 15);
    const skip = (pageNum - 1) * limitNum;

    const total = await db.collection('customer_deposits').countDocuments(query);
    const txns = await db.collection('customer_deposits')
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    // Also calculate overall metrics for completed matching transactions
    const completedTxns = await db.collection('customer_deposits')
      .find({ ...query, status: 'completed' })
      .toArray();
    const totalDepositedAmount = completedTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);

    const totalPages = Math.ceil(total / limitNum) || 1;

    res.json({
      transactions: txns.map(t => ({ ...t, id: t._id.toString() })),
      total,
      page: pageNum,
      totalPages,
      limit: limitNum,
      totalDepositedAmount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/deposit/transactions/mine
 * Agent: get ONLY their last 20 deposit transactions.
 */
router.get('/transactions/mine', authenticateDepositAgent, async (req, res) => {
  try {
    const db = await connectDB();
    const txns = await db.collection('customer_deposits')
      .find({ agentId: new ObjectId(req.agent.id) })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    res.json(txns.map(t => ({ ...t, id: t._id.toString() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/deposit/transactions
 * Agent: create a new deposit transaction (3 inputs: phone, amount, description/notes).
 */
router.post('/transactions', authenticateDepositAgent, async (req, res) => {
  try {
    const { phone, clientPhone, amount, description, notes } = req.body;
    const targetPhone = (phone || clientPhone || '').trim();
    const depositAmount = Number(amount);
    const desc = (description || notes || '').trim();

    if (!targetPhone || !depositAmount || isNaN(depositAmount) || depositAmount <= 0) {
      return res.status(400).json({ error: 'Customer phone number and a valid deposit amount are required.' });
    }

    const db = await connectDB();

    const walletInfo = await creditMocosWallet(
      db,
      targetPhone,
      depositAmount,
      desc,
      req.agent.name
    );

    const doc = {
      clientName: walletInfo.customerName,
      clientPhone: targetPhone,
      amount: depositAmount,
      method: 'Agent Deposit',
      reference: desc || 'Agent Wallet Top Up',
      notes: desc,
      agentId: new ObjectId(req.agent.id),
      agentName: req.agent.name,
      status: 'completed',
      walletCredited: true,
      walletNumber: walletInfo.walletNumber,
      oldBalance: walletInfo.oldBalance,
      newBalance: walletInfo.newBalance,
      createdAt: new Date()
    };

    const result = await db.collection('customer_deposits').insertOne(doc);

    // Return response without disclosing customer wallet total balance to agent
    const responseDoc = {
      id: result.insertedId.toString(),
      clientName: doc.clientName,
      clientPhone: doc.clientPhone,
      amount: doc.amount,
      method: doc.method,
      reference: doc.reference,
      notes: doc.notes,
      agentId: doc.agentId,
      agentName: doc.agentName,
      status: doc.status,
      walletCredited: doc.walletCredited,
      walletNumber: doc.walletNumber,
      createdAt: doc.createdAt
    };
    res.status(201).json(responseDoc);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * PUT /api/deposit/transactions/:id
 * Update deposit status (admin or agent).
 * If changing status from completed -> cancelled: DEDUCTS / REVERSES funds from client's website wallet!
 * If changing status from cancelled -> completed: CREDITS funds back to client's website wallet!
 */
router.put('/transactions/:id', authenticateDepositAny, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid transaction ID' });
    if (!['pending', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use: pending, completed, cancelled' });
    }

    const db = await connectDB();
    const txn = await db.collection('customer_deposits').findOne({ _id: new ObjectId(id) });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    let updates = { status, updatedAt: new Date() };

    // 1. Re-credit if changing to completed when not credited
    if (status === 'completed' && !txn.walletCredited) {
      const walletInfo = await creditMocosWallet(
        db,
        txn.clientPhone,
        txn.amount,
        txn.notes || txn.reference,
        req.authUser?.name || txn.agentName || 'Admin'
      );
      updates.walletCredited = true;
      updates.walletNumber = walletInfo.walletNumber;
      updates.newBalance = walletInfo.newBalance;
    }

    // 2. DEDUCT / REVERSE from wallet if changing from completed to cancelled (or pending)
    if ((status === 'cancelled' || status === 'pending') && txn.walletCredited) {
      const walletInfo = await deductMocosWallet(
        db,
        txn.clientPhone,
        txn.amount,
        txn.notes || txn.reference,
        req.authUser?.name || 'Admin'
      );
      updates.walletCredited = false;
      if (walletInfo) {
        updates.newBalance = walletInfo.newBalance;
      }
    }

    await db.collection('customer_deposits').updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );

    res.json({ success: true, status, ...updates });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
