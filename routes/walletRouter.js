const express = require('express');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const { authenticateCustomer, normalizePhone } = require('./customerAuthRouter');
const { broadcastNotification } = require('../utils/notificationEmitter');

const router = express.Router();

/**
 * POST /api/wallet/add-phone
 * Customer adds a recharge phone number to their wallet.
 * STRICT UNIQUENESS RULE: No duplicate phone numbers allowed across the entire system.
 */
router.post('/add-phone', authenticateCustomer, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }

    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 8) {
      return res.status(400).json({ error: 'Please enter a valid phone number (at least 8 digits).' });
    }

    const db = await connectDB();

    // Check if phone number exists ANYWHERE in DB (primary phone or in any wallet.phoneNumbers)
    const existingCustomer = await db.collection('customers').findOne({
      $or: [
        { phone: cleanPhone },
        { 'wallet.phoneNumbers': cleanPhone }
      ]
    });

    if (existingCustomer) {
      const isSelf = existingCustomer._id.toString() === req.customer.id;
      if (isSelf) {
        return res.status(409).json({ error: 'This phone number is already attached to your wallet.' });
      } else {
        return res.status(409).json({ error: 'This phone number is already registered on another customer account.' });
      }
    }

    // Fetch current customer profile to check addition count and wallet balance
    const currentCustomer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });
    if (!currentCustomer) {
      return res.status(404).json({ error: 'Customer account not found.' });
    }

    // addedPhoneCount = total number of times the user has EVER added a phone number (not current count)
    // This persists through removals — removing a number does NOT restore free uses
    const currentAdditionCount = Number(currentCustomer.wallet?.addedPhoneCount || 0);
    const newAdditionCount = currentAdditionCount + 1;

    // First 5 additions are FREE; 6th addition onwards costs 50 TSH
    const isFree = newAdditionCount <= 5;
    const fee = isFree ? 0 : 50;

    const oldBalance = Number(currentCustomer.wallet?.balance || 0);
    const newBalance = oldBalance - fee;

    // Push new number to wallet and update balance and addition count
    await db.collection('customers').updateOne(
      { _id: new ObjectId(req.customer.id) },
      {
        $addToSet: { 'wallet.phoneNumbers': cleanPhone },
        $set: {
          'wallet.balance': newBalance,
          'wallet.addedPhoneCount': newAdditionCount
        }
      }
    );

    // If fee > 0, log transaction in wallet_transactions
    if (fee > 0) {
      await db.collection('wallet_transactions').insertOne({
        customerId: currentCustomer._id.toString(),
        customerName: currentCustomer.fullName,
        walletNumber: currentCustomer.wallet?.accountNumber,
        phoneUsed: cleanPhone,
        primaryPhone: currentCustomer.phone,
        type: 'fee',
        amount: fee,
        oldBalance,
        newBalance,
        description: `Phone Addition Fee (Addition #${newAdditionCount})`,
        performedBy: currentCustomer.fullName,
        createdAt: new Date()
      });
    }

    // Fetch updated wallet
    const updatedCustomer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });

    let returnMessage = '';
    if (isFree) {
      returnMessage = `Phone number added to your wallet for FREE! (${newAdditionCount}/5 free additions used)`;
    } else if (newBalance >= 0) {
      returnMessage = `Phone number added. 50 TSH fee deducted from your wallet balance.`;
    } else {
      returnMessage = `Phone number added. 50 TSH fee debited to your wallet (Current balance: ${newBalance} TZS). Pending debits will be auto-deducted from your next deposit.`;
    }

    res.json({
      success: true,
      message: returnMessage,
      feeDeducted: fee,
      isFree,
      additionCount: newAdditionCount,
      wallet: updatedCustomer.wallet
    });
  } catch (error) {
    console.error('[Add Phone Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/wallet/remove-phone
 * Customer removes a recharge phone number from their wallet.
 */
router.delete('/remove-phone', authenticateCustomer, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }

    const cleanPhone = normalizePhone(phone);
    const db = await connectDB();
    const customer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    // Do not allow removing primary phone number
    if (customer.phone === cleanPhone) {
      return res.status(400).json({ error: 'Cannot remove your primary account phone number.' });
    }

    await db.collection('customers').updateOne(
      { _id: new ObjectId(req.customer.id) },
      { $pull: { 'wallet.phoneNumbers': cleanPhone } }
    );

    const updatedCustomer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });

    res.json({
      success: true,
      message: 'Phone number removed from your wallet.',
      wallet: updatedCustomer.wallet
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/wallet/deposit
 * ADMIN ENDPOINT: Deposit funds into a customer wallet by Phone Number.
 */
router.post('/deposit', async (req, res) => {
  try {
    const { phone, amount, description } = req.body;

    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }

    const depositAmount = parseFloat(amount);
    if (isNaN(depositAmount) || depositAmount <= 0) {
      return res.status(400).json({ error: 'Deposit amount must be a positive number.' });
    }

    const cleanPhone = normalizePhone(phone);
    const db = await connectDB();

    // Find customer by primary phone OR any wallet phone number
    const customer = await db.collection('customers').findOne({
      $or: [
        { phone: cleanPhone },
        { 'wallet.phoneNumbers': cleanPhone }
      ]
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: `No customer account found associated with phone number "${phone}".`
      });
    }

    const oldBalance = Number(customer.wallet?.balance || 0);
    const newBalance = oldBalance + depositAmount;
    const hasOutstandingDebit = oldBalance < 0;
    const clearedDebitAmount = hasOutstandingDebit ? Math.min(Math.abs(oldBalance), depositAmount) : 0;

    // Update customer wallet balance in database
    await db.collection('customers').updateOne(
      { _id: customer._id },
      { $set: { 'wallet.balance': newBalance } }
    );

    let txDescription = description || 'Admin Customer Deposit';
    if (hasOutstandingDebit) {
      txDescription += ` (TZS ${clearedDebitAmount.toLocaleString()} auto-deducted to clear outstanding debits)`;
    }

    // Create deposit transaction record
    const transaction = {
      customerId: customer._id.toString(),
      customerName: customer.fullName,
      walletNumber: customer.wallet?.accountNumber,
      phoneUsed: cleanPhone,
      primaryPhone: customer.phone,
      type: 'deposit',
      amount: depositAmount,
      oldBalance,
      newBalance,
      description: txDescription,
      performedBy: 'Admin',
      createdAt: new Date()
    };

    const txResult = await db.collection('wallet_transactions').insertOne(transaction);

    // Trigger SSE / Web Push notification
    broadcastNotification({
      type: 'deposit',
      title: '💰 Wallet Recharged',
      message: `Deposit of ${depositAmount.toLocaleString()} TZS credited to ${customer.fullName} (Wallet #${customer.wallet?.accountNumber}).`,
      link: '/customer-deposit'
    });

    res.json({
      success: true,
      message: 'Deposit credited successfully!',
      transactionId: txResult.insertedId.toString(),
      deposit: {
        customerName: customer.fullName,
        walletNumber: customer.wallet?.accountNumber,
        phoneUsed: cleanPhone,
        primaryPhone: customer.phone,
        oldBalance,
        depositedAmount: depositAmount,
        newBalance,
        description: transaction.description,
        createdAt: transaction.createdAt
      }
    });
  } catch (error) {
    console.error('[Admin Deposit Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/wallet/deposits
 * ADMIN ENDPOINT: Fetch list of all deposit transactions for Admin DataTable view
 */
router.get('/deposits', async (req, res) => {
  try {
    const db = await connectDB();
    const deposits = await db
      .collection('wallet_transactions')
      .find()
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    res.json(
      deposits.map((d) => ({
        id: d._id.toString(),
        customerName: d.customerName,
        walletNumber: d.walletNumber,
        phoneUsed: d.phoneUsed,
        amount: d.amount,
        oldBalance: d.oldBalance,
        newBalance: d.newBalance,
        description: d.description,
        createdAt: d.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/wallet/my-transactions
 * Customer endpoint: Fetch transactions for logged-in user
 */
router.get('/my-transactions', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();
    const transactions = await db
      .collection('wallet_transactions')
      .find({ customerId: req.customer.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    res.json(
      transactions.map((t) => ({
        id: t._id.toString(),
        type: t.type,
        amount: t.amount,
        newBalance: t.newBalance,
        description: t.description,
        createdAt: t.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

/**
 * POST /api/wallet/cancel-deposit
 * ADMIN ENDPOINT: Cancel a customer deposit and deduct funds from customer's wallet balance.
 */
router.post('/cancel-deposit', async (req, res) => {
  try {
    const { transactionId } = req.body;
    if (!transactionId || !ObjectId.isValid(transactionId)) {
      return res.status(400).json({ error: 'Valid transaction ID is required.' });
    }

    const db = await connectDB();

    let tx = await db.collection('wallet_transactions').findOne({ _id: new ObjectId(transactionId) });
    let isFromWalletTx = true;

    if (!tx) {
      tx = await db.collection('customer_deposits').findOne({ _id: new ObjectId(transactionId) });
      isFromWalletTx = false;
    }

    if (!tx) {
      return res.status(404).json({ error: 'Transaction record not found.' });
    }

    if (tx.status === 'cancelled' || tx.reversed) {
      return res.status(400).json({ error: 'This deposit has already been cancelled.' });
    }

    const amountToDeduct = Math.abs(Number(tx.amount || 0));
    const customerPhone = tx.phoneUsed || tx.primaryPhone || tx.clientPhone;

    let customer = null;
    if (tx.customerId && ObjectId.isValid(tx.customerId)) {
      customer = await db.collection('customers').findOne({ _id: new ObjectId(tx.customerId) });
    }
    if (!customer && customerPhone) {
      const cleanPhone = normalizePhone(customerPhone);
      customer = await db.collection('customers').findOne({
        $or: [{ phone: cleanPhone }, { 'wallet.phoneNumbers': cleanPhone }]
      });
    }

    if (!customer) {
      return res.status(404).json({ error: 'Associated customer wallet account not found.' });
    }

    const oldBalance = Number(customer.wallet?.balance || 0);
    const newBalance = Math.max(0, oldBalance - amountToDeduct);

    await db.collection('customers').updateOne(
      { _id: customer._id },
      { $set: { 'wallet.balance': newBalance } }
    );

    if (isFromWalletTx) {
      await db.collection('wallet_transactions').updateOne(
        { _id: tx._id },
        { $set: { status: 'cancelled', reversed: true, cancelledAt: new Date() } }
      );
    } else {
      await db.collection('customer_deposits').updateOne(
        { _id: tx._id },
        { $set: { status: 'cancelled', walletCredited: false, cancelledAt: new Date() } }
      );
    }

    const reversalTx = {
      customerId: customer._id.toString(),
      customerName: customer.fullName,
      walletNumber: customer.wallet?.accountNumber,
      phoneUsed: customerPhone,
      primaryPhone: customer.phone,
      type: 'reversal',
      amount: -amountToDeduct,
      oldBalance,
      newBalance,
      description: `Deposit Cancelled (Admin) - Ref: ${tx.description || tx.reference || 'Cancellation'}`,
      performedBy: 'Admin',
      status: 'cancelled',
      createdAt: new Date()
    };
    await db.collection('wallet_transactions').insertOne(reversalTx);

    try {
      broadcastNotification({
        type: 'reversal',
        title: '⚠️ Wallet Reversal',
        message: `Deposit of TZS ${amountToDeduct.toLocaleString()} cancelled for ${customer.fullName} (Wallet #${customer.wallet?.accountNumber}).`,
        link: '/customer-deposit'
      });
    } catch (e) {}

    res.json({
      success: true,
      message: `Deposit of TZS ${amountToDeduct.toLocaleString()} cancelled. TZS ${amountToDeduct.toLocaleString()} deducted from ${customer.fullName}'s wallet.`,
      newBalance
    });
  } catch (error) {
    console.error('[Admin Cancel Deposit Error]:', error);
    res.status(500).json({ error: error.message });
  }
});
