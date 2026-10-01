const express = require('express');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const connectDB = require('../utils/db');
const config = require('../config');
const { broadcastNotification } = require('../utils/notificationEmitter');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// ── JWT Authentication Middleware ─────────────────────────────────
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

// ── Helper: Generate unique 10-digit tracking ID ──────────────────
async function generateTrackingId(db) {
  let trackingId;
  let exists = true;
  while (exists) {
    trackingId = '';
    for (let i = 0; i < 10; i++) {
      trackingId += Math.floor(Math.random() * 10).toString();
    }
    // Ensure it doesn't start with 0
    if (trackingId[0] === '0') trackingId = (Math.floor(Math.random() * 9) + 1).toString() + trackingId.slice(1);
    const found = await db.collection('service_requests').findOne({ trackingId });
    exists = !!found;
  }
  return trackingId;
}

// ── Helper: Seed default device types if empty ────────────────────
async function seedDefaults(db) {
  const count = await db.collection('device_types').countDocuments();
  if (count === 0) {
    await db.collection('device_types').insertMany([
      { name: 'Smartphone', createdAt: new Date() },
      { name: 'Tablet', createdAt: new Date() },
      { name: 'Laptop/Desktop', createdAt: new Date() },
    ]);
  }

  const catCount = await db.collection('service_categories').countDocuments();
  if (catCount === 0) {
    await db.collection('service_categories').insertMany([
      { name: 'Software', createdAt: new Date() },
      { name: 'Hardware', createdAt: new Date() },
    ]);
  }
}

// ═══════════════════════════════════════════════════════════════════
// FINANCIAL SUMMARY & TRANSACTIONS — Branch/Partner Dashboard
// ═══════════════════════════════════════════════════════════════════

// GET /financial-summary — Revenue created, expenses, net profit & transactions for logged-in branch or partner
router.get('/financial-summary', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();

    // STRICT: Only Admin or Partner can view financial reports for a branch
    if (req.staff.role !== 'Admin' && req.staff.role !== 'Partner') {
      return res.status(403).json({ error: 'Access denied. Only branch administrators can view branch financial reports.' });
    }

    const filter = {};
    let userEntityId = null;

    if (req.staff.role === 'Partner') {
      userEntityId = (req.staff.partnerId || req.staff.id).toString();
      filter.$or = [
        { partnerId: userEntityId },
        { 'registeredBy.id': userEntityId },
        { 'escalation.escalatedBy.partnerId': userEntityId },
        { 'escalation.escalatedBy.id': userEntityId }
      ];
    } else if (req.staff.branchId) {
      userEntityId = req.staff.branchId.toString();
      const branchObjId = ObjectId.isValid(userEntityId) ? new ObjectId(userEntityId) : null;
      filter.$or = [
        { branchId: userEntityId },
        ...(branchObjId ? [{ branchId: branchObjId }] : []),
        { 'escalation.escalatedBy.branchId': userEntityId },
        { 'escalation.escalatedBy.id': userEntityId }
      ];
    }

    // ─── Advanced Date Filtering ─────────────────────────────────────
    const period = req.query.period || 'all';
    let dateFilter = null;
    const now = new Date();

    if (req.query.dateFrom || req.query.dateTo) {
      dateFilter = {};
      if (req.query.dateFrom) dateFilter.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        to.setHours(23, 59, 59, 999);
        dateFilter.$lte = to;
      }
    } else if (period && period !== 'all') {
      let from = new Date();
      if (period === 'today') {
        from.setHours(0, 0, 0, 0);
      } else if (period === 'this_week' || period === 'week') {
        const day = now.getDay();
        const diff = (day === 0 ? -6 : 1) - day;
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0, 0);
      } else if (period === 'this_month' || period === 'month') {
        from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      } else if (period === 'this_year' || period === 'year') {
        from = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      }
      dateFilter = { $gte: from };
    }

    if (dateFilter) {
      filter.createdAt = dateFilter;
    }

    const requests = await db.collection('service_requests').find(filter).sort({ createdAt: -1 }).toArray();
    const summary = computeFinancials(requests, userEntityId);
    summary.period = period;
    res.json(summary);
  } catch (error) {
    console.error('Error fetching financial summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Helper: compute financial summary from an array of requests ────
function computeFinancials(requests, targetEntityId = null) {
  let totalRevenue = 0, totalExpenses = 0, partnerTotalPayout = 0, adminTotalFee = 0, paidJobs = 0, unpaidJobs = 0;
  const transactions = requests.map((r) => {
    const cards = r.serviceCards || [];
    let revenue = r.totalCost || cards.reduce((sum, c) => sum + (c.spareCost || 0) + (c.serviceCost || 0), 0);
    const expenses = r.repairExpense !== undefined ? r.repairExpense : cards.reduce((sum, c) => sum + (c.spareCostExpense || 0) + (c.serviceCostExpense || 0), 0);

    let partnerPayout = 0;
    let adminFee = r.escalation?.adminFee || r.adminFee || 0;
    if (r.escalation?.isEscalated || r.escalation?.adminFee !== undefined) {
      const pAFee = r.escalation.partnerAFee || 0;
      const pBFee = r.escalation.partnerBFee !== undefined
        ? r.escalation.partnerBFee
        : Math.max(0, revenue - pAFee - adminFee);

      if (targetEntityId) {
        const targetIdStr = targetEntityId.toString();
        const isPartnerA = (
          r.escalation?.escalatedBy?.partnerId?.toString() === targetIdStr ||
          r.escalation?.escalatedBy?.id?.toString() === targetIdStr ||
          r.escalation?.escalatedBy?.branchId?.toString() === targetIdStr
        );
        const isPartnerB = (
          r.partnerId?.toString() === targetIdStr ||
          r.branchId?.toString() === targetIdStr
        );

        if (isPartnerA && isPartnerB) {
          partnerPayout = pAFee + pBFee;
        } else if (isPartnerA) {
          partnerPayout = pAFee;
          revenue = pAFee;
        } else if (isPartnerB) {
          partnerPayout = pBFee;
          revenue = pBFee;
        } else {
          partnerPayout = pBFee;
        }
      } else {
        partnerPayout = pAFee + pBFee;
      }
    } else {
      partnerPayout = r.partnerPayout !== undefined ? r.partnerPayout : revenue;
    }

    const netProfit = revenue - expenses;

    if (r.paymentStatus === 'paid') {
      totalRevenue += revenue;
      totalExpenses += expenses;
      partnerTotalPayout += partnerPayout;
      adminTotalFee += adminFee;
      paidJobs++;
    } else {
      unpaidJobs++;
    }

    return {
      id: r._id.toString(),
      trackingId: r.trackingId,
      customerName: r.customerInfo?.fullName || 'Customer',
      customerPhone: r.customerInfo?.phoneNumber || '',
      deviceInfo: `${r.deviceInfo?.brandName || ''} ${r.deviceInfo?.model || ''}`.trim(),
      deviceType: r.deviceInfo?.deviceType || 'Device',
      categories: Array.from(new Set(cards.map((c) => c.category).filter(Boolean))).join(', ') || (r.isPartnerEscalation ? 'Partner Escalation' : 'General Service'),
      faults: cards.map((c) => c.fault).join('; ') || r.deviceInfo?.problemDescription || '-',
      branchName: r.branchName || null,
      partnerName: r.partnerName || null,
      revenue,
      expenses,
      netProfit,
      partnerPayout,
      adminFee,
      isPartnerEscalation: !!r.isPartnerEscalation,
      paymentStatus: r.paymentStatus || 'unpaid',
      status: r.status || 'pending_diagnosis',
      createdAt: r.createdAt,
      paidAt: r.paidAt,
    };
  });

  return {
    totalRevenue,
    totalExpenses,
    netProfit: totalRevenue - totalExpenses,
    partnerTotalPayout,
    adminTotalFee,
    totalJobs: requests.length,
    paidJobs,
    unpaidJobs,
    transactions,
  };
}

// ── Admin middleware (reuses same JWT_SECRET as dataRouter) ─────────
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    if (!user.role) user.role = 'Admin';
    req.user = user;
    req.staff = user;
    next();
  });
}

