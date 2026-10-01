const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');

const { sendMail } = require('../utils/emailService');
const { defaultPermissions } = require('./staffPermissionsRouter');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// Middleware for authenticating Branch Staff JWT token
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

// POST /api/branch-staff/login - Staff/Partner Login (Receptionist, Technician, or Partner)
router.post('/login', async (req, res) => {
  try {
    const db = await connectDB();
    const { emailOrPhone, password } = req.body;

    if (!emailOrPhone || !password) {
      return res.status(400).json({ error: 'Email/Phone and Password are required' });
    }

    const input = emailOrPhone.toLowerCase().trim();

    // First search in branch_staff
    let staffMember = await db.collection('branch_staff').findOne({
      $or: [{ email: input }, { phoneNumber: input }],
    });

    let isPartner = false;
    let partner = null;
    let isPartnerUser = false;
    let partnerUser = null;

    if (!staffMember) {
      // Check in partners collection (Business Owners)
      partner = await db.collection('partners').findOne({
        $or: [{ email: input }, { phoneNumber: input }],
      });
      if (partner) {
        isPartner = true;
      }
    }

    if (!staffMember && !partner) {
      // Check in partner_users collection (Partner sub-users)
      partnerUser = await db.collection('partner_users').findOne({
        $or: [{ email: input }, { phoneNumber: input }],
      });
      if (partnerUser) {
        isPartnerUser = true;
      }
    }

    if (!staffMember && !partner && !isPartnerUser) {
      // Check in users collection for admin accounts
      const userAdmin = await db.collection('users').findOne({
        $or: [{ email: input }, { username: input }],
        role: 'admin',
      });
      if (userAdmin) {
        staffMember = {
          _id: userAdmin._id,
          fullName: userAdmin.fullName || 'System Admin',
          email: userAdmin.email || userAdmin.username,
          phoneNumber: userAdmin.phoneNumber || '',
          password: userAdmin.password,
          role: 'admin',
        };
      }
    }

    if (!staffMember && !partner && !isPartnerUser) {
      return res.status(401).json({ error: 'Invalid Email/Phone or Password' });
    }

    const targetUser = isPartner ? partner : (isPartnerUser ? partnerUser : staffMember);
    const isMatch = await bcrypt.compare(password, targetUser.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid Email/Phone or Password' });
    }

    // Check if account has been deactivated
    if (staffMember && staffMember.role !== 'admin' && staffMember.isActive === false) {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact your branch administrator.' });
    }
    if (isPartnerUser && partnerUser.isActive === false) {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact your business administrator.' });
    }

    // ── Admin Branch Selection Flow ────────────────────────────────────
    // If the logged-in user is an admin (role: 'admin'), they must pick
    // which branch they want to inspect. Return all branches for selection.
    if (!isPartner && !isPartnerUser && staffMember.role === 'admin') {
      const branches = await db.collection('branches').find({}).sort({ name: 1 }).toArray();
      const branchList = branches.map((b) => ({
        id: b._id.toString(),
        name: b.name,
        region: b.region || '',
        district: b.district || '',
        ward: b.ward || '',
        streetName: b.streetName || '',
        coordinates: b.coordinates || null,
      }));

      return res.json({
        requiresBranchSelection: true,
        adminId: staffMember._id.toString(),
        adminFullName: staffMember.fullName,
        adminEmail: staffMember.email,
        branches: branchList,
        message: 'Admin credentials verified. Please select a branch to access.',
      });
    }

    let payload;
    if (isPartner) {
      payload = {
        id: partner._id.toString(),
        partnerId: partner._id.toString(),
        fullName: partner.fullName,
        businessName: partner.businessName || partner.fullName,
        email: partner.email,
        phoneNumber: partner.phoneNumber,
        role: 'Partner',
        branchId: null,
        branchName: partner.businessName || partner.fullName,
        isOwner: true,
        permissions: { canManageInventory: true, canPerformSales: true, canManagePurchases: true },
        isActive: true,
      };
    } else if (isPartnerUser) {
      let partnerDoc = null;
      if (partnerUser.partnerId && ObjectId.isValid(partnerUser.partnerId)) {
        partnerDoc = await db.collection('partners').findOne({ _id: new ObjectId(partnerUser.partnerId) });
      }
      const bName = partnerDoc ? (partnerDoc.businessName || partnerDoc.fullName) : 'Partner Business';
      payload = {
        id: partnerUser._id.toString(),
        partnerId: partnerUser.partnerId,
        fullName: partnerUser.fullName,
        email: partnerUser.email,
        phoneNumber: partnerUser.phoneNumber || '',
        role: partnerUser.role, // 'Cashier', 'Receptionist', 'Technician'
        branchId: null,
        branchName: bName,
        partnerName: bName,
        permissions: partnerUser.permissions || defaultPermissions(partnerUser.role),
        isActive: partnerUser.isActive !== false,
        isOwner: false,
      };
    } else {
      let branchName = staffMember.branchName || '';
      if (staffMember.branchId && ObjectId.isValid(staffMember.branchId)) {
        const branch = await db.collection('branches').findOne({ _id: new ObjectId(staffMember.branchId) });
        if (branch) branchName = branch.name;
      }

      payload = {
        id: staffMember._id.toString(),
        fullName: staffMember.fullName,
        email: staffMember.email,
        phoneNumber: staffMember.phoneNumber,
        role: staffMember.role, // 'Manager', 'Receptionist', 'Cashier', 'Technician'
        branchId: staffMember.branchId,
        branchName,
        permissions: staffMember.permissions || defaultPermissions(staffMember.role),
        isActive: staffMember.isActive !== false,
      };
    }

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      staff: payload,
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/branch-staff/admin-branch-login
// Admin selects a branch to view — issues a token scoped to that branch with role 'Admin'
router.post('/admin-branch-login', async (req, res) => {
  try {
    const db = await connectDB();
    const { emailOrPhone, password, branchId } = req.body;

    if (!emailOrPhone || !password || !branchId) {
      return res.status(400).json({ error: 'Email, password, and branchId are required' });
    }

    if (!ObjectId.isValid(branchId)) {
      return res.status(400).json({ error: 'Invalid branch ID' });
    }

    const input = emailOrPhone.toLowerCase().trim();
    let adminStaff = await db.collection('branch_staff').findOne({
      $or: [{ email: input }, { phoneNumber: input }],
    });

    if (!adminStaff) {
      const userAdmin = await db.collection('users').findOne({
        $or: [{ email: input }, { username: input }],
        role: 'admin',
      });
      if (userAdmin) {
        adminStaff = {
          _id: userAdmin._id,
          fullName: userAdmin.fullName || 'System Admin',
          email: userAdmin.email || userAdmin.username,
          phoneNumber: userAdmin.phoneNumber || '',
          password: userAdmin.password,
          role: 'admin',
        };
      }
    }

    if (!adminStaff || adminStaff.role !== 'admin') {
      return res.status(403).json({ error: 'Admin credentials required' });
    }

    const isMatch = await bcrypt.compare(password, adminStaff.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Fetch the selected branch
    const branch = await db.collection('branches').findOne({ _id: new ObjectId(branchId) });
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    const payload = {
      id: adminStaff._id.toString(),
      fullName: adminStaff.fullName,
      email: adminStaff.email,
      phoneNumber: adminStaff.phoneNumber || '',
      role: 'Admin',           // Distinguishable from 'admin' (system), 'Receptionist', 'Technician'
      isAdminViewing: true,    // Flag so UI can display admin-specific UI
      branchId: branch._id.toString(),
      branchName: branch.name,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });

    res.json({
      message: `Admin access granted to branch: ${branch.name}`,
      token,
      staff: {
        ...payload,
        branchDetails: {
          name: branch.name,
          description: branch.description || '',
          region: branch.region || '',
          district: branch.district || '',
          ward: branch.ward || '',
          streetName: branch.streetName || '',
          coordinates: branch.coordinates || null,
        },
      },
    });
  } catch (error) {
    console.error('[Admin Branch Login] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/branch-staff/admin-switch-branch
// Switch branch on the fly for an already authenticated admin session
router.post('/admin-switch-branch', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { branchId } = req.body;

    if (!branchId || !ObjectId.isValid(branchId)) {
      return res.status(400).json({ error: 'Valid branchId is required' });
    }

    if (req.staff.role !== 'Admin' && !req.staff.isAdminViewing) {
      return res.status(403).json({ error: 'Only administrators can switch branches' });
    }

    const branch = await db.collection('branches').findOne({ _id: new ObjectId(branchId) });
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    const payload = {
      id: req.staff.id,
      fullName: req.staff.fullName,
      email: req.staff.email,
      phoneNumber: req.staff.phoneNumber || '',
      role: 'Admin',
      isAdminViewing: true,
      branchId: branch._id.toString(),
      branchName: branch.name,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });

    res.json({
      message: `Switched to branch: ${branch.name}`,
      token,
      staff: {
        ...payload,
        branchDetails: {
          name: branch.name,
          description: branch.description || '',
          region: branch.region || '',
          district: branch.district || '',
          ward: branch.ward || '',
          streetName: branch.streetName || '',
          coordinates: branch.coordinates || null,
        },
      },
    });
  } catch (error) {
    console.error('[Admin Switch Branch] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/branch-staff/me - Get logged-in staff/partner profile & branch/location info
router.get('/me', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    if (!ObjectId.isValid(req.staff.id)) return res.status(400).json({ error: 'Invalid staff/partner ID' });

    // Admin viewing a branch — reconstruct from JWT + live branch data
    if (req.staff.role === 'Admin' && req.staff.isAdminViewing) {
      let adminStaff = await db.collection('branch_staff').findOne({ _id: new ObjectId(req.staff.id) });
      if (!adminStaff) {
        adminStaff = await db.collection('users').findOne({ _id: new ObjectId(req.staff.id) });
      }
      let branch = null;
      if (req.staff.branchId && ObjectId.isValid(req.staff.branchId)) {
        branch = await db.collection('branches').findOne({ _id: new ObjectId(req.staff.branchId) });
      }
      const allBranches = await db.collection('branches').find({}).sort({ name: 1 }).toArray();

      return res.json({
        id: req.staff.id,
        fullName: adminStaff ? adminStaff.fullName : req.staff.fullName,
        email: adminStaff ? adminStaff.email : req.staff.email,
        phoneNumber: adminStaff ? adminStaff.phoneNumber : req.staff.phoneNumber,
        role: 'Admin',
        isAdminViewing: true,
        branchId: req.staff.branchId,
        branchName: branch ? branch.name : req.staff.branchName,
        availableBranches: allBranches.map((b) => ({
          id: b._id.toString(),
          name: b.name,
          region: b.region || '',
          district: b.district || '',
          ward: b.ward || '',
          streetName: b.streetName || '',
        })),
        branchDetails: branch
          ? {
              name: branch.name,
              description: branch.description || '',
              region: branch.region || '',
              district: branch.district || '',
              ward: branch.ward || '',
              streetName: branch.streetName || '',
              coordinates: branch.coordinates || null,
            }
          : null,
      });
    }

    if (req.staff.role === 'Partner') {
      const partner = await db.collection('partners').findOne({ _id: new ObjectId(req.staff.id) });
      if (!partner) return res.status(404).json({ error: 'Partner profile not found' });

      return res.json({
        id: partner._id.toString(),
        partnerId: partner._id.toString(),
        fullName: partner.fullName,
        businessName: partner.businessName || partner.fullName,
        email: partner.email,
        phoneNumber: partner.phoneNumber,
        role: 'Partner',
        branchId: null,
        branchName: partner.businessName || partner.fullName,
        isOwner: true,
        permissions: { canManageInventory: true, canPerformSales: true, canManagePurchases: true },
        branchDetails: {
          name: partner.businessName || partner.fullName,
          description: 'Partner Location',
          region: partner.region,
          district: partner.district,
          ward: partner.ward,
          streetName: partner.streetName,
          coordinates: partner.coordinates,
        },
      });
    }

    let staff = await db.collection('branch_staff').findOne({ _id: new ObjectId(req.staff.id) });
    if (!staff) {
      // Check partner_users
      const pUser = await db.collection('partner_users').findOne({ _id: new ObjectId(req.staff.id) });
      if (pUser) {
        let partner = null;
        if (pUser.partnerId && ObjectId.isValid(pUser.partnerId)) {
          partner = await db.collection('partners').findOne({ _id: new ObjectId(pUser.partnerId) });
        }
        return res.json({
          id: pUser._id.toString(),
          fullName: pUser.fullName,
          email: pUser.email,
          phoneNumber: pUser.phoneNumber,
          role: pUser.role,
          partnerId: pUser.partnerId,
          partnerName: partner ? (partner.businessName || partner.fullName) : 'Partner Business',
          branchId: null,
          branchName: partner ? (partner.businessName || partner.fullName) : 'Partner Business',
          permissions: pUser.permissions || defaultPermissions(pUser.role),
          isActive: pUser.isActive !== false,
          isOwner: false,
          branchDetails: partner
            ? {
                name: partner.businessName || partner.fullName,
                description: 'Partner Location',
                region: partner.region,
                district: partner.district,
                ward: partner.ward,
                streetName: partner.streetName,
                coordinates: partner.coordinates,
              }
            : null,
        });
      }
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    let branch = null;
    if (staff.branchId && ObjectId.isValid(staff.branchId)) {
      branch = await db.collection('branches').findOne({ _id: new ObjectId(staff.branchId) });
    }

    res.json({
      id: staff._id.toString(),
      fullName: staff.fullName,
      email: staff.email,
      phoneNumber: staff.phoneNumber,
      role: staff.role,
      branchId: staff.branchId,
      branchName: branch ? branch.name : staff.branchName,
      permissions: staff.permissions || defaultPermissions(staff.role),
      isActive: staff.isActive !== false,
      branchDetails: branch
        ? {
            name: branch.name,
            description: branch.description,
            region: branch.region,
            district: branch.district,
            ward: branch.ward,
            streetName: branch.streetName,
            coordinates: branch.coordinates,
          }
        : null,
    });
  } catch (error) {
    console.error('Error fetching staff profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/branch-staff/change-password - Allow staff to change their own password
router.post('/change-password', authenticateBranchStaff, async (req, res) => {
  try {
    const db = await connectDB();
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    let collectionName = 'branch_staff';
    let user = await db.collection('branch_staff').findOne({ _id: new ObjectId(req.staff.id) });
    if (!user) {
      user = await db.collection('partner_users').findOne({ _id: new ObjectId(req.staff.id) });
      if (user) collectionName = 'partner_users';
    }
    if (!user) {
      user = await db.collection('partners').findOne({ _id: new ObjectId(req.staff.id) });
      if (user) collectionName = 'partners';
    }
    if (!user) {
      user = await db.collection('users').findOne({ _id: new ObjectId(req.staff.id) });
      if (user) collectionName = 'users';
    }
    if (!user) return res.status(404).json({ error: 'User profile not found' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const newHashedPassword = await bcrypt.hash(newPassword, 10);
    await db.collection(collectionName).updateOne(
      { _id: new ObjectId(req.staff.id) },
      { $set: { password: newHashedPassword, updatedAt: new Date() } }
    );

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Error changing staff password:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/branch-staff/forgot-password - Send 6-Digit OTP via Email
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }

    const inputEmail = email.trim().toLowerCase();
    const db = await connectDB();

    // Check if user exists in users, branch_staff, partners, or partner_users
    const [userRecord, staffRecord, partnerRecord, partnerUserRecord] = await Promise.all([
      db.collection('users').findOne({ $or: [{ email: inputEmail }, { username: inputEmail }] }),
      db.collection('branch_staff').findOne({ email: inputEmail }),
      db.collection('partners').findOne({ email: inputEmail }),
      db.collection('partner_users').findOne({ email: inputEmail }),
    ]);

    const targetAccount = userRecord || staffRecord || partnerRecord || partnerUserRecord;

    if (!targetAccount) {
      return res.status(404).json({ error: 'No account found registered with this email address.' });
    }

    // Generate 6-digit numeric OTP code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save OTP to database (upsert by email)
    await db.collection('password_resets').updateOne(
      { email: inputEmail },
      {
        $set: {
          email: inputEmail,
          otp,
          expiresAt,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    // Send Email OTP using emailService (updates@mocos.co.tz)
    const userName = targetAccount.fullName || targetAccount.businessName || targetAccount.username || 'User';
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px; color: #333; }
          .container { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.08); border: 1px solid #e5e7eb; }
          .header { background: linear-gradient(135deg, #111827 0%, #991b1b 100%); color: #ffffff; padding: 28px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 900; letter-spacing: -0.5px; }
          .header p { margin: 4px 0 0 0; font-size: 11px; color: #fca5a5; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; }
          .content { padding: 32px 28px; text-align: center; }
          .greeting { font-size: 16px; font-weight: 700; color: #111827; margin-bottom: 12px; }
          .text { font-size: 13px; color: #4b5563; line-height: 1.6; margin-bottom: 24px; }
          .otp-box { background: #fef2f2; border: 2px dashed #ef4444; border-radius: 16px; padding: 20px; margin: 20px 0; display: inline-block; width: 80%; }
          .otp-code { font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #991b1b; margin: 0; }
          .expiry { font-size: 11px; color: #dc2626; font-weight: 700; margin-top: 8px; }
          .footer { background-color: #f9fafb; padding: 18px 24px; text-align: center; font-size: 11px; color: #9ca3af; border-top: 1px solid #f3f4f6; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>MOCOS SERVICES</h1>
            <p>Password Reset Verification Code</p>
          </div>
          <div class="content">
            <div class="greeting">Hello ${userName},</div>
            <div class="text">You requested to reset your password. Use the 6-digit OTP verification code below to complete your password reset:</div>
            
            <div class="otp-box">
              <div class="otp-code">${otp}</div>
              <div class="expiry">⏱ Valid for 10 minutes</div>
            </div>

            <p style="font-size: 12px; color: #6b7280; margin-top: 20px;">If you did not request this password reset, please ignore this email or contact support immediately.</p>
          </div>
          <div class="footer">
            Sent securely via <strong>updates@mocos.co.tz</strong> &bull; MOCOS Electronics Services
          </div>
        </div>
      </body>
      </html>
    `;

    await sendMail({
      to: inputEmail,
      subject: `🔐 MOCOS Password Reset OTP: ${otp}`,
      html: htmlBody
    });

    console.log(`[Password Reset] OTP ${otp} sent to ${inputEmail}`);
    res.json({
      success: true,
      message: `A 6-digit OTP verification code has been sent to ${inputEmail}.`
    });

  } catch (error) {
    console.error('[Password Reset] Error in forgot-password:', error.message);
    res.status(500).json({ error: error.message || 'Failed to send OTP email' });
  }
});

// POST /api/branch-staff/reset-password-otp - Verify OTP and Set New Password
router.post('/reset-password-otp', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'Email, OTP code, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const inputEmail = email.trim().toLowerCase();
    const inputOtp = otp.trim();
    const db = await connectDB();

    // Check OTP record in password_resets collection
    const resetRecord = await db.collection('password_resets').findOne({
      email: inputEmail,
      otp: inputOtp
    });

    if (!resetRecord) {
      return res.status(400).json({ error: 'Invalid OTP verification code. Please check and try again.' });
    }

    if (new Date() > new Date(resetRecord.expiresAt)) {
      await db.collection('password_resets').deleteOne({ _id: resetRecord._id });
      return res.status(400).json({ error: 'Expired OTP code. Please request a new verification code.' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update across all user collections where matching email exists
    await Promise.all([
      db.collection('users').updateMany(
        { $or: [{ email: inputEmail }, { username: inputEmail }] },
        { $set: { password: hashedPassword, updatedAt: new Date() } }
      ),
      db.collection('branch_staff').updateMany(
        { email: inputEmail },
        { $set: { password: hashedPassword, updatedAt: new Date() } }
      ),
      db.collection('partners').updateMany(
        { email: inputEmail },
        { $set: { password: hashedPassword, updatedAt: new Date() } }
      ),
      db.collection('partner_users').updateMany(
        { email: inputEmail },
        { $set: { password: hashedPassword, updatedAt: new Date() } }
      )
    ]);

    // Delete used OTP
    await db.collection('password_resets').deleteOne({ _id: resetRecord._id });

    console.log(`[Password Reset] Password reset successfully for ${inputEmail}`);
    res.json({
      success: true,
      message: 'Your password has been successfully reset! You can now log in with your new password.'
    });

  } catch (error) {
    console.error('[Password Reset] Error in reset-password-otp:', error.message);
    res.status(500).json({ error: error.message || 'Failed to reset password' });
  }
});

module.exports = router;
