const express = require('express');
const { ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const connectDB = require('../utils/db');
const router = express.Router();

// GET /api/branches - List all branches with staff counts
router.get('/', async (req, res) => {
  try {
    const db = await connectDB();
    const branches = await db.collection('branches').find({}).sort({ createdAt: -1 }).toArray();

    // Attach staff count to each branch
    const branchesWithStaffCount = await Promise.all(
      branches.map(async (branch) => {
        const staffCount = await db.collection('branch_staff').countDocuments({
          branchId: branch._id.toString(),
        });
        return {
          id: branch._id.toString(),

          name: branch.name,
          description: branch.description,
          region: branch.region,
          district: branch.district,
          ward: branch.ward,
          streetName: branch.streetName,
          coordinates: branch.coordinates || { lat: -6.7924, lng: 39.2083 }, // Default Dar es Salaam coords if not set
          createdAt: branch.createdAt,
          staffCount,
        };
      })
    );

    res.json(branchesWithStaffCount);
  } catch (error) {
    console.error('Error fetching branches:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/branches/:id - Get specific branch with staff list
router.get('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid branch ID' });

    const branch = await db.collection('branches').findOne({ _id: new ObjectId(id) });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const staffList = await db
      .collection('branch_staff')
      .find({ branchId: id })
      .project({ password: 0 }) // Exclude hashed password
      .sort({ createdAt: -1 })
      .toArray();

    const formattedStaff = staffList.map((s) => ({
      id: s._id.toString(),
      fullName: s.fullName,
      phoneNumber: s.phoneNumber,
      email: s.email,
      role: s.role,
      branchId: s.branchId,
      createdAt: s.createdAt,
    }));

    res.json({
      id: branch._id.toString(),
      name: branch.name,
      description: branch.description,
      region: branch.region,
      district: branch.district,
      ward: branch.ward,
      streetName: branch.streetName,
      coordinates: branch.coordinates || { lat: -6.7924, lng: 39.2083 },
      createdAt: branch.createdAt,
      staff: formattedStaff,
    });
  } catch (error) {
    console.error('Error fetching branch details:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/branches - Create new branch
router.post('/', async (req, res) => {
  try {
    const db = await connectDB();
    const { name, description, region, district, ward, streetName, coordinates } = req.body;

    if (!name) return res.status(400).json({ error: 'Branch Name is required' });

    const newBranch = {
      name,
      description: description || '',
      region: region || '',
      district: district || '',
      ward: ward || '',
      streetName: streetName || '',
      coordinates: {
        lat: Number(coordinates?.lat) || -6.7924,
        lng: Number(coordinates?.lng) || 39.2083,
      },
      createdAt: new Date(),
    };

    const result = await db.collection('branches').insertOne(newBranch);
    res.status(201).json({
      message: 'Branch created successfully',
      branch: {
        id: result.insertedId.toString(),
        ...newBranch,
        staffCount: 0,
      },
    });
  } catch (error) {
    console.error('Error creating branch:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/branches/:id - Update branch
router.put('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid branch ID' });

    const { name, description, region, district, ward, streetName, coordinates } = req.body;

    const updateFields = {
      name,
      description: description || '',
      region: region || '',
      district: district || '',
      ward: ward || '',
      streetName: streetName || '',
      coordinates: {
        lat: Number(coordinates?.lat) || -6.7924,
        lng: Number(coordinates?.lng) || 39.2083,
      },
      updatedAt: new Date(),
    };

    await db.collection('branches').updateOne({ _id: new ObjectId(id) }, { $set: updateFields });

    res.json({ message: 'Branch updated successfully' });
  } catch (error) {
    console.error('Error updating branch:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/branches/:id - Delete branch & associated staff
router.delete('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid branch ID' });

    await db.collection('branches').deleteOne({ _id: new ObjectId(id) });
    await db.collection('branch_staff').deleteMany({ branchId: id });

    res.json({ message: 'Branch and staff deleted successfully' });
  } catch (error) {
    console.error('Error deleting branch:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/branches/:id/staff - Add Receptionist or Technician to branch
router.post('/:id/staff', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid branch ID' });

    const branch = await db.collection('branches').findOne({ _id: new ObjectId(id) });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const { fullName, phoneNumber, email, defaultPassword, role } = req.body;

    if (!fullName || !email || !defaultPassword || !role) {
      return res.status(400).json({ error: 'Full Name, Email, Default Password, and Role are required' });
    }

    if (!['Receptionist', 'Technician'].includes(role)) {
      return res.status(400).json({ error: 'Role must be either Receptionist or Technician' });
    }

    const existingStaff = await db.collection('branch_staff').findOne({
      $or: [{ email: email.toLowerCase().trim() }, { phoneNumber: phoneNumber?.trim() }],
    });

    if (existingStaff) {
      return res.status(409).json({ error: 'A staff member with this Email or Phone Number already exists' });
    }

    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    const newStaff = {
      branchId: id,
      branchName: branch.name,
      fullName: fullName.trim(),
      phoneNumber: phoneNumber ? phoneNumber.trim() : '',
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      role, // 'Receptionist' or 'Technician'
      createdAt: new Date(),
    };

    const result = await db.collection('branch_staff').insertOne(newStaff);

    res.status(201).json({
      message: `${role} added successfully`,
      staff: {
        id: result.insertedId.toString(),
        fullName: newStaff.fullName,
        phoneNumber: newStaff.phoneNumber,
        email: newStaff.email,
        role: newStaff.role,
        branchId: newStaff.branchId,
        branchName: newStaff.branchName,
        createdAt: newStaff.createdAt,
      },
    });
  } catch (error) {
    console.error('Error adding staff member:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/branches/staff/:staffId/reset-password - Admin resets staff password
router.post('/staff/:staffId/reset-password', async (req, res) => {
  try {
    const db = await connectDB();
    const { staffId } = req.params;
    const { newPassword } = req.body;

    if (!ObjectId.isValid(staffId)) return res.status(400).json({ error: 'Invalid staff ID' });
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const result = await db.collection('branch_staff').updateOne(
      { _id: new ObjectId(staffId) },
      { $set: { password: hashedPassword, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Staff member not found' });

    res.json({ message: 'Staff password reset successfully' });
  } catch (error) {
    console.error('Error resetting staff password:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/branches/:id/staff/:staffId - Delete staff member
router.delete('/:id/staff/:staffId', async (req, res) => {
  try {
    const db = await connectDB();
    const { staffId } = req.params;
    if (!ObjectId.isValid(staffId)) return res.status(400).json({ error: 'Invalid staff ID' });

    await db.collection('branch_staff').deleteOne({ _id: new ObjectId(staffId) });
    res.json({ message: 'Staff member removed successfully' });
  } catch (error) {
    console.error('Error removing staff member:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