// GET /admin/financial-summary — Admin: see revenue for all, a branch, or a partner
// Query params: ?branchId=xxx  OR  ?partnerId=xxx  OR  nothing (all)
router.get('/admin/financial-summary', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { branchId, partnerId } = req.query;

    const filter = {};
    if (partnerId) {
      filter.$or = [
        { partnerId },
        { 'escalation.escalatedBy.partnerId': partnerId },
        { 'escalation.escalatedBy.id': partnerId }
      ];
    } else if (branchId) {
      filter.$or = [
        { branchId },
        { 'escalation.escalatedBy.branchId': branchId },
        { 'escalation.escalatedBy.id': branchId }
      ];
    }

    const targetEntityId = partnerId || branchId || null;
    const requests = await db.collection('service_requests').find(filter).sort({ createdAt: -1 }).toArray();
    const summary = computeFinancials(requests, targetEntityId);

    if (!branchId && !partnerId) {
      const branches = await db.collection('branches').find({}).toArray();
      const partners = await db.collection('partners').find({}).toArray();

      const branchBreakdown = await Promise.all(branches.map(async (b) => {
        const bId = b._id.toString();
        const reqs = requests.filter(r =>
          r.branchId === bId ||
          r.escalation?.escalatedBy?.branchId?.toString() === bId ||
          r.escalation?.escalatedBy?.id?.toString() === bId
        );
        const s = computeFinancials(reqs, bId);
        return { id: bId, name: b.branchName || b.name, type: 'branch', ...s };
      }));

      const partnerBreakdown = await Promise.all(partners.map(async (p) => {
        const pId = p._id.toString();
        const reqs = requests.filter(r =>
          r.partnerId === pId ||
          r.escalation?.escalatedBy?.partnerId?.toString() === pId ||
          r.escalation?.escalatedBy?.id?.toString() === pId
        );
        const s = computeFinancials(reqs, pId);
        return { id: pId, name: p.businessName || p.fullName, type: 'partner', ...s };
      }));

      summary.entityBreakdown = [...branchBreakdown, ...partnerBreakdown].filter(e => e.totalJobs > 0);
    }

    res.json(summary);
  } catch (error) {
    console.error('Error fetching admin financial summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DEVICE TYPES — Admin-managed
// ═══════════════════════════════════════════════════════════════════

// GET /device-types — List all device types
router.get('/device-types', async (req, res) => {
  try {
    const db = await connectDB();
    await seedDefaults(db);
    const types = await db.collection('device_types').find({}).sort({ createdAt: 1 }).toArray();
    res.json(types.map(t => ({ id: t._id.toString(), name: t.name, createdAt: t.createdAt })));
  } catch (error) {
    console.error('Error fetching device types:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /device-types — Add a new device type
router.post('/device-types', async (req, res) => {
  try {
    const db = await connectDB();
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Device type name is required' });

    const existing = await db.collection('device_types').findOne({ name: name.trim() });
    if (existing) return res.status(409).json({ error: 'Device type already exists' });

    const result = await db.collection('device_types').insertOne({
      name: name.trim(),
      createdAt: new Date(),
    });

    res.status(201).json({
      message: 'Device type added successfully',
      deviceType: { id: result.insertedId.toString(), name: name.trim() },
    });
  } catch (error) {
    console.error('Error adding device type:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /device-types/:id — Remove a device type
router.delete('/device-types/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid device type ID' });

    await db.collection('device_types').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Device type deleted successfully' });
  } catch (error) {
    console.error('Error deleting device type:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DEVICE DETAIL FIELDS — Admin-managed, per device type per branch
// ═══════════════════════════════════════════════════════════════════

// GET /device-detail-fields — List detail fields (filter by ?deviceType= and ?branchId=)
router.get('/device-detail-fields', async (req, res) => {
  try {
    const db = await connectDB();
    const filter = {};
    if (req.query.deviceType) filter.deviceType = req.query.deviceType;
    // When a branchId is provided, return both branch-specific AND global (null) fields
    if (req.query.branchId) {
      filter.$or = [
        { branchId: req.query.branchId },
        { branchId: null },
      ];
    }

    const fields = await db.collection('device_detail_fields').find(filter).sort({ createdAt: 1 }).toArray();
    res.json(fields.map(f => ({
      id: f._id.toString(),
      fieldName: f.fieldName,
      fieldType: f.fieldType || 'text',
      deviceType: f.deviceType,
      branchId: f.branchId || null,
      createdAt: f.createdAt,
    })));
  } catch (error) {
    console.error('Error fetching device detail fields:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /device-detail-fields — Add a diagnostic detail field
router.post('/device-detail-fields', async (req, res) => {
  try {
    const db = await connectDB();
    const { fieldName, fieldType, deviceType, branchId } = req.body;

    if (!fieldName || !deviceType) {
      return res.status(400).json({ error: 'Field name and device type are required' });
    }

    const existing = await db.collection('device_detail_fields').findOne({
      fieldName: fieldName.trim(),
      deviceType,
      branchId: branchId || null,
    });
    if (existing) return res.status(409).json({ error: 'This detail field already exists for this device type' });

    const result = await db.collection('device_detail_fields').insertOne({
      fieldName: fieldName.trim(),
      fieldType: fieldType || 'text',
      deviceType,
      branchId: branchId || null,
      createdAt: new Date(),
    });

    res.status(201).json({
      message: 'Detail field added successfully',
      field: { id: result.insertedId.toString(), fieldName: fieldName.trim(), fieldType: fieldType || 'text', deviceType, branchId: branchId || null },
    });
  } catch (error) {
    console.error('Error adding device detail field:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /device-detail-fields/:id — Remove a diagnostic detail field
router.delete('/device-detail-fields/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid field ID' });

    await db.collection('device_detail_fields').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Detail field deleted successfully' });
  } catch (error) {
    console.error('Error deleting device detail field:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SERVICE CATEGORIES — Admin-managed
// ═══════════════════════════════════════════════════════════════════

// GET /service-categories — List all service categories
router.get('/service-categories', async (req, res) => {
  try {
    const db = await connectDB();
    await seedDefaults(db);
    const cats = await db.collection('service_categories').find({}).sort({ createdAt: 1 }).toArray();
    res.json(cats.map(c => ({ id: c._id.toString(), name: c.name, createdAt: c.createdAt })));
  } catch (error) {
    console.error('Error fetching service categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /service-categories — Add a service category
router.post('/service-categories', async (req, res) => {
  try {
    const db = await connectDB();
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });

    const existing = await db.collection('service_categories').findOne({ name: name.trim() });
    if (existing) return res.status(409).json({ error: 'Service category already exists' });

    const result = await db.collection('service_categories').insertOne({
      name: name.trim(),
      createdAt: new Date(),
    });

    res.status(201).json({
      message: 'Service category added successfully',
      category: { id: result.insertedId.toString(), name: name.trim() },
    });
  } catch (error) {
    console.error('Error adding service category:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /service-categories/:id — Remove a service category
router.delete('/service-categories/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid category ID' });

    await db.collection('service_categories').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Service category deleted successfully' });
  } catch (error) {
    console.error('Error deleting service category:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SERVICE REQUESTS — Core entity
// ═══════════════════════════════════════════════════════════════════

// POST /service-requests — Receptionist or Partner registers customer device (In-House or Escalation)
router.post('/service-requests', authenticateBranchStaff, async (req, res) => {
  try {
    const isPartner = req.staff.role === 'Partner';
    const isReceptionist = req.staff.role === 'Receptionist';
    const isAdmin = req.staff.role === 'Admin';

    if (!isReceptionist && !isPartner && !isAdmin) {
      return res.status(403).json({ error: 'Only Receptionists, Partners, or Admin can register service requests' });
    }

    const db = await connectDB();
    const {
      fullName,
      phoneNumber,
      email,
      deviceType,
      brandName,
      model,
      problemDescription,
      estimatedCost,
      repairExpense,
      repairType,
      isEscalation,
      escalationReason,
      imei,
    } = req.body;

    if (!fullName || !phoneNumber || !deviceType || !brandName || !model || !problemDescription) {
      return res.status(400).json({ error: 'Full Name, Phone Number, Device Type, Brand Name, Model, and Problem Description are required' });
    }

    const trackingId = await generateTrackingId(db);
    const shouldEscalate = (isPartner || isReceptionist || isAdmin) && (isEscalation === true || repairType === 'escalation');
    const normalizedPhone = phoneNumber.trim().replace(/[\s\-\(\)\+]/g, '');

    const serviceRequest = {
      trackingId,
      branchId: req.staff.branchId || null,
      branchName: req.staff.branchName || null,
      partnerId: isPartner ? (req.staff.partnerId || req.staff.id).toString() : null,
      partnerName: isPartner ? (req.staff.businessName || req.staff.fullName) : null,
      isPartnerEscalation: shouldEscalate,
      escalatedToAdmin: shouldEscalate,
      partnerPayout: 0,
      customerInfo: {
        fullName: fullName.trim(),
        phoneNumber: phoneNumber.trim(),
        phoneNormalized: normalizedPhone,
        email: email ? email.trim().toLowerCase() : '',
      },
      deviceInfo: {
        deviceType,
        brandName: brandName.trim(),
        model: model.trim(),
        problemDescription: problemDescription.trim(),
        ...(imei ? { imei: imei.trim() } : {}),
      },
      diagnosis: null,
      serviceCards: [],
      totalCost: parseFloat(estimatedCost) || 0,
      repairExpense: parseFloat(repairExpense) || 0,
      paymentStatus: 'unpaid',
      status: shouldEscalate ? 'escalated' : 'pending_diagnosis',
      registeredBy: {
        id: req.staff.id.toString(),
        fullName: req.staff.fullName,
        role: req.staff.role,
      },
      ...(shouldEscalate
        ? {
            escalation: {
              isEscalated: true,
              reason: escalationReason ? escalationReason.trim() : problemDescription.trim(),
              privateInfo: {
                expectedPrice: parseFloat(estimatedCost) || 0,
                message: escalationReason ? escalationReason.trim() : problemDescription.trim(),
              },
              escalatedBy: {
                id: (req.staff.partnerId || req.staff.branchId || req.staff.id).toString(),
                name: req.staff.businessName || req.staff.branchName || req.staff.fullName || (isPartner ? 'Partner' : 'Branch Staff'),
                role: req.staff.role,
                branchId: req.staff.branchId || null,
                partnerId: req.staff.partnerId || (isPartner ? req.staff.id : null),
              },
              createdAt: new Date(),
              status: 'pending_admin_action',
              broadcast: null,
              partnerAFee: 0,
              partnerBTotalCost: 0,
              partnerBFee: 0,
              adminFee: 0,
              cancellation: null,
              paymentChain: {
                customerPaid: false,
                partnerBPayAdminStatus: 'none',
                partnerBPaidAt: null,
                adminAckPartnerBAt: null,
                adminPayPartnerAStatus: 'none',
                adminPaidPartnerAAt: null,
                partnerAAckAt: null,
              },
            },
          }
        : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: null,
    };

    // ── Unified Customer Identity: find-or-create customer profile ──
    try {
      let customerProfile = await db.collection('customers').findOne({ 'phoneNumbers.normalized': normalizedPhone });
      if (!customerProfile) {
        const now = new Date();
        const newCustomer = {
          primaryName: fullName.trim(),
          primaryEmail: email ? email.trim().toLowerCase() : '',
          phoneNumbers: [{ number: phoneNumber.trim(), normalized: normalizedPhone, label: 'primary', addedAt: now }],
          notes: '',
          tags: [],
          createdAt: now,
          updatedAt: now,
        };
        const cr = await db.collection('customers').insertOne(newCustomer);
        newCustomer._id = cr.insertedId;
        customerProfile = newCustomer;
      }
      serviceRequest.customerId = customerProfile._id.toString();
    } catch (profileErr) {
      console.warn('Warning: Could not link customer profile:', profileErr.message);
    }

    const result = await db.collection('service_requests').insertOne(serviceRequest);

    if (shouldEscalate) {
      broadcastNotification({
        type: 'escalation',
        title: '⚡️ New Escalated Device Registered',
        message: `${req.staff.businessName || req.staff.branchName || req.staff.fullName} registered an escalated repair: ${brandName} ${model} (Tracking #${trackingId})`,
        link: '/network-broadcast',
        data: { trackingId, brandName, model },
      }).catch(err => console.error('[Notification] Error broadcasting escalation:', err.message));
    }

    res.status(201).json({
      message: shouldEscalate ? 'Device escalated to Admin successfully' : 'Service request registered successfully',
      serviceRequest: {
        id: result.insertedId.toString(),
        trackingId,
        ...serviceRequest,
      },
    });
  } catch (error) {
    console.error('Error creating service request:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /service-requests — List service requests (filterable by branchId, status, paymentStatus)
router.get('/service-requests', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const conditions = [];

    // Staff/Partner can only see their own branch/partner requests
    if (req.staff.role === 'Partner') {
      const pid = (req.staff.partnerId || req.staff.id).toString();
      conditions.push({
        $or: [
          { partnerId: pid },
          { 'registeredBy.id': pid },
          { 'escalation.escalatedBy.partnerId': pid },
          { 'escalation.escalatedBy.id': pid },
        ],
      });
    } else if (req.staff.branchId) {
      const bid = req.staff.branchId.toString();
      conditions.push({
        $or: [
          { branchId: bid },
          { 'escalation.escalatedBy.branchId': bid },
          { 'escalation.escalatedBy.id': bid },
        ],
      });
    }

    if (req.query.status) conditions.push({ status: req.query.status });
    if (req.query.paymentStatus) conditions.push({ paymentStatus: req.query.paymentStatus });
    if (req.query.search) {
      const search = req.query.search.trim();
      conditions.push({
        $or: [
          { trackingId: { $regex: search, $options: 'i' } },
          { 'customerInfo.fullName': { $regex: search, $options: 'i' } },
          { 'customerInfo.phoneNumber': { $regex: search, $options: 'i' } },
          { 'deviceInfo.brandName': { $regex: search, $options: 'i' } },
          { 'deviceInfo.model': { $regex: search, $options: 'i' } },
        ],
      });
    }

    const filter = conditions.length > 1 ? { $and: conditions } : (conditions[0] || {});

    const requests = await db.collection('service_requests').find(filter).sort({ createdAt: -1 }).toArray();

    res.json(requests.map(r => {
      const cards = r.serviceCards || [];
      const revenue = r.totalCost || cards.reduce((sum, c) => sum + (c.spareCost || 0) + (c.serviceCost || 0), 0);
      const expenses = r.repairExpense !== undefined ? r.repairExpense : cards.reduce((sum, c) => sum + (c.spareCostExpense || 0) + (c.serviceCostExpense || 0), 0);
      const netProfit = revenue - expenses;
      const partnerPayout = r.escalation?.partnerAFee !== undefined
        ? r.escalation.partnerAFee
        : (r.partnerPayout !== undefined ? r.partnerPayout : revenue);

      return {
        id: r._id.toString(),
        trackingId: r.trackingId,
        branchId: r.branchId,
        branchName: r.branchName,
        partnerId: r.partnerId,
        partnerName: r.partnerName,
        isPartnerEscalation: !!r.isPartnerEscalation,
        partnerPayout,
        customerInfo: r.customerInfo,
        deviceInfo: r.deviceInfo,
        diagnosis: r.diagnosis,
        serviceCards: cards,
        totalCost: revenue,
        repairExpense: expenses,
        netProfit,
        paymentStatus: r.paymentStatus,
        status: r.status,
        registeredBy: r.registeredBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        paidAt: r.paidAt,
      };
    }));
  } catch (error) {
    console.error('Error fetching service requests:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /service-requests/:id/partner-financials — Admin or Partner updates job financials (totalCost, repairExpense, paymentStatus)
router.patch('/service-requests/:id/partner-financials', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { totalCost, repairExpense, paymentStatus, status } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

    const updateFields = { updatedAt: new Date() };
    if (totalCost !== undefined) updateFields.totalCost = parseFloat(totalCost) || 0;
    if (repairExpense !== undefined) updateFields.repairExpense = parseFloat(repairExpense) || 0;
    if (paymentStatus) {
      updateFields.paymentStatus = paymentStatus;
      if (paymentStatus === 'paid') updateFields.paidAt = new Date();
    }
    if (status) updateFields.status = status;

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    res.json({ message: 'Partner job financials updated successfully' });
  } catch (error) {
    console.error('Error updating partner financials:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /service-requests/:id — Get full service request details
router.get('/service-requests/:id', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const r = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!r) return res.status(404).json({ error: 'Service request not found' });

    res.json({
      id: r._id.toString(),
      trackingId: r.trackingId,
      branchId: r.branchId,
      branchName: r.branchName,
      customerInfo: r.customerInfo,
      deviceInfo: r.deviceInfo,
      diagnosis: r.diagnosis,
      serviceCards: r.serviceCards || [],
      totalCost: r.totalCost || 0,
      paymentStatus: r.paymentStatus,
      status: r.status,
      registeredBy: r.registeredBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      paidAt: r.paidAt,
    });
  } catch (error) {
    console.error('Error fetching service request:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /track/:trackingId — PUBLIC endpoint for customers to check repair status (no auth required)
router.get('/track/:trackingId', async (req, res) => {
  try {
    const db = await connectDB();
    const { trackingId } = req.params;

    const r = await db.collection('service_requests').findOne({ trackingId });
    if (!r) return res.status(404).json({ error: 'No repair found for this tracking ID. Please check the ID and try again.' });

    // ── Map every internal status → customer-facing step index ──────────────
    // Internal statuses lifecycle:
    //   pending_diagnosis → diagnosed → serviced (cards added) → repairing → quality_check → ready → completed
    //   escalated_to_admin / pending_admin_action / pending_admin_review → treated as step 0 (received/processing)
    const statusToStep = {
      pending_diagnosis:    0,   // just received, awaiting technician assessment
      escalated_to_admin:   0,   // escalated but still at intake stage
      pending_admin_action: 0,   // admin needs to act — device is in shop
      pending_admin_review: 0,
      escalated:            0,
      open_for_bids:        0,
      broadcasted:          0,
      diagnosed:            1,   // technician has assessed
      serviced:             2,   // service cards added, actively being repaired
      repairing:            2,   // explicit repairing status
      quality_check:        3,   // repair done, in QC
      ready:                4,   // ready for customer pickup
      completed:            4,   // collected
    };

    const statusLabels = {
      pending_diagnosis:    'Received — Awaiting Diagnosis',
      escalated_to_admin:   'Received — Under Review',
      pending_admin_action: 'Received — Processing',
      pending_admin_review: 'Received — Under Review',
      escalated:            'Received — Under Review',
      open_for_bids:        'Received — Processing',
      broadcasted:          'Received — Processing',
      diagnosed:            'Diagnosed',
      serviced:             'Under Repair',
      repairing:            'Under Repair',
      quality_check:        'Quality Check',
      ready:                'Ready for Pickup',
      completed:            'Completed — Collected',
      cancelled:            'Cancelled',
    };

    const currentStep = statusToStep[r.status] ?? 0;

    res.json({
      trackingId: r.trackingId,
      status: r.status,
      statusLabel: statusLabels[r.status] || r.status,
      currentStep,
      totalSteps: 5,
      deviceSummary: r.deviceInfo ? `${r.deviceInfo.brandName || r.deviceInfo.brand || ''} ${r.deviceInfo.model || ''}`.trim() : 'Device',
      branchName: r.branchName || 'MOCOS Branch',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  } catch (error) {
    console.error('Error in public repair tracker:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /service-requests/track/:trackingId — Look up by 10-digit tracking ID

router.get('/service-requests/track/:trackingId', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { trackingId } = req.params;

    const r = await db.collection('service_requests').findOne({ trackingId });
    if (!r) return res.status(404).json({ error: 'Service request not found for this tracking ID' });

    res.json({
      id: r._id.toString(),
      trackingId: r.trackingId,
      branchId: r.branchId,
      branchName: r.branchName,
      customerInfo: r.customerInfo,
      deviceInfo: r.deviceInfo,
      diagnosis: r.diagnosis,
      serviceCards: r.serviceCards || [],
      totalCost: r.totalCost || 0,
      paymentStatus: r.paymentStatus,
      status: r.status,
      registeredBy: r.registeredBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      paidAt: r.paidAt,
    });
  } catch (error) {
    console.error('Error tracking service request:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /service-requests/:id/diagnosis — Technician or Partner saves diagnostic details
router.put('/service-requests/:id/diagnosis', authenticateBranchStaff, async (req, res) => {
  try {
    if (req.staff.role !== 'Technician' && req.staff.role !== 'Partner' && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Technicians, Partners, or Admin can add diagnosis information' });
    }

    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const { details } = req.body;
    if (!details || typeof details !== 'object') {
      return res.status(400).json({ error: 'Diagnosis details object is required' });
    }

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          diagnosis: {
            details,
            diagnosedBy: { id: req.staff.id, fullName: req.staff.fullName },
            diagnosedAt: new Date(),
          },
          status: 'diagnosed',
          updatedAt: new Date(),
        },
      }
    );

    res.json({ message: 'Diagnosis saved successfully' });
  } catch (error) {
    console.error('Error saving diagnosis:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Helper: calculate total cost preserving escalation fees ──
function calculateTotalCostWithEscalation(request, cards) {
  const cardsTotal = cards.reduce((sum, c) => sum + (Number(c.spareCost) || 0) + (Number(c.serviceCost) || 0), 0);
  if (request.escalation?.isEscalated && (request.escalation?.partnerBFee !== undefined || request.escalation?.broadcast?.status === 'awarded' || request.escalation?.status === 'admin_solving')) {
    const pAFee = Number(request.escalation.partnerAFee) || 0;
    const adminFee = Number(request.escalation.adminFee) || 0;
    const initialPBFee = Number(request.escalation.partnerBFee) || 0;
    const finalPBFee = Math.max(initialPBFee, cardsTotal);
    return {
      totalCost: pAFee + adminFee + finalPBFee,
      partnerBFee: finalPBFee,
      cardsTotal,
    };
  }
  return {
    totalCost: cardsTotal,
    partnerBFee: null,
    cardsTotal,
  };
}

// POST /service-requests/:id/service-cards — Technician, Partner or Admin adds a service card entry
router.post('/service-requests/:id/service-cards', authenticateBranchStaff, async (req, res) => {
  try {
    if (req.staff.role !== 'Technician' && req.staff.role !== 'Partner' && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Technicians, Partners, or Admin can add service cards' });
    }

    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const { category, fault, spareCost, serviceCost, spareCostExpense, serviceCostExpense, description } = req.body;

    if (!category || !fault) {
      return res.status(400).json({ error: 'Service category and fault/problem are required' });
    }

    const serviceCard = {
      category,
      fault: fault.trim(),
      spareCost: Number(spareCost) || 0,
      serviceCost: Number(serviceCost) || 0,
      spareCostExpense: Number(spareCostExpense) || 0,
      serviceCostExpense: Number(serviceCostExpense) || 0,
      description: description ? description.trim() : '',
      addedBy: { id: req.staff.id, fullName: req.staff.fullName || 'Staff' },
      addedAt: new Date(),
    };

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const updatedCards = [...(request.serviceCards || []), serviceCard];
    const costCalc = calculateTotalCostWithEscalation(request, updatedCards);

    const updateDoc = {
      serviceCards: updatedCards,
      totalCost: costCalc.totalCost,
      status: 'serviced',
      updatedAt: new Date(),
    };

    if (costCalc.partnerBFee !== null) {
      updateDoc['escalation.partnerBFee'] = costCalc.partnerBFee;
      updateDoc['escalation.partnerBTotalCost'] = costCalc.cardsTotal;
    }

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    res.status(201).json({
      message: 'Service card added successfully',
      serviceCard,
      totalCost: costCalc.totalCost,
    });
  } catch (error) {
    console.error('Error adding service card:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /service-requests/:id/service-cards/:cardIndex — Update a service card
router.put('/service-requests/:id/service-cards/:cardIndex', authenticateBranchStaff, async (req, res) => {
  try {
    if (req.staff.role !== 'Technician' && req.staff.role !== 'Partner' && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Technicians, Partners, or Admin can update service cards' });
    }

    const db = await connectDB();
    const { id, cardIndex } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const idx = parseInt(cardIndex, 10);
    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });
    if (!request.serviceCards || idx < 0 || idx >= request.serviceCards.length) {
      return res.status(400).json({ error: 'Invalid service card index' });
    }

    const { category, fault, spareCost, serviceCost, spareCostExpense, serviceCostExpense, description } = req.body;

    request.serviceCards[idx] = {
      ...request.serviceCards[idx],
      category: category || request.serviceCards[idx].category,
      fault: fault ? fault.trim() : request.serviceCards[idx].fault,
      spareCost: spareCost !== undefined ? Number(spareCost) : request.serviceCards[idx].spareCost,
      serviceCost: serviceCost !== undefined ? Number(serviceCost) : request.serviceCards[idx].serviceCost,
      spareCostExpense: spareCostExpense !== undefined ? Number(spareCostExpense) : request.serviceCards[idx].spareCostExpense,
      serviceCostExpense: serviceCostExpense !== undefined ? Number(serviceCostExpense) : request.serviceCards[idx].serviceCostExpense,
      description: description !== undefined ? description.trim() : request.serviceCards[idx].description,
      updatedAt: new Date(),
    };

    const costCalc = calculateTotalCostWithEscalation(request, request.serviceCards);
    const updateDoc = {
      serviceCards: request.serviceCards,
      totalCost: costCalc.totalCost,
      updatedAt: new Date(),
    };

    if (costCalc.partnerBFee !== null) {
      updateDoc['escalation.partnerBFee'] = costCalc.partnerBFee;
      updateDoc['escalation.partnerBTotalCost'] = costCalc.cardsTotal;
    }

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    res.json({ message: 'Service card updated successfully', totalCost: costCalc.totalCost });
  } catch (error) {
    console.error('Error updating service card:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /service-requests/:id/service-cards/:cardIndex — Delete a service card
router.delete('/service-requests/:id/service-cards/:cardIndex', authenticateBranchStaff, async (req, res) => {
  try {
    if (req.staff.role !== 'Technician' && req.staff.role !== 'Partner' && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Technicians, Partners, or Admin can delete service cards' });
    }

    const db = await connectDB();
    const { id, cardIndex } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const idx = parseInt(cardIndex, 10);
    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });
    if (!request.serviceCards || idx < 0 || idx >= request.serviceCards.length) {
      return res.status(400).json({ error: 'Invalid service card index' });
    }

    request.serviceCards.splice(idx, 1);
    const costCalc = calculateTotalCostWithEscalation(request, request.serviceCards);

    const status = request.serviceCards.length === 0
      ? (request.diagnosis ? 'diagnosed' : 'pending_diagnosis')
      : 'serviced';

    const updateDoc = {
      serviceCards: request.serviceCards,
      totalCost: costCalc.totalCost,
      status,
      updatedAt: new Date(),
    };

    if (costCalc.partnerBFee !== null) {
      updateDoc['escalation.partnerBFee'] = costCalc.partnerBFee;
      updateDoc['escalation.partnerBTotalCost'] = costCalc.cardsTotal;
    }

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    res.json({ message: 'Service card deleted successfully', totalCost: costCalc.totalCost });
  } catch (error) {
    console.error('Error deleting service card:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /service-requests/:id/mark-paid — Receptionist, Partner, or Admin marks as paid
router.put('/service-requests/:id/mark-paid', authenticateBranchStaff, async (req, res) => {
  try {
    if (req.staff.role !== 'Receptionist' && req.staff.role !== 'Partner' && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Receptionists, Partners, or Admin can mark service requests as paid' });
    }

    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    if (request.paymentStatus === 'paid') {
      return res.status(400).json({ error: 'This service request is already marked as paid' });
    }

    const isAdmin = req.staff.role === 'Admin';
    const updateDoc = {
      paymentStatus: 'paid',
      paidAt: new Date(),
      paidBy: { id: req.staff.id, fullName: req.staff.fullName || (isAdmin ? 'Admin' : 'Staff') },
      updatedAt: new Date(),
    };

    if (request.escalation?.isEscalated) {
      updateDoc['escalation.paymentChain.customerPaid'] = true;
      updateDoc['escalation.paymentChain.customerPaidAt'] = new Date();
      if (isAdmin) {
        updateDoc['escalation.paymentChain.partnerBPayAdminStatus'] = 'confirmed';
        updateDoc['escalation.paymentChain.adminPayPartnerAStatus'] = 'confirmed';
        updateDoc['escalation.paymentChain.settledByAdminAt'] = new Date();
      }
    }

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    broadcastNotification({
      type: 'payment',
      title: '💳 Payment Received',
      message: `${req.staff.fullName || req.staff.role} marked job #${request.trackingId} as PAID (TZS ${(request.totalCost || 0).toLocaleString()})`,
      link: '/services',
      data: { trackingId: request.trackingId, totalCost: request.totalCost }
    }).catch(() => {});

    res.json({ message: 'Service request marked as paid successfully' });
  } catch (error) {
    console.error('Error marking as paid:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /service-requests/:id/status — Technician or Partner updates repair status
router.put('/service-requests/:id/status', authenticateBranchStaff, async (req, res) => {
  try {
    const { status, note } = req.body;
    const validStatuses = [
      'pending_diagnosis',
      'diagnosed',
      'serviced',
      'repairing',
      'quality_check',
      'ready',
      'completed',
      'cancelled',
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const updateDoc = {
      status,
      updatedAt: new Date(),
      lastStatusUpdatedBy: {
        id: req.staff.id.toString(),
        fullName: req.staff.fullName,
        role: req.staff.role,
      },
    };

    if (status === 'completed' && !request.completedAt) {
      updateDoc.completedAt = new Date();
    }
    if (status === 'cancelled' && !request.cancelledAt) {
      updateDoc.cancelledAt = new Date();
    }

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: updateDoc,
        $push: {
          statusTimeline: {
            status,
            changedAt: new Date(),
            changedBy: req.staff.fullName,
            note: note || '',
          },
        },
      }
    );

    res.json({ message: `Status updated to ${status}`, status });
  } catch (error) {
    console.error('Error updating service request status:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /service-requests/forward-web-request — Forward web booking/repair request to Branch or Partner
router.post('/forward-web-request', async (req, res) => {
  try {
    const db = await connectDB();
    const { requestId, requestType, targetType, targetId, targetName } = req.body;

    if (!requestId || !requestType || !targetType || !targetId) {
      return res.status(400).json({ error: 'requestId, requestType, targetType, and targetId are required' });
    }

    if (!['booking', 'remote', 'tv_home', 'tv_repair'].includes(requestType)) {
      return res.status(400).json({ error: 'requestType must be booking, remote, or tv_home' });
    }

    if (!['branch', 'partner'].includes(targetType)) {
      return res.status(400).json({ error: 'targetType must be branch or partner' });
    }

    let collectionName = 'bookData';
    if (requestType === 'remote') collectionName = 'repairData';
    else if (requestType === 'tv_home' || requestType === 'tv_repair') collectionName = 'tvHomeRepairData';

    if (!ObjectId.isValid(requestId)) return res.status(400).json({ error: 'Invalid request ID' });

    const webReq = await db.collection(collectionName).findOne({ _id: new ObjectId(requestId) });
    if (!webReq) return res.status(404).json({ error: 'Web request not found' });

    const trackingId = await generateTrackingId(db);

    const customerName = webReq.bookName || webReq.remoteName || webReq.name || 'Customer';
    const customerPhone = webReq.bookPhone || webReq.remotePhone || webReq.phone || '';
    const customerEmail = webReq.email || '';

    const isTv = requestType === 'tv_home' || requestType === 'tv_repair';
    const deviceName = isTv ? (webReq.tvBrand || 'TV') : (webReq.bookDevice || webReq.remoteDevice || webReq.deviceModel || 'Device');
    const serviceName = isTv ? `${webReq.tvSize || 55}" TV In-Home Repair` : (webReq.bookService || webReq.serviceType || 'Repair');
    const problemDesc = webReq.problem || webReq.bookProblem || webReq.remoteProblem || webReq.description || 'Web repair request';

    const serviceRequest = {
      trackingId,
      branchId: targetType === 'branch' ? targetId : null,
      branchName: targetType === 'branch' ? targetName || 'Branch' : null,
      partnerId: targetType === 'partner' ? targetId : null,
      partnerName: targetType === 'partner' ? targetName || 'Partner' : null,
      customerInfo: {
        fullName: customerName,
        phoneNumber: customerPhone,
        email: customerEmail,
      },
      deviceInfo: {
        deviceType: isTv ? 'TV' : 'Smartphone',
        brandName: deviceName,
        model: serviceName,
        problemDescription: `${problemDesc}${isTv && webReq.street ? ` (Location: ${webReq.street}, ${webReq.ward}, ${webReq.district}, ${webReq.region})` : ''}`.trim(),
      },
      diagnosis: null,
      serviceCards: [],
      totalCost: 0,
      paymentStatus: 'unpaid',
      status: 'pending_diagnosis',
      registeredBy: {
        id: 'admin',
        fullName: 'Admin Forwarding',
      },
      forwardedFrom: {
        type: requestType,
        requestId,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: null,
    };

    const result = await db.collection('service_requests').insertOne(serviceRequest);

    // Update state of web request to Forwarded
    await db.collection(collectionName).updateOne(
      { _id: new ObjectId(requestId) },
      {
        $set: {
          new: 'Forwarded',
          comment: `Forwarded to ${targetType === 'partner' ? 'Partner' : 'Branch'}: ${targetName || targetId}`,
          forwardedTo: {
            type: targetType,
            id: targetId,
            name: targetName,
            serviceRequestId: result.insertedId.toString(),
            trackingId,
          },
          updatedAt: new Date(),
        },
      }
    );

    res.status(201).json({
      message: `Request forwarded to ${targetType} successfully`,
      serviceRequest: {
        id: result.insertedId.toString(),
        trackingId,
        ...serviceRequest,
      },
    });
  } catch (error) {
    console.error('Error forwarding web request:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ESCALATION, BROADCAST, GRANTING & PAYMENT CHAIN WORKFLOW
// ═══════════════════════════════════════════════════════════════════

// 1. POST /service-requests/:id/escalate — Branch / Partner escalates job to Admin
// Accepts optional expectedPrice and private message (VISIBLE ONLY TO ADMIN)
router.post('/service-requests/:id/escalate', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { reason, expectedPrice, message } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Escalation reason is required' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const isPartner = req.staff.role === 'Partner';
    const escalationData = {
      isEscalated: true,
      reason: reason.trim(),
      // PRIVATE INFO: ONLY ACCESSIBLE TO ADMIN
      privateInfo: {
        expectedPrice: parseFloat(expectedPrice) || 0,
        message: message ? message.trim() : (reason ? reason.trim() : ''),
      },
      escalatedBy: {
        id: (req.staff.partnerId || req.staff.branchId || req.staff.id).toString(),
        name: req.staff.businessName || req.staff.branchName || req.staff.fullName || (isPartner ? 'Partner' : 'Branch Staff'),
        role: req.staff.role,
        branchId: req.staff.branchId || null,
        partnerId: req.staff.partnerId || (isPartner ? req.staff.id : null),
      },
      createdAt: new Date(),
      status: 'pending_admin_action',
      broadcast: null,
      partnerAFee: 0,
      partnerBTotalCost: 0,
      partnerBFee: 0,
      adminFee: 0,
      cancellation: null,
      paymentChain: {
        customerPaid: false,
        partnerBPayAdminStatus: 'none', // 'none' | 'paid_pending_ack' | 'confirmed'
        partnerBPaidAt: null,
        adminAckPartnerBAt: null,
        adminPayPartnerAStatus: 'none', // 'none' | 'paid_pending_ack' | 'confirmed'
        adminPaidPartnerAAt: null,
        partnerAAckAt: null,
      },
    };

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          escalation: escalationData,
          isPartnerEscalation: true,
          escalatedToAdmin: true,
          status: 'escalated',
          updatedAt: new Date(),
        },
      }
    );

    broadcastNotification({
      type: 'escalation',
      title: '⚡️ Job Escalated to Admin HQ',
      message: `${req.staff.businessName || req.staff.branchName || req.staff.fullName} escalated ${request.deviceInfo?.brandName || request.deviceInfo?.brand || ''} ${request.deviceInfo?.model || ''} (Tracking #${request.trackingId})`,
      link: '/network-broadcast',
      data: { trackingId: request.trackingId, reason: reason.trim() }
    }).catch(() => {});

    res.json({ message: 'Request escalated to admin successfully', escalation: escalationData });
  } catch (error) {
    console.error('Error escalating service request:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. POST /service-requests/:id/broadcast — Admin broadcasts job to All network (or Branches/Partners)
// Allows admin to specify adminOffer (sum of Partner A share + Admin fee) and detailed info
router.post('/service-requests/:id/broadcast', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { targetAudience, adminOffer, adminProcessFee, broadcastDetails } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const audience = ['all', 'branches', 'partners'].includes(targetAudience) ? targetAudience : 'all';

    const broadcastObj = {
      isBroadcast: true,
      targetAudience: audience,
      adminOffer: parseFloat(adminOffer) || 0,
      adminProcessFee: parseFloat(adminProcessFee) || 0,
      broadcastDetails: broadcastDetails ? broadcastDetails.trim() : '',
      broadcastAt: new Date(),
      status: 'open_for_bids',
      candidateBids: [],
      awardedTo: null,
    };

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          'escalation.broadcast': broadcastObj,
          'escalation.status': 'broadcasted',
          status: 'broadcasted',
          updatedAt: new Date(),
        },
      }
    );

    broadcastNotification({
      type: 'network_broadcast',
      title: '📢 New Network Broadcast Available',
      message: `Admin broadcasted a repair job for ${request.deviceInfo?.brandName || request.deviceInfo?.brand || ''} ${request.deviceInfo?.model || ''} to ${audience}`,
      link: '/services',
      data: { trackingId: request.trackingId, targetAudience: audience, adminOffer }
    }).catch(() => {});

    res.json({ message: `Request broadcasted to ${audience} successfully`, broadcast: broadcastObj });
  } catch (error) {
    console.error('Error broadcasting service request:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. GET /broadcasts/open — List all open broadcast requests for logged-in Branch or Partner
// CRITICAL SECURITY RULE: Excludes privateInfo (expectedPrice & private message) from non-admin API response!
router.get('/broadcasts/open', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const userEntityType = req.staff.role === 'Partner' ? 'partner' : 'branch';
    const userEntityId = req.staff.role === 'Partner'
      ? (req.staff.partnerId || req.staff.id).toString()
      : (req.staff.branchId ? req.staff.branchId.toString() : req.staff.id.toString());

    const filter = {
      'escalation.broadcast.isBroadcast': true,
      'escalation.broadcast.status': 'open_for_bids',
    };

    const requests = await db.collection('service_requests').find(filter).sort({ 'escalation.broadcast.broadcastAt': -1 }).toArray();

    const available = requests.filter((r) => {
      const b = r.escalation?.broadcast;
      if (!b || b.status !== 'open_for_bids') return false;

      // CRITICAL RULE: Broadcasted job MUST NOT be seen by the partner or branch who escalated it!
      const esc = r.escalation?.escalatedBy;
      if (esc) {
        if (esc.partnerId && userEntityType === 'partner' && esc.partnerId.toString() === userEntityId) return false;
        if (esc.branchId && userEntityType === 'branch' && esc.branchId.toString() === userEntityId) return false;
        if (esc.id && esc.id.toString() === userEntityId) return false;
      }

      if (r.partnerId && userEntityType === 'partner' && r.partnerId.toString() === userEntityId) return false;
      if (r.branchId && userEntityType === 'branch' && r.branchId.toString() === userEntityId) return false;

      if (b.targetAudience === 'partners' && userEntityType !== 'partner') return false;
      if (b.targetAudience === 'branches' && userEntityType !== 'branch') return false;

      return true;
    });

    res.json(available.map((r) => {
      const bids = r.escalation?.broadcast?.candidateBids || [];
      const hasAccepted = bids.some(bid => bid.entityId === userEntityId);

      return {
        id: r._id.toString(),
        trackingId: r.trackingId,
        deviceInfo: r.deviceInfo,
        escalationReason: r.escalation?.reason || 'Repair issue escalated by network member',
        broadcast: {
          targetAudience: r.escalation?.broadcast?.targetAudience,
          adminOffer: r.escalation?.broadcast?.adminOffer || 0,
          adminProcessFee: r.escalation?.broadcast?.adminProcessFee || r.escalation?.adminFee || 0,
          broadcastDetails: r.escalation?.broadcast?.broadcastDetails || '',
          broadcastAt: r.escalation?.broadcast?.broadcastAt,
          status: r.escalation?.broadcast?.status,
        },
        hasAccepted,
        bidCount: bids.length,
        createdAt: r.createdAt,
      };
    }));
  } catch (error) {
    console.error('Error fetching open broadcasts:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. POST /service-requests/:id/accept-broadcast — Branch / Partner accepts broadcast & states total cost required
router.post('/service-requests/:id/accept-broadcast', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { notes, totalCostRequired } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const broadcast = request.escalation?.broadcast;
    if (!broadcast || broadcast.status !== 'open_for_bids') {
      return res.status(400).json({ error: 'This broadcast is no longer open for acceptances' });
    }

    const entityType = req.staff.role === 'Partner' ? 'partner' : 'branch';
    const entityId = req.staff.role === 'Partner'
      ? (req.staff.partnerId || req.staff.id).toString()
      : (req.staff.branchId ? req.staff.branchId.toString() : req.staff.id.toString());
    const entityName = req.staff.role === 'Partner'
      ? (req.staff.businessName || req.staff.fullName || 'Partner')
      : (req.staff.branchName || req.staff.fullName || 'Branch');

    const bids = broadcast.candidateBids || [];
    const alreadyBid = bids.find(b => b.entityId === entityId);
    if (alreadyBid) {
      return res.status(409).json({ error: 'You have already accepted/bid on this broadcast request' });
    }

    const newBid = {
      entityId,
      entityType,
      entityName,
      userRole: req.staff.role,
      userFullName: req.staff.fullName,
      totalCostRequired: parseFloat(totalCostRequired) || 0,
      notes: notes ? notes.trim() : '',
      bidAt: new Date(),
    };

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $push: { 'escalation.broadcast.candidateBids': newBid },
        $set: { updatedAt: new Date() },
      }
    );

    broadcastNotification({
      type: 'broadcast_bid',
      title: '✋ Broadcast Accepted by Candidate',
      message: `${entityName} accepted broadcast for job #${request.trackingId} (Required: TZS ${(parseFloat(totalCostRequired) || 0).toLocaleString()})`,
      link: '/network-broadcast',
      data: { trackingId: request.trackingId, entityName, totalCostRequired }
    }).catch(() => {});

    res.json({ message: 'Broadcast accepted successfully with total cost required. Admin will review and grant assignment.', bid: newBid });
  } catch (error) {
    console.error('Error accepting broadcast:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. POST /service-requests/:id/grant-broadcast — Admin grants job to selected partner & specifies Partner A fee, Admin fee, Partner B fee (Total cost = sum of all)
router.post('/service-requests/:id/grant-broadcast', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { winnerEntityId, winnerEntityType, winnerEntityName, partnerAFee, adminFee, partnerBFee, totalCost } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });
    if (!winnerEntityId || !winnerEntityType) {
      return res.status(400).json({ error: 'winnerEntityId and winnerEntityType are required' });
    }

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const finalPartnerAFee = parseFloat(partnerAFee) || 0;
    const finalAdminFee = parseFloat(adminFee) || 0;
    const finalPartnerBFee = parseFloat(partnerBFee) || 0;
    const computedTotalCost = finalPartnerAFee + finalAdminFee + finalPartnerBFee;
    const finalTotalCost = parseFloat(totalCost) || computedTotalCost;

    const awardedToObj = {
      entityId: winnerEntityId,
      entityType: winnerEntityType,
      entityName: winnerEntityName || (winnerEntityType === 'partner' ? 'Partner' : 'Branch'),
      awardedAt: new Date(),
    };

    const updateFields = {
      branchId: winnerEntityType === 'branch' ? winnerEntityId : null,
      branchName: winnerEntityType === 'branch' ? (winnerEntityName || 'Branch') : null,
      partnerId: winnerEntityType === 'partner' ? winnerEntityId : null,
      partnerName: winnerEntityType === 'partner' ? (winnerEntityName || 'Partner') : null,
      status: 'pending_diagnosis',
      totalCost: finalTotalCost,
      'escalation.status': 'awarded',
      'escalation.partnerAFee': finalPartnerAFee,
      'escalation.adminFee': finalAdminFee,
      'escalation.partnerBFee': finalPartnerBFee,
      'escalation.broadcast.status': 'awarded',
      'escalation.broadcast.awardedTo': awardedToObj,
      updatedAt: new Date(),
    };

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    broadcastNotification({
      type: 'broadcast_awarded',
      title: '🏆 Broadcast Job Awarded',
      message: `Job #${request.trackingId} was awarded to ${winnerEntityName || winnerEntityType} (Customer Total: TZS ${finalTotalCost.toLocaleString()})`,
      link: '/services',
      data: { trackingId: request.trackingId, winnerEntityName }
    }).catch(() => {});

    res.json({
      message: `Job granted to ${winnerEntityName || winnerEntityType} successfully! Total Customer Price: TZS ${finalTotalCost.toLocaleString()} (Partner A: ${finalPartnerAFee.toLocaleString()} + Admin: ${finalAdminFee.toLocaleString()} + Partner B: ${finalPartnerBFee.toLocaleString()})`,
      awardedTo: awardedToObj,
    });
  } catch (error) {
    console.error('Error granting broadcast:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5b. POST /service-requests/:id/update-fees — Admin can update fee breakdown at any time due to price changes during repair
router.post('/service-requests/:id/update-fees', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { partnerAFee, adminFee, partnerBFee, totalCost } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const finalPartnerAFee = parseFloat(partnerAFee) || 0;
    const finalAdminFee = parseFloat(adminFee) || 0;
    const finalPartnerBFee = parseFloat(partnerBFee) || 0;
    const computedTotalCost = finalPartnerAFee + finalAdminFee + finalPartnerBFee;
    const finalTotalCost = parseFloat(totalCost) || computedTotalCost;

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          totalCost: finalTotalCost,
          'escalation.partnerAFee': finalPartnerAFee,
          'escalation.adminFee': finalAdminFee,
          'escalation.partnerBFee': finalPartnerBFee,
          updatedAt: new Date(),
        },
      }
    );

    res.json({
      message: `Fees updated successfully! Total Price: TZS ${finalTotalCost.toLocaleString()} (Partner A: ${finalPartnerAFee.toLocaleString()} + Admin: ${finalAdminFee.toLocaleString()} + Partner B: ${finalPartnerBFee.toLocaleString()})`,
    });
  } catch (error) {
    console.error('Error updating fees:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. POST /service-requests/:id/admin-solve — Admin accepts & solves escalated job directly, setting Partner A fee
router.post('/service-requests/:id/admin-solve', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { partnerAFee, notes } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const finalPartnerAFee = parseFloat(partnerAFee) || 0;

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          branchId: 'admin',
          branchName: 'Mocos Head Office (Admin)',
          partnerId: null,
          partnerName: null,
          status: 'pending_diagnosis',
          'escalation.status': 'admin_solving',
          'escalation.partnerAFee': finalPartnerAFee,
          'escalation.adminSolveNotes': notes ? notes.trim() : '',
          updatedAt: new Date(),
        },
      }
    );

    broadcastNotification({
      type: 'admin_solve',
      title: '🛠 In-House Repair Assigned',
      message: `Admin assigned escalated job #${request.trackingId} for in-house repair at Head Office`,
      link: '/services',
      data: { trackingId: request.trackingId }
    }).catch(() => {});

    res.json({ message: 'Admin accepted & assigned job to in-house repair team', partnerAFee: finalPartnerAFee });
  } catch (error) {
    console.error('Error in admin direct solve:', error);
    res.status(500).json({ error: error.message });
  }
});

// 7. POST /service-requests/:id/cancel-escalation — Admin cancels/closes escalated job with reason
router.post('/service-requests/:id/cancel-escalation', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { reason } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: 'closed',
          'escalation.status': 'cancelled',
          'escalation.cancellation': {
            requestedBy: 'admin',
            reason: reason ? reason.trim() : 'Cancelled by Admin',
            status: 'approved',
            resolvedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      }
    );

    broadcastNotification({
      type: 'escalation_cancelled',
      title: '🚫 Escalated Job Cancelled',
      message: `Admin cancelled escalated job #${request.trackingId}: ${reason ? reason.trim() : 'Cancelled by Admin'}`,
      link: '/services',
      data: { trackingId: request.trackingId }
    }).catch(() => {});

    res.json({ message: 'Escalated job cancelled and closed by Admin' });
  } catch (error) {
    console.error('Error cancelling escalation:', error);
    res.status(500).json({ error: error.message });
  }
});

// 8. POST /service-requests/:id/request-cancel-escalation — Partner or Branch requests cancellation from Admin
router.post('/service-requests/:id/request-cancel-escalation', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { reason } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason for cancellation request is required' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const isPartner = req.staff.role === 'Partner';
    const cancellationObj = {
      requestedBy: isPartner ? 'partner' : 'branch',
      partnerId: isPartner ? (req.staff.partnerId || req.staff.id) : null,
      branchId: !isPartner ? (req.staff.branchId || req.staff.id) : null,
      entityName: req.staff.businessName || req.staff.branchName || req.staff.fullName,
      partnerName: req.staff.businessName || req.staff.fullName,
      reason: reason.trim(),
      status: 'pending_admin_review',
      requestedAt: new Date(),
    };

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          'escalation.cancellation': cancellationObj,
          updatedAt: new Date(),
        },
      }
    );

    broadcastNotification({
      type: 'escalation_cancel_request',
      title: '⚠️ Cancellation Requested for Escalation',
      message: `${cancellationObj.entityName} requested cancellation for job #${request.trackingId}: "${reason.trim()}"`,
      link: '/network-broadcast',
      data: { trackingId: request.trackingId, reason: reason.trim() }
    }).catch(() => {});

    res.json({ message: 'Cancellation request submitted to Admin', cancellation: cancellationObj });
  } catch (error) {
    console.error('Error requesting escalation cancel:', error);
    res.status(500).json({ error: error.message });
  }
});

// 9. POST /service-requests/:id/respond-cancel-escalation — Admin accepts or denies cancellation request
router.post('/service-requests/:id/respond-cancel-escalation', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { action } = req.body; // 'approve' | 'deny'

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });
    if (!['approve', 'deny'].includes(action)) return res.status(400).json({ error: 'Action must be approve or deny' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    if (action === 'approve') {
      await db.collection('service_requests').updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: 'closed',
            'escalation.status': 'cancelled',
            'escalation.cancellation.status': 'approved',
            'escalation.cancellation.resolvedAt': new Date(),
            updatedAt: new Date(),
          },
        }
      );

      broadcastNotification({
        type: 'escalation_cancel_approved',
        title: '✅ Escalation Cancellation Approved',
        message: `Admin approved cancellation for job #${request.trackingId}. Ticket is now closed.`,
        link: '/services',
        data: { trackingId: request.trackingId }
      }).catch(() => {});

      res.json({ message: 'Cancellation request approved by Admin. Job closed.' });
    } else {
      await db.collection('service_requests').updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            'escalation.cancellation.status': 'denied',
            'escalation.cancellation.resolvedAt': new Date(),
            updatedAt: new Date(),
          },
        }
      );

      broadcastNotification({
        type: 'escalation_cancel_denied',
        title: '❌ Escalation Cancellation Denied',
        message: `Admin denied cancellation for job #${request.trackingId}. Job remains active.`,
        link: '/services',
        data: { trackingId: request.trackingId }
      }).catch(() => {});

      res.json({ message: 'Cancellation request denied by Admin. Job remains active.' });
    }
  } catch (error) {
    console.error('Error responding to cancellation request:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PAYMENT CONFIRMATION CHAIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

// 10. POST /service-requests/:id/mark-paid-admin — Admin toggles payment status to Paid or Unpaid for both Partner A & Partner B
router.post('/service-requests/:id/mark-paid-admin', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { status } = req.body; // 'paid' | 'unpaid'

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service request ID' });

    const request = await db.collection('service_requests').findOne({ _id: new ObjectId(id) });
    if (!request) return res.status(404).json({ error: 'Service request not found' });

    const isPaid = status === 'paid' || request.paymentStatus !== 'paid';
    const newPaymentStatus = isPaid ? 'paid' : 'unpaid';

    await db.collection('service_requests').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          paymentStatus: newPaymentStatus,
          paidAt: isPaid ? new Date() : null,
          paidBy: isPaid ? { id: (req.user?.id || 'admin'), fullName: (req.user?.fullName || req.user?.username || 'Admin HQ') } : null,
          'escalation.paymentChain.customerPaid': isPaid,
          'escalation.paymentChain.customerPaidAt': isPaid ? new Date() : null,
          'escalation.paymentChain.partnerBPayAdminStatus': isPaid ? 'confirmed' : 'unpaid',
          'escalation.paymentChain.adminPayPartnerAStatus': isPaid ? 'confirmed' : 'unpaid',
          'escalation.paymentChain.settledByAdminAt': isPaid ? new Date() : null,
          updatedAt: new Date(),
        },
      }
    );

    broadcastNotification({
      type: 'payment',
      title: isPaid ? '💳 Payment Settled by Admin' : '💳 Payment Marked Unpaid',
      message: `Admin ${isPaid ? 'marked as paid & settled payouts for' : 'reverted payment for'} job #${request.trackingId}`,
      link: '/services',
      data: { trackingId: request.trackingId, isPaid }
    }).catch(() => {});

    res.json({
      message: isPaid
        ? 'Service request marked as PAID. Payouts for both Partner A and Partner B are settled!'
        : 'Service request marked as UNPAID.',
      paymentStatus: newPaymentStatus,
    });
  } catch (error) {
    console.error('Error in mark-paid-admin:', error);
    res.status(500).json({ error: error.message });
  }
});

// 13. GET /admin/escalated-requests — Admin lists all escalated and broadcasted requests
router.get('/admin/escalated-requests', authenticateAdmin, async (req, res) => {
  try {
    const db = await connectDB();
    const requests = await db.collection('service_requests').find({
      $or: [
        { 'escalation.isEscalated': true },
        { 'escalation.broadcast.isBroadcast': true },
        { status: 'escalated' },
        { status: 'broadcasted' },
      ],
    }).sort({ updatedAt: -1 }).toArray();

    res.json(requests.map(r => ({
      id: r._id.toString(),
      trackingId: r.trackingId,
      customerInfo: r.customerInfo,
      deviceInfo: r.deviceInfo,
      branchName: r.branchName,
      partnerName: r.partnerName,
      status: r.status,
      totalCost: r.totalCost,
      paymentStatus: r.paymentStatus,
      escalation: r.escalation,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })));
  } catch (error) {
    console.error('Error fetching admin escalated requests:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── REPAIR COST ESTIMATOR MANAGEMENT ───────────────────────────────

async function seedEstimatorDefaults(db) {
  const count = await db.collection('repair_estimator').countDocuments();
  if (count === 0) {
    const defaultData = [
      {
        id: 'phone',
        label: 'Smartphone',
        icon: '📱',
        isHidden: false,
        order: 1,
        issues: [
          { id: 'screen', label: 'Screen Replacement', min: 35000, max: 280000 },
          { id: 'battery', label: 'Battery Replacement', min: 20000, max: 85000 },
          { id: 'charging', label: 'Charging Port Repair', min: 15000, max: 55000 },
          { id: 'speaker', label: 'Speaker / Mic Repair', min: 18000, max: 60000 },
          { id: 'water', label: 'Water Damage Recovery', min: 40000, max: 150000 },
          { id: 'camera', label: 'Camera Module Repair', min: 30000, max: 120000 },
          { id: 'board', label: 'Motherboard / Board Repair', min: 50000, max: 200000 },
          { id: 'unlock', label: 'Network Unlock', min: 10000, max: 35000 },
        ],
        createdAt: new Date(),
      },
      {
        id: 'tablet',
        label: 'Tablet',
        icon: '🔲',
        isHidden: false,
        order: 2,
        issues: [
          { id: 'screen', label: 'Screen Replacement', min: 55000, max: 350000 },
          { id: 'battery', label: 'Battery Replacement', min: 40000, max: 100000 },
          { id: 'charging', label: 'Charging Port Repair', min: 20000, max: 65000 },
          { id: 'water', label: 'Water Damage Recovery', min: 60000, max: 180000 },
          { id: 'board', label: 'Board Level Repair', min: 80000, max: 250000 },
        ],
        createdAt: new Date(),
      },
      {
        id: 'laptop',
        label: 'Laptop / MacBook',
        icon: '💻',
        isHidden: false,
        order: 3,
        issues: [
          { id: 'screen', label: 'Screen Replacement', min: 80000, max: 450000 },
          { id: 'battery', label: 'Battery Replacement', min: 60000, max: 200000 },
          { id: 'keyboard', label: 'Keyboard Replacement', min: 50000, max: 180000 },
          { id: 'charging', label: 'Charging Port / DC Jack', min: 30000, max: 90000 },
          { id: 'water', label: 'Liquid Damage Recovery', min: 80000, max: 300000 },
          { id: 'board', label: 'Motherboard / GPU Repair', min: 100000, max: 500000 },
          { id: 'ssd', label: 'SSD / HDD Upgrade', min: 50000, max: 200000 },
          { id: 'os', label: 'OS Reinstall / Software', min: 20000, max: 50000 },
        ],
        createdAt: new Date(),
      },
      {
        id: 'desktop',
        label: 'Desktop / iMac',
        icon: '🖥️',
        isHidden: false,
        order: 4,
        issues: [
          { id: 'os', label: 'OS Reinstall / Software', min: 20000, max: 50000 },
          { id: 'gpu', label: 'GPU / Graphics Card Repair', min: 80000, max: 350000 },
          { id: 'psu', label: 'Power Supply Replacement', min: 60000, max: 180000 },
          { id: 'board', label: 'Motherboard Repair', min: 100000, max: 400000 },
          { id: 'build', label: 'Custom PC Build (Labour)', min: 50000, max: 150000 },
          { id: 'upgrade', label: 'RAM / Storage Upgrade', min: 30000, max: 120000 },
        ],
        createdAt: new Date(),
      },
      {
        id: 'console',
        label: 'Gaming Console',
        icon: '🎮',
        isHidden: false,
        order: 5,
        issues: [
          { id: 'hdmi', label: 'HDMI Port Replacement', min: 60000, max: 130000 },
          { id: 'disc', label: 'Disc Drive Repair', min: 70000, max: 160000 },
          { id: 'blod', label: 'BLOD / RLOD Fix (PS)', min: 80000, max: 200000 },
          { id: 'overheating', label: 'Overheating / Cleaning', min: 30000, max: 80000 },
          { id: 'controller', label: 'Controller Repair', min: 20000, max: 55000 },
          { id: 'storage', label: 'Storage / SSD Upgrade', min: 50000, max: 150000 },
        ],
        createdAt: new Date(),
      },
    ];
    await db.collection('repair_estimator').insertMany(defaultData);
  }
}

// GET /api/service-management/estimator — Public (or Admin ?all=true)
router.get('/estimator', async (req, res) => {
  try {
    const db = await connectDB();
    await seedEstimatorDefaults(db);

    const showAll = req.query.all === 'true';
    const filter = showAll ? {} : { isHidden: { $ne: true } };

    const categories = await db.collection('repair_estimator').find(filter).sort({ order: 1 }).toArray();

    res.json(categories.map(c => ({
      id: c.id || c._id.toString(),
      _id: c._id.toString(),
      label: c.label,
      icon: c.icon || '📱',
      isHidden: !!c.isHidden,
      order: c.order || 1,
      issues: c.issues || [],
      createdAt: c.createdAt,
    })));
  } catch (error) {
    console.error('Error fetching repair estimator data:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/service-management/estimator/categories — Admin creates a device category
router.post('/estimator/categories', authenticateAdmin, async (req, res) => {
  try {
    const { label, icon, order } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'Device type label is required' });
    }

    const db = await connectDB();
    const id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');

    const existing = await db.collection('repair_estimator').findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'A device type with this name already exists' });
    }

    const newCategory = {
      id,
      label: label.trim(),
      icon: icon || '📱',
      isHidden: false,
      order: order ? Number(order) : 99,
      issues: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('repair_estimator').insertOne(newCategory);
    res.status(201).json({ id, _id: result.insertedId.toString(), ...newCategory });
  } catch (error) {
    console.error('Error creating estimator category:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/service-management/estimator/categories/:id — Admin updates category (e.g. isHidden, label, icon)
router.put('/estimator/categories/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { label, icon, isHidden, order } = req.body;

    const db = await connectDB();
    const updateFields = { updatedAt: new Date() };
    if (label !== undefined) updateFields.label = label.trim();
    if (icon !== undefined) updateFields.icon = icon;
    if (isHidden !== undefined) updateFields.isHidden = Boolean(isHidden);
    if (order !== undefined) updateFields.order = Number(order);

    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const result = await db.collection('repair_estimator').updateOne(query, { $set: updateFields });

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json({ message: 'Device category updated successfully' });
  } catch (error) {
    console.error('Error updating estimator category:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/service-management/estimator/categories/:id — Admin deletes category
router.delete('/estimator/categories/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const db = await connectDB();

    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const result = await db.collection('repair_estimator').deleteOne(query);

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json({ message: 'Device category deleted successfully' });
  } catch (error) {
    console.error('Error deleting estimator category:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/service-management/estimator/categories/:categoryId/issues — Admin adds fixing/issue to device type
router.post('/estimator/categories/:categoryId/issues', authenticateAdmin, async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { label, min, max } = req.body;

    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'Fixing/issue name is required' });
    }

    const minPrice = Number(min) || 0;
    const maxPrice = Number(max) || minPrice;

    const db = await connectDB();
    const issueId = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString().slice(-4);

    const newIssue = {
      id: issueId,
      label: label.trim(),
      min: minPrice,
      max: maxPrice,
    };

    const query = ObjectId.isValid(categoryId) ? { $or: [{ _id: new ObjectId(categoryId) }, { id: categoryId }] } : { id: categoryId };
    const result = await db.collection('repair_estimator').updateOne(
      query,
      { $push: { issues: newIssue }, $set: { updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.status(201).json(newIssue);
  } catch (error) {
    console.error('Error adding issue to category:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/service-management/estimator/categories/:categoryId/issues/:issueId — Admin edits fixing/issue
router.put('/estimator/categories/:categoryId/issues/:issueId', authenticateAdmin, async (req, res) => {
  try {
    const { categoryId, issueId } = req.params;
    const { label, min, max } = req.body;

    const db = await connectDB();
    const query = ObjectId.isValid(categoryId) ? { $or: [{ _id: new ObjectId(categoryId) }, { id: categoryId }] } : { id: categoryId };
    const category = await db.collection('repair_estimator').findOne(query);

    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const issueIndex = (category.issues || []).findIndex(i => i.id === issueId);
    if (issueIndex === -1) {
      return res.status(404).json({ error: 'Fixing/issue not found' });
    }

    if (label !== undefined) category.issues[issueIndex].label = label.trim();
    if (min !== undefined) category.issues[issueIndex].min = Number(min);
    if (max !== undefined) category.issues[issueIndex].max = Number(max);

    await db.collection('repair_estimator').updateOne(
      { _id: category._id },
      { $set: { issues: category.issues, updatedAt: new Date() } }
    );

    res.json(category.issues[issueIndex]);
  } catch (error) {
    console.error('Error updating issue:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/service-management/estimator/categories/:categoryId/issues/:issueId — Admin deletes fixing/issue
router.delete('/estimator/categories/:categoryId/issues/:issueId', authenticateAdmin, async (req, res) => {
  try {
    const { categoryId, issueId } = req.params;

    const db = await connectDB();
    const query = ObjectId.isValid(categoryId) ? { $or: [{ _id: new ObjectId(categoryId) }, { id: categoryId }] } : { id: categoryId };

    const result = await db.collection('repair_estimator').updateOne(
      query,
      { $pull: { issues: { id: issueId } }, $set: { updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json({ message: 'Fixing/issue deleted successfully' });
  } catch (error) {
    console.error('Error deleting issue:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

