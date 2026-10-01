const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// ─── Auth Middleware ────────────────────────────────────────────────────────
function authenticateBranchStaff(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired session token' });
    req.staff = user;
    next();
  });
}

function isAdminOrManager(req) {
  const s = req.staff;
  if (!s) return false;
  const r = (s.role || '').toLowerCase();
  return (r === 'admin' && (s.isAdminViewing || true)) || r === 'manager';
}

function isPartnerOwner(req) {
  const s = req.staff;
  if (!s) return false;
  const r = (s.role || '').toLowerCase();
  return r === 'partner' && s.isOwner === true;
}

function canManageBranchStaffTarget(caller, targetStaff) {
  const callerRole = (caller.role || '').toLowerCase();
  if (callerRole === 'admin') return true;
  // Non-admin can only manage staff in their own branch
  if (targetStaff.branchId !== caller.branchId) return false;
  // Manager cannot manage Admin or other Managers
  const targetRole = (targetStaff.role || '').toLowerCase();
  if (targetRole === 'admin' || targetRole === 'manager') return false;
  return true;
}

function canManagePartnerUserTarget(caller, targetUser) {
  const callerRole = (caller.role || '').toLowerCase();
  if (callerRole === 'admin') return true;
  const partnerId = caller.partnerId || caller.id;
  return targetUser.partnerId === partnerId;
}

// ─── Default Permissions by Role ───────────────────────────────────────────
function defaultPermissions(role) {
  switch (role) {
    case 'Manager':
      return { canManageInventory: true, canPerformSales: true, canManagePurchases: true };
    case 'Receptionist':
      return { canManageInventory: true, canPerformSales: true, canManagePurchases: false };
    case 'Cashier':
      return { canManageInventory: false, canPerformSales: true, canManagePurchases: false };
    case 'Technician':
      return { canManageInventory: true, canPerformSales: false, canManagePurchases: false };
    default:
      return { canManageInventory: false, canPerformSales: false, canManagePurchases: false };
  }
}

