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

module.exports = {
  router,
  authenticateCustomer,
  normalizePhone
};
