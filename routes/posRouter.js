const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authenticateBranchStaff(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired session token' });
    if (!user.role && (user.username || user.id)) {
      user.role = 'Admin';
    }
    req.staff = user;
    next();
  });
}

function authenticateAny(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token || token === 'null' || token === 'undefined') return next();
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired session token' });
    if (!user.role && (user.username || user.id)) {
      user.role = 'Admin';
    }
    req.staff = user;
    next();
  });
}

function generateReceiptNo() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `POS-${ymd}-${rand}`;
}

function generatePONo() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PO-${ymd}-${rand}`;
}

// ─── Granular Permission Helpers ─────────────────────────────────────────────
// Admin (isAdminViewing), Partner, and Manager always have full access.
// Other roles check their specific permissions object from the JWT.
function hasInventoryPermission(staff) {
  if (!staff) return false;
  const r = (staff.role || '').toLowerCase();
  if (r === 'admin' || r === 'partner' || r === 'manager') return true;
  return staff.permissions?.canManageInventory === true;
}

function hasSalesPermission(staff) {
  if (!staff) return false;
  const r = (staff.role || '').toLowerCase();
  if (r === 'admin' || r === 'partner' || r === 'manager') return true;
  return staff.permissions?.canPerformSales === true;
}

function hasPurchasePermission(staff) {
  if (!staff) return false;
  const r = (staff.role || '').toLowerCase();
  if (r === 'admin' || r === 'partner' || r === 'manager') return true;
  return staff.permissions?.canManagePurchases === true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/categories', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    let cats = await db.collection('pos_categories').find().sort({ name: 1 }).toArray();
    if (cats.length === 0) {
      const defaults = [
        'Smartphones & Devices', 'Spare Parts & Displays', 'Repair Tools',
        'Accessories & Chargers', 'Screen Protectors', 'Cables & Adapters',
        'Batteries', 'General'
      ].map(name => ({ name, createdAt: new Date() }));
      await db.collection('pos_categories').insertMany(defaults);
      cats = await db.collection('pos_categories').find().sort({ name: 1 }).toArray();
    }
    res.json(cats.map(c => ({ id: c._id.toString(), name: c.name })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/categories', authenticateBranchStaff, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
    const db = await connectDB();
    const existing = await db.collection('pos_categories').findOne({ name: { $regex: new RegExp('^' + name.trim() + '$', 'i') } });
    if (existing) return res.status(400).json({ error: 'Category already exists' });
    const result = await db.collection('pos_categories').insertOne({ name: name.trim(), createdAt: new Date() });
    res.status(201).json({ id: result.insertedId.toString(), name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/products', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const filter = {};
    if (req.query.category && req.query.category !== 'All') filter.category = req.query.category;

    const conditions = [];
    if (req.query.search) {
      conditions.push({
        $or: [
          { name: { $regex: req.query.search.trim(), $options: 'i' } },
          { sku: { $regex: req.query.search.trim(), $options: 'i' } },
          { barcode: { $regex: req.query.search.trim(), $options: 'i' } },
        ]
      });
    }

    if (req.staff?.partnerId) {
      conditions.push({
        $or: [
          { partnerId: req.staff.partnerId },
          { partnerId: { $exists: false }, branchId: { $exists: false } },
          { partnerId: null, branchId: null }
        ]
      });
    } else if (req.staff?.branchId) {
      conditions.push({
        $or: [
          { branchId: req.staff.branchId },
          { branchId: req.staff.branchId.toString() },
          { partnerId: { $exists: false }, branchId: { $exists: false } },
          { partnerId: null, branchId: null }
        ]
      });
    }

    if (conditions.length === 1) {
      Object.assign(filter, conditions[0]);
    } else if (conditions.length > 1) {
      filter.$and = conditions;
    }

    const products = await db.collection('pos_products').find(filter).sort({ createdAt: -1 }).toArray();
    res.json(products.map(p => ({
      id: p._id.toString(),
      name: p.name,
      sku: p.sku || '',
      barcode: p.barcode || '',
      category: p.category || 'General',
      price: p.price || 0,
      costPrice: p.costPrice || 0,
      stock: p.stock || 0,
      lowStockThreshold: p.lowStockThreshold || 5,
      unit: p.unit || 'pcs',
      description: p.description || '',
      isActive: p.isActive !== false,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products/:id', authenticateAny, async (req, res) => {
  try {
    const db = await connectDB();
    const p = await db.collection('pos_products').findOne({ _id: new ObjectId(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json({ id: p._id.toString(), name: p.name, sku: p.sku || '', barcode: p.barcode || '', category: p.category || 'General', price: p.price || 0, costPrice: p.costPrice || 0, stock: p.stock || 0, lowStockThreshold: p.lowStockThreshold || 5, unit: p.unit || 'pcs', description: p.description || '', isActive: p.isActive !== false, createdAt: p.createdAt, updatedAt: p.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/products', authenticateBranchStaff, async (req, res) => {
  try {
    if (!hasInventoryPermission(req.staff)) {
      return res.status(403).json({ error: 'You do not have permission to add products to inventory.' });
    }
    const { name, sku, barcode, category, price, costPrice, stock, lowStockThreshold, unit, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Valid price is required' });
    const db = await connectDB();
    if (sku && sku.trim()) {
      const existing = await db.collection('pos_products').findOne({ sku: sku.trim().toUpperCase() });
      if (existing) return res.status(400).json({ error: 'SKU already exists' });
    }
    const doc = {
      name: name.trim(),
      sku: sku ? sku.trim().toUpperCase() : '',
      barcode: barcode ? barcode.trim() : '',
      category: category ? category.trim() : 'General',
      price: priceNum,
      costPrice: parseFloat(costPrice) || 0,
      stock: parseInt(stock, 10) || 0,
      lowStockThreshold: parseInt(lowStockThreshold, 10) || 5,
      unit: unit ? unit.trim() : 'pcs',
      description: description || '',
      isActive: true,
      branchId: req.staff?.branchId || null,
      branchName: req.staff?.branchName || '',
      partnerId: req.staff?.partnerId || null,
      partnerName: req.staff?.partnerName || '',
      createdBy: req.staff ? (req.staff.id || req.staff.staffId || '') : 'system',
      createdAt: new Date(),
    };
    const result = await db.collection('pos_products').insertOne(doc);
    res.status(201).json({ success: true, message: 'Product added to inventory', id: result.insertedId.toString(), ...doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/products/:id', authenticateBranchStaff, async (req, res) => {
  try {
    if (!hasInventoryPermission(req.staff)) {
      return res.status(403).json({ error: 'You do not have permission to edit products.' });
    }
    const db = await connectDB();
    const existing = await db.collection('pos_products').findOne({ _id: new ObjectId(req.params.id) });
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const { name, sku, barcode, category, price, costPrice, stock, lowStockThreshold, unit, description, isActive } = req.body;
    const updates = { updatedAt: new Date() };
    if (name && name.trim()) updates.name = name.trim();
    if (category !== undefined) updates.category = category ? category.trim() : 'General';
    if (description !== undefined) updates.description = description;
    if (unit !== undefined) updates.unit = unit || 'pcs';
    if (isActive !== undefined) updates.isActive = isActive !== false && isActive !== 'false';
    if (price !== undefined) { const p = parseFloat(price); if (!isNaN(p) && p >= 0) updates.price = p; }
    if (costPrice !== undefined) { const cp = parseFloat(costPrice); if (!isNaN(cp) && cp >= 0) updates.costPrice = cp; }
    if (stock !== undefined) { const s = parseInt(stock, 10); if (!isNaN(s) && s >= 0) updates.stock = s; }
    if (lowStockThreshold !== undefined) { const t = parseInt(lowStockThreshold, 10); if (!isNaN(t) && t >= 0) updates.lowStockThreshold = t; }
    if (sku !== undefined) {
      const cleanSku = sku ? sku.trim().toUpperCase() : '';
      if (cleanSku && cleanSku !== existing.sku) {
        const skuDup = await db.collection('pos_products').findOne({ sku: cleanSku, _id: { $ne: existing._id } });
        if (skuDup) return res.status(400).json({ error: 'SKU already exists' });
      }
      updates.sku = cleanSku;
    }
    if (barcode !== undefined) updates.barcode = barcode ? barcode.trim() : '';
    await db.collection('pos_products').updateOne({ _id: existing._id }, { $set: updates });
    const updated = await db.collection('pos_products').findOne({ _id: existing._id });
    res.json({ success: true, message: 'Product updated', product: { id: updated._id.toString(), name: updated.name, sku: updated.sku || '', barcode: updated.barcode || '', category: updated.category, price: updated.price, costPrice: updated.costPrice, stock: updated.stock, lowStockThreshold: updated.lowStockThreshold, unit: updated.unit, description: updated.description, isActive: updated.isActive, createdAt: updated.createdAt, updatedAt: updated.updatedAt } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/products/:id', authenticateBranchStaff, async (req, res) => {
  try {
    if (!hasInventoryPermission(req.staff)) {
      return res.status(403).json({ error: 'You do not have permission to remove products.' });
    }
    const db = await connectDB();
    const p = await db.collection('pos_products').findOne({ _id: new ObjectId(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Product not found' });
    await db.collection('pos_products').deleteOne({ _id: p._id });
    res.json({ success: true, message: 'Product removed from inventory' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POS SALES
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/sales', authenticateBranchStaff, async (req, res) => {
  try {
    if (!hasSalesPermission(req.staff)) {
      return res.status(403).json({ error: 'You do not have permission to perform sales.' });
    }
    const { items, paymentMethod, customerName, customerPhone, discount, notes } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
    if (!paymentMethod) return res.status(400).json({ error: 'Payment method is required' });
    const db = await connectDB();
    const saleItems = [];
    let subtotal = 0;
    for (const item of items) {
      if (!item.productId || !item.qty || item.qty <= 0) return res.status(400).json({ error: 'Invalid item in cart' });
      const product = await db.collection('pos_products').findOne({ _id: new ObjectId(item.productId) });
      if (!product) return res.status(404).json({ error: 'Product not found in inventory' });
      if (!product.isActive) return res.status(400).json({ error: 'Product is not available for sale' });
      if (product.stock < item.qty) return res.status(400).json({ error: 'Insufficient stock for ' + product.name + '. Available: ' + product.stock });
      const unitPrice = parseFloat(item.unitPrice) || product.price;
      const lineTotal = unitPrice * item.qty;
      subtotal += lineTotal;
      saleItems.push({ productId: product._id.toString(), productName: product.name, sku: product.sku || '', qty: item.qty, unitPrice, costPrice: product.costPrice || 0, lineTotal });
    }
    const discountAmount = parseFloat(discount) || 0;
    const total = Math.max(0, subtotal - discountAmount);
    const receiptNo = generateReceiptNo();
    for (const item of saleItems) {
      await db.collection('pos_products').updateOne({ _id: new ObjectId(item.productId) }, { $inc: { stock: -item.qty }, $set: { updatedAt: new Date() } });
    }
    const saleDoc = {
      receiptNo,
      items: saleItems,
      subtotal,
      discountAmount,
      total,
      paymentMethod,
      customerName: customerName || 'Walk-in Customer',
      customerPhone: customerPhone || '',
      notes: notes || '',
      staffId: req.staff ? (req.staff.id || req.staff.staffId || '') : '',
      staffName: req.staff ? (req.staff.fullName || req.staff.name || '') : '',
      branchId: req.staff?.branchId || null,
      branchName: req.staff?.branchName || '',
      partnerId: req.staff?.partnerId || null,
      partnerName: req.staff?.partnerName || '',
      status: 'completed',
      createdAt: new Date()
    };
    const result = await db.collection('pos_sales').insertOne(saleDoc);
    res.status(201).json({ success: true, message: 'Sale completed! Receipt: ' + receiptNo, receiptNo, saleId: result.insertedId.toString(), total, subtotal, discountAmount, items: saleItems });
  } catch (err) {
    console.error('[POS Sale Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sales', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const filter = {};
    const conditions = [];

    if (req.query.search) {
      const q = req.query.search.trim();
      conditions.push({
        $or: [
          { receiptNo: { $regex: q, $options: 'i' } },
          { customerName: { $regex: q, $options: 'i' } },
          { customerPhone: { $regex: q, $options: 'i' } }
        ]
      });
    }

    if (req.staff?.partnerId) {
      conditions.push({ partnerId: req.staff.partnerId });
    } else if (req.staff?.branchId) {
      conditions.push({
        $or: [{ branchId: req.staff.branchId }, { branchId: req.staff.branchId.toString() }]
      });
    }

    if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }

    if (conditions.length === 1) {
      Object.assign(filter, conditions[0]);
    } else if (conditions.length > 1) {
      filter.$and = conditions;
    }

    const limit = parseInt(req.query.limit, 10) || 100;
    const sales = await db.collection('pos_sales').find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json(sales.map(s => ({ id: s._id.toString(), receiptNo: s.receiptNo, items: s.items, subtotal: s.subtotal, discountAmount: s.discountAmount, total: s.total, paymentMethod: s.paymentMethod, customerName: s.customerName, customerPhone: s.customerPhone, notes: s.notes, staffName: s.staffName, branchName: s.branchName, status: s.status, createdAt: s.createdAt })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();

    // Only Admin (or Partner) can view branch sales summary report
    const staffRole = (req.staff?.role || '').toLowerCase();
    if (staffRole !== 'admin' && staffRole !== 'partner') {
      return res.status(403).json({ error: 'Access denied. Only administrators and partners can view sales reports.' });
    }

    const period = req.query.period || 'all';
    let dateQuery = { status: 'completed' };

    if (req.staff?.partnerId) {
      dateQuery.partnerId = req.staff.partnerId;
    } else if (req.staff?.branchId) {
      dateQuery.$or = [{ branchId: req.staff.branchId }, { branchId: req.staff.branchId.toString() }];
    }

    if (req.query.dateFrom || req.query.dateTo) {
      dateQuery.createdAt = {};
      if (req.query.dateFrom) dateQuery.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        to.setHours(23, 59, 59, 999);
        dateQuery.createdAt.$lte = to;
      }
    } else if (period !== 'all') {
      let dateFrom = new Date();
      if (period === 'today') {
        dateFrom.setHours(0, 0, 0, 0);
      } else if (period === 'this_week' || period === 'week') {
        const day = dateFrom.getDay();
        const diff = (day === 0 ? -6 : 1) - day;
        dateFrom = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), dateFrom.getDate() + diff, 0, 0, 0, 0);
      } else if (period === 'this_month' || period === 'month') {
        dateFrom = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), 1, 0, 0, 0, 0);
      } else if (period === 'this_year' || period === 'year') {
        dateFrom = new Date(dateFrom.getFullYear(), 0, 1, 0, 0, 0, 0);
      }
      dateQuery.createdAt = { $gte: dateFrom };
    }
    const sales = await db.collection('pos_sales').find(dateQuery).toArray();
    const totalRevenue = sales.reduce((s, x) => s + (x.total || 0), 0);
    const totalTransactions = sales.length;
    const totalItems = sales.reduce((s, x) => s + x.items.reduce((is, i) => is + i.qty, 0), 0);
    const avgTicket = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;
    const paymentBreakdown = {};
    for (const s of sales) { paymentBreakdown[s.paymentMethod] = (paymentBreakdown[s.paymentMethod] || 0) + s.total; }
    const productMap = {};
    for (const s of sales) { for (const item of s.items) { if (!productMap[item.productId]) productMap[item.productId] = { name: item.productName, qty: 0, revenue: 0 }; productMap[item.productId].qty += item.qty; productMap[item.productId].revenue += item.lineTotal; } }
    const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    res.json({ period, totalRevenue, totalTransactions, totalItems, avgTicket, paymentBreakdown, topProducts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PURCHASE / RESTOCK ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/purchase-orders', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const filter = {};
    const conditions = [];

    if (req.query.status) conditions.push({ status: req.query.status });
    if (req.query.search) {
      const q = req.query.search.trim();
      conditions.push({ $or: [{ poNumber: { $regex: q, $options: 'i' } }, { supplier: { $regex: q, $options: 'i' } }] });
    }

    if (req.staff?.partnerId) {
      conditions.push({ partnerId: req.staff.partnerId });
    } else if (req.staff?.branchId) {
      conditions.push({
        $or: [{ branchId: req.staff.branchId }, { branchId: req.staff.branchId.toString() }]
      });
    }

    if (conditions.length === 1) {
      Object.assign(filter, conditions[0]);
    } else if (conditions.length > 1) {
      filter.$and = conditions;
    }

    const orders = await db.collection('pos_purchase_orders').find(filter).sort({ createdAt: -1 }).toArray();
    res.json(orders.map(o => ({ id: o._id.toString(), poNumber: o.poNumber, supplier: o.supplier, supplierContact: o.supplierContact || '', items: o.items, subtotal: o.subtotal, totalCost: o.totalCost, shippingCost: o.shippingCost || 0, notes: o.notes || '', status: o.status, expectedDelivery: o.expectedDelivery, receivedAt: o.receivedAt, staffName: o.staffName, branchName: o.branchName, createdAt: o.createdAt, updatedAt: o.updatedAt })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/purchase-orders', authenticateBranchStaff, async (req, res) => {
  try {
    if (!hasPurchasePermission(req.staff)) {
      return res.status(403).json({ error: 'You do not have permission to create purchase orders.' });
    }
    const { supplier, supplierContact, items, shippingCost, expectedDelivery, notes } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });
    const db = await connectDB();
    const orderItems = [];
    let subtotal = 0;
    for (const item of items) {
      const unitCost = parseFloat(item.unitCost) || 0;
      const qty = parseInt(item.qty, 10) || 1;
      const lineTotal = unitCost * qty;
      subtotal += lineTotal;
      let productName = item.productName || '';
      if (item.productId) { try { const prod = await db.collection('pos_products').findOne({ _id: new ObjectId(item.productId) }); if (prod) productName = prod.name; } catch (_) {} }
      orderItems.push({ productId: item.productId || null, productName, qty, unitCost, lineTotal });
    }
    const shipping = parseFloat(shippingCost) || 0;
    const totalCost = subtotal + shipping;
    const poNumber = generatePONo();
    const cleanSupplier = (supplier && typeof supplier === 'string') ? supplier.trim() : '';
    const doc = {
      poNumber,
      supplier: cleanSupplier,
      supplierContact: supplierContact || '',
      items: orderItems,
      subtotal,
      shippingCost: shipping,
      totalCost,
      expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : null,
      notes: notes || '',
      status: 'Pending',
      staffId: req.staff ? (req.staff.id || req.staff.staffId || '') : '',
      staffName: req.staff ? (req.staff.fullName || req.staff.name || '') : '',
      branchId: req.staff?.branchId || null,
      branchName: req.staff?.branchName || '',
      partnerId: req.staff?.partnerId || null,
      partnerName: req.staff?.partnerName || '',
      createdAt: new Date()
    };
    const result = await db.collection('pos_purchase_orders').insertOne(doc);
    res.status(201).json({ success: true, message: 'Purchase order ' + poNumber + ' created', id: result.insertedId.toString(), poNumber, totalCost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/purchase-orders/:id/status', authenticateBranchStaff, async (req, res) => {
  try {
    if (!hasPurchasePermission(req.staff)) {
      return res.status(403).json({ error: 'You do not have permission to update purchase orders.' });
    }
    const { status, receivedItems } = req.body;
    const validStatuses = ['Pending', 'Ordered', 'Received', 'Cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const db = await connectDB();
    const po = await db.collection('pos_purchase_orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status === 'Received') return res.status(400).json({ error: 'Order already received' });
    const updates = { status, updatedAt: new Date() };
    if (status === 'Received') {
      updates.receivedAt = new Date();
      const itemsToReceive = receivedItems || po.items;
      for (const item of itemsToReceive) {
        if (!item.productId) continue;
        const qtyReceived = parseInt(item.qtyReceived || item.qty, 10);
        if (qtyReceived <= 0) continue;
        try { await db.collection('pos_products').updateOne({ _id: new ObjectId(item.productId) }, { $inc: { stock: qtyReceived }, $set: { updatedAt: new Date() } }); } catch (_) {}
      }
      await db.collection('pos_stock_logs').insertOne({ type: 'restock', poNumber: po.poNumber, supplier: po.supplier, items: itemsToReceive, receivedAt: new Date(), staffId: req.staff ? (req.staff.id || req.staff.staffId || '') : '', staffName: req.staff ? (req.staff.fullName || req.staff.name || '') : '' });
    }
    await db.collection('pos_purchase_orders').updateOne({ _id: po._id }, { $set: updates });
    res.json({ success: true, message: 'Purchase order ' + po.poNumber + ' marked as ' + status, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/purchase-orders/:id', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const po = await db.collection('pos_purchase_orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!['Pending', 'Cancelled'].includes(po.status)) return res.status(400).json({ error: 'Only Pending or Cancelled orders can be deleted' });
    await db.collection('pos_purchase_orders').deleteOne({ _id: po._id });
    res.json({ success: true, message: 'Purchase order deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stock-adjust', authenticateBranchStaff, async (req, res) => {
  try {
    if (!hasInventoryPermission(req.staff)) {
      return res.status(403).json({ error: 'You do not have permission to adjust stock.' });
    }
    const { productId, adjustment, reason } = req.body;
    if (!productId) return res.status(400).json({ error: 'Product ID is required' });
    const adj = parseInt(adjustment, 10);
    if (isNaN(adj) || adj === 0) return res.status(400).json({ error: 'Adjustment must be a non-zero integer' });
    const db = await connectDB();
    const product = await db.collection('pos_products').findOne({ _id: new ObjectId(productId) });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const newStock = Math.max(0, (product.stock || 0) + adj);
    await db.collection('pos_products').updateOne({ _id: product._id }, { $set: { stock: newStock, updatedAt: new Date() } });
    await db.collection('pos_stock_logs').insertOne({ type: 'adjustment', productId, productName: product.name, adjustment: adj, previousStock: product.stock, newStock, reason: reason || 'Manual adjustment', staffId: req.staff ? (req.staff.id || req.staff.staffId || '') : '', staffName: req.staff ? (req.staff.fullName || req.staff.name || '') : '', receivedAt: new Date() });
    res.json({ success: true, message: 'Stock updated for ' + product.name, newStock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stock-logs', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const logs = await db.collection('pos_stock_logs').find({}).sort({ receivedAt: -1 }).limit(100).toArray();
    res.json(logs.map(l => ({ id: l._id.toString(), type: l.type, poNumber: l.poNumber, supplier: l.supplier, productId: l.productId, productName: l.productName, adjustment: l.adjustment, previousStock: l.previousStock, newStock: l.newStock, reason: l.reason, items: l.items, staffName: l.staffName, receivedAt: l.receivedAt })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
