const express = require('express');
const { ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const connectDB = require('../utils/db');

const router = express.Router();

// GET /api/partners - List all partners with assigned requests count & total revenue
router.get('/', async (req, res) => {
  try {
    const db = await connectDB();
    const partners = await db.collection('partners').find({}).sort({ createdAt: -1 }).toArray();

    const partnersWithStats = await Promise.all(
      partners.map(async (partner) => {
        const partnerId = partner._id.toString();

        // Find service requests assigned to this partner
        const requests = await db.collection('service_requests').find({ partnerId }).toArray();
        const totalRequests = requests.length;

        // Calculate revenue from paid requests
        const totalRevenue = requests
          .filter((r) => r.paymentStatus === 'paid')
          .reduce((sum, r) => sum + (r.totalCost || 0), 0);

        return {
          id: partnerId,
          businessName: partner.businessName || partner.fullName,
          fullName: partner.fullName,
          phoneNumber: partner.phoneNumber,
          email: partner.email,
          region: partner.region,
          district: partner.district,
          ward: partner.ward,
          streetName: partner.streetName,
          coordinates: partner.coordinates || { lat: -6.7924, lng: 39.2083 },
          totalRequests,
          totalRevenue,
          createdAt: partner.createdAt,
        };
      })
    );

    res.json(partnersWithStats);
  } catch (error) {
    console.error('Error fetching partners:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/partners/:id - Get specific partner details with job history, revenue, expenses & profit share
router.get('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid partner ID' });

    const partner = await db.collection('partners').findOne({ _id: new ObjectId(id) });
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    // Fetch assigned or registered service requests
    const requests = await db
      .collection('service_requests')
      .find({
        $or: [
          { partnerId: id },
          { 'registeredBy.id': id }
        ]
      })
      .sort({ createdAt: -1 })
      .toArray();

    let totalRevenue = 0;
    let totalExpenses = 0;
    let partnerTotalPayout = 0;

    const formattedRequests = requests.map((r) => {
      const cards = r.serviceCards || [];
      const isEscalated = !!r.escalation?.isEscalated;
      const isEscalator = isEscalated && (
        r.escalation?.escalatedBy?.partnerId?.toString() === partnerId ||
        r.escalation?.escalatedBy?.id?.toString() === partnerId
      );

      let partnerPayout = revenue;
      if (isEscalated) {
        if (isEscalator) {
          partnerPayout = r.escalation?.partnerAFee || 0;
        } else {
          partnerPayout = r.escalation?.partnerBFee !== undefined
            ? r.escalation.partnerBFee
            : Math.max(0, revenue - (r.escalation?.partnerAFee || 0) - (r.escalation?.adminFee || 0));
        }
      } else if (r.partnerPayout !== undefined) {
        partnerPayout = r.partnerPayout;
      }

      if (r.paymentStatus === 'paid') {
        totalRevenue += revenue;
        totalExpenses += expenses;
        partnerTotalPayout += partnerPayout;
      }

      return {
        id: r._id.toString(),
        trackingId: r.trackingId,
        customerInfo: r.customerInfo,
        deviceInfo: r.deviceInfo,
        totalCost: revenue,
        repairExpense: expenses,
        netProfit,
        partnerPayout,
        isPartnerEscalation: !!r.isPartnerEscalation,
        status: r.status,
        paymentStatus: r.paymentStatus,
        createdAt: r.createdAt,
        paidAt: r.paidAt,
      };
    });

    const netProfit = totalRevenue - totalExpenses;

    res.json({
      id: partner._id.toString(),
      businessName: partner.businessName || partner.fullName,
      fullName: partner.fullName,
      phoneNumber: partner.phoneNumber,
      email: partner.email,
      region: partner.region,
      district: partner.district,
      ward: partner.ward,
      streetName: partner.streetName,
      coordinates: partner.coordinates || { lat: -6.7924, lng: 39.2083 },
      totalRequests: requests.length,
      totalRevenue,
      totalExpenses,
      netProfit,
      partnerTotalPayout,
      createdAt: partner.createdAt,
      requests: formattedRequests,
    });
  } catch (error) {
    console.error('Error fetching partner details:', error);
    res.status(500).json({ error: error.message });
  }
});


// POST /api/partners - Register new Partner
router.post('/', async (req, res) => {
  try {
    const db = await connectDB();
    const { fullName, businessName, phoneNumber, email, defaultPassword, region, district, ward, streetName, coordinates } = req.body;

    if (!fullName || !email || !defaultPassword) {
      return res.status(400).json({ error: 'Full Name, Email, and Default Password are required' });
    }

    const existingPartner = await db.collection('partners').findOne({
      $or: [{ email: email.toLowerCase().trim() }, { phoneNumber: phoneNumber?.trim() }],
    });

    if (existingPartner) {
      return res.status(409).json({ error: 'A partner with this Email or Phone Number already exists' });
    }

    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    const newPartner = {
      fullName: fullName.trim(),
      businessName: businessName ? businessName.trim() : fullName.trim(),
      phoneNumber: phoneNumber ? phoneNumber.trim() : '',
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      region: region || 'Dar es Salaam',
      district: district || '',
      ward: ward || '',
      streetName: streetName || '',
      coordinates: {
        lat: Number(coordinates?.lat) || -6.7924,
        lng: Number(coordinates?.lng) || 39.2083,
      },
      createdAt: new Date(),
    };

    const result = await db.collection('partners').insertOne(newPartner);

    res.status(201).json({
      message: 'Partner registered successfully',
      partner: {
        id: result.insertedId.toString(),
        fullName: newPartner.fullName,
        businessName: newPartner.businessName,
        phoneNumber: newPartner.phoneNumber,
        email: newPartner.email,
        region: newPartner.region,
        district: newPartner.district,
        ward: newPartner.ward,
        streetName: newPartner.streetName,
        coordinates: newPartner.coordinates,
        createdAt: newPartner.createdAt,
      },
    });
  } catch (error) {
    console.error('Error registering partner:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/partners/:id - Update Partner profile & location
router.put('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid partner ID' });

    const { fullName, businessName, phoneNumber, email, region, district, ward, streetName, coordinates } = req.body;

    const updateFields = {
      fullName: fullName ? fullName.trim() : undefined,
      businessName: businessName ? businessName.trim() : undefined,
      phoneNumber: phoneNumber ? phoneNumber.trim() : undefined,
      email: email ? email.toLowerCase().trim() : undefined,
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

    // Remove undefined fields
    Object.keys(updateFields).forEach((key) => updateFields[key] === undefined && delete updateFields[key]);

    await db.collection('partners').updateOne({ _id: new ObjectId(id) }, { $set: updateFields });

    res.json({ message: 'Partner updated successfully' });
  } catch (error) {
    console.error('Error updating partner:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/partners/:id/reset-password - Admin resets partner password
router.post('/:id/reset-password', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid partner ID' });
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const result = await db.collection('partners').updateOne(
      { _id: new ObjectId(id) },
      { $set: { password: hashedPassword, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Partner not found' });

    res.json({ message: 'Partner password reset successfully' });
  } catch (error) {
    console.error('Error resetting partner password:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/partners/:id - Delete Partner
router.delete('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid partner ID' });

    await db.collection('partners').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Partner deleted successfully' });
  } catch (error) {
    console.error('Error deleting partner:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