function sanitizePermissions(perms, role) {
  const defaults = defaultPermissions(role);
  if (!perms || typeof perms !== 'object') return defaults;
  return {
    canManageInventory: perms.canManageInventory !== undefined ? Boolean(perms.canManageInventory) : defaults.canManageInventory,
    canPerformSales: perms.canPerformSales !== undefined ? Boolean(perms.canPerformSales) : defaults.canPerformSales,
    canManagePurchases: perms.canManagePurchases !== undefined ? Boolean(perms.canManagePurchases) : defaults.canManagePurchases,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BRANCH STAFF MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/branch-users', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Only Admin or Branch Manager can view branch users.' });
    }
    const db = await connectDB();
    const branchId = req.staff.branchId;
    if (!branchId) return res.status(400).json({ error: 'No branch context found in session.' });

    const staffList = await db.collection('branch_staff')
      .find({ branchId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(staffList.map(s => ({
      id: s._id.toString(),
      fullName: s.fullName,
      email: s.email,
      phoneNumber: s.phoneNumber || '',
      role: s.role,
      permissions: s.permissions || defaultPermissions(s.role),
      isActive: s.isActive !== false,
      createdAt: s.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/branch-users', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Only Admin or Branch Manager can add branch users.' });
    }
    const { fullName, email, phoneNumber, role, password, permissions } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }
    const validRoles = ['Receptionist', 'Technician', 'Manager', 'Cashier'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be Receptionist, Technician, Manager, or Cashier.' });
    }
    if (role === 'Manager' && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only System Admin can assign the Manager role.' });
    }

    const db = await connectDB();
    const branchId = req.staff.branchId;
    const existingEmail = await db.collection('branch_staff').findOne({ email: email.toLowerCase().trim() });
    if (existingEmail) return res.status(409).json({ error: 'A user with this email already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const perms = sanitizePermissions(permissions, role);

    const doc = {
      fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      phoneNumber: phoneNumber ? phoneNumber.trim() : '',
      role,
      password: hashedPassword,
      branchId,
      permissions: perms,
      isActive: true,
      addedBy: req.staff.id,
      addedByRole: req.staff.role,
      createdAt: new Date(),
    };

    const result = await db.collection('branch_staff').insertOne(doc);
    res.status(201).json({
      success: true,
      message: `${role} "${fullName}" added to branch successfully.`,
      user: { id: result.insertedId.toString(), fullName: doc.fullName, email: doc.email, phoneNumber: doc.phoneNumber, role: doc.role, permissions: doc.permissions, isActive: doc.isActive, createdAt: doc.createdAt },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/branch-users/:id/permissions', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Only Admin or Branch Manager can update permissions.' });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const staff = await db.collection('branch_staff').findOne({ _id: new ObjectId(id) });
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    if (!canManageBranchStaffTarget(req.staff, staff)) {
      return res.status(403).json({ error: 'You do not have permission to manage this staff member.' });
    }

    const perms = sanitizePermissions(req.body.permissions, staff.role);
    await db.collection('branch_staff').updateOne(
      { _id: new ObjectId(id) },
      { $set: { permissions: perms, updatedAt: new Date(), updatedBy: req.staff.id } }
    );

    res.json({ success: true, message: 'Permissions updated successfully.', permissions: perms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/branch-users/:id/role', authenticateBranchStaff, async (req, res) => {
  try {
    if (req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only System Admin can change staff roles.' });
    }
    const { id } = req.params;
    const { role } = req.body;
    const validRoles = ['Receptionist', 'Technician', 'Manager', 'Cashier'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const staff = await db.collection('branch_staff').findOne({ _id: new ObjectId(id) });
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    const newPerms = sanitizePermissions(defaultPermissions(role), role);
    await db.collection('branch_staff').updateOne(
      { _id: new ObjectId(id) },
      { $set: { role, permissions: newPerms, updatedAt: new Date() } }
    );

    res.json({ success: true, message: `Role updated to ${role}.`, role, permissions: newPerms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/branch-users/:id/toggle-active', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Only Admin or Branch Manager can activate/deactivate users.' });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const staff = await db.collection('branch_staff').findOne({ _id: new ObjectId(id) });
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    if (!canManageBranchStaffTarget(req.staff, staff)) {
      return res.status(403).json({ error: 'You do not have permission to modify this staff member.' });
    }

    const newStatus = !staff.isActive;
    await db.collection('branch_staff').updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive: newStatus, updatedAt: new Date() } }
    );

    res.json({ success: true, message: `User ${newStatus ? 'activated' : 'deactivated'} successfully.`, isActive: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/branch-users/:id/reset-password', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Only Admin or Branch Manager can reset passwords.' });
    }
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const staff = await db.collection('branch_staff').findOne({ _id: new ObjectId(id) });
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    if (!canManageBranchStaffTarget(req.staff, staff)) {
      return res.status(403).json({ error: 'You do not have permission to reset password for this staff member.' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.collection('branch_staff').updateOne(
      { _id: new ObjectId(id) },
      { $set: { password: hashed, updatedAt: new Date() } }
    );

    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/branch-users/:id', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Only Admin or Branch Manager can remove users.' });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const staff = await db.collection('branch_staff').findOne({ _id: new ObjectId(id) });
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    if (!canManageBranchStaffTarget(req.staff, staff)) {
      return res.status(403).json({ error: 'You do not have permission to remove this staff member.' });
    }

    await db.collection('branch_staff').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'Staff member removed from branch.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARTNER SUB-USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/partner-users', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isPartnerOwner(req) && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the Partner owner or Admin can view partner users.' });
    }
    const db = await connectDB();
    const partnerId = req.staff.partnerId || req.staff.id;

    const users = await db.collection('partner_users')
      .find({ partnerId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(users.map(u => ({
      id: u._id.toString(),
      fullName: u.fullName,
      email: u.email,
      phoneNumber: u.phoneNumber || '',
      role: u.role,
      permissions: u.permissions || defaultPermissions(u.role),
      isActive: u.isActive !== false,
      createdAt: u.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/partner-users', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isPartnerOwner(req) && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the Partner owner or Admin can add partner users.' });
    }
    const { fullName, email, phoneNumber, role, password, permissions } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }
    const validRoles = ['Cashier', 'Technician', 'Receptionist'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role for partner users. Must be Cashier, Technician, or Receptionist.' });
    }

    const db = await connectDB();
    const partnerId = req.staff.partnerId || req.staff.id;
    const existingEmail = await db.collection('partner_users').findOne({ email: email.toLowerCase().trim() });
    if (existingEmail) return res.status(409).json({ error: 'A user with this email already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const perms = sanitizePermissions(permissions, role);

    const doc = {
      fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      phoneNumber: phoneNumber ? phoneNumber.trim() : '',
      role,
      password: hashedPassword,
      partnerId,
      permissions: perms,
      isActive: true,
      addedBy: req.staff.id,
      createdAt: new Date(),
    };

    const result = await db.collection('partner_users').insertOne(doc);
    res.status(201).json({
      success: true,
      message: `${role} "${fullName}" added to your business successfully.`,
      user: { id: result.insertedId.toString(), fullName: doc.fullName, email: doc.email, phoneNumber: doc.phoneNumber, role: doc.role, permissions: doc.permissions, isActive: doc.isActive, createdAt: doc.createdAt },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/partner-users/:id/permissions', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isPartnerOwner(req) && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the Partner owner or Admin can update partner user permissions.' });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const user = await db.collection('partner_users').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: 'Partner user not found.' });

    const partnerId = req.staff.partnerId || req.staff.id;
    if (req.staff.role !== 'Admin' && user.partnerId !== partnerId) {
      return res.status(403).json({ error: 'You can only manage users in your own business.' });
    }

    const perms = sanitizePermissions(req.body.permissions, user.role);
    await db.collection('partner_users').updateOne(
      { _id: new ObjectId(id) },
      { $set: { permissions: perms, updatedAt: new Date() } }
    );

    res.json({ success: true, message: 'Permissions updated.', permissions: perms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/partner-users/:id/toggle-active', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isPartnerOwner(req) && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the Partner owner or Admin can activate/deactivate users.' });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const user = await db.collection('partner_users').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: 'Partner user not found.' });

    if (!canManagePartnerUserTarget(req.staff, user)) {
      return res.status(403).json({ error: 'You can only manage users in your own business.' });
    }

    const newStatus = !user.isActive;
    await db.collection('partner_users').updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive: newStatus, updatedAt: new Date() } }
    );

    res.json({ success: true, message: `User ${newStatus ? 'activated' : 'deactivated'}.`, isActive: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/partner-users/:id/reset-password', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isPartnerOwner(req) && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the Partner owner or Admin can reset passwords.' });
    }
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const user = await db.collection('partner_users').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: 'Partner user not found.' });

    if (!canManagePartnerUserTarget(req.staff, user)) {
      return res.status(403).json({ error: 'You can only manage users in your own business.' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.collection('partner_users').updateOne(
      { _id: new ObjectId(id) },
      { $set: { password: hashed, updatedAt: new Date() } }
    );

    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/partner-users/:id', authenticateBranchStaff, async (req, res) => {
  try {
    if (!isPartnerOwner(req) && req.staff.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the Partner owner or Admin can remove partner users.' });
    }
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const db = await connectDB();
    const user = await db.collection('partner_users').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: 'Partner user not found.' });

    if (!canManagePartnerUserTarget(req.staff, user)) {
      return res.status(403).json({ error: 'You can only manage users in your own business.' });
    }

    await db.collection('partner_users').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'User removed from business.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARTNER SUB-USER LOGIN
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/partner-user-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const db = await connectDB();
    const user = await db.collection('partner_users').findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.isActive === false) return res.status(403).json({ error: 'Your account has been deactivated. Contact your business owner.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });

    const partner = await db.collection('partners').findOne({ _id: new ObjectId(user.partnerId) });

    const payload = {
      id: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      partnerId: user.partnerId,
      partnerName: partner ? (partner.businessName || partner.fullName) : 'Partner',
      branchId: null,
      branchName: partner ? (partner.businessName || partner.fullName) : 'Partner',
      permissions: user.permissions || defaultPermissions(user.role),
      isOwner: false,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, staff: payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.defaultPermissions = defaultPermissions;
