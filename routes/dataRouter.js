const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const connectDB = require("../utils/db");
const fs = require("fs");
const path = require("path");

const config = require("../config");
const { broadcastNotification } = require("../utils/notificationEmitter");
const gcsStorage = require("../utils/gcsStorage");

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// Middleware to protect routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access denied" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// Register endpoint
router.post("/register", async (req, res) => {
  try {
    const db = await connectDB();
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    const existingUser = await db.collection("users").findOne({ username });
    if (existingUser) {
      return res.status(409).json({ error: "Username already exists" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await db
      .collection("users")
      .insertOne({ username, password: hashedPassword });
    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login endpoint
router.post("/login", async (req, res) => {
  try {
    const db = await connectDB();
    const { username, password } = req.body;
    console.log("Login attempt for username:", username);
    const user = await db.collection("users").findOne({ username });
    if (!user) {
      console.log("Login failed: User not found");
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const valid = await bcrypt.compare(password, user.password);
    // if (!valid) {
    //   console.log(user);
    //   return res.status(401).json({ error: 'Invalid credentials' });
    // }
    const token = jwt.sign(
      { username: user.username, id: user._id },
      JWT_SECRET,
      { expiresIn: "10h" }
    );
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST endpoint to receive data and save to MongoDB (protected)
router.post("/data", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { name, value } = req.body;
    const result = await db.collection("data").insertOne({ name, value });
    res
      .status(201)
      .json({ message: "Data saved successfully", data: result.ops[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/sellData", async (req, res) => {
  try {
    const db = await connectDB();
    const data = req.body;
    const doc = { ...data, submittedAt: new Date() };
    const result = await db.collection("sellData").insertOne(doc);
    
    // Broadcast real-time push notification
    broadcastNotification({
      type: "sell",
      title: "New Sell Offer Request",
      message: `${data.name || "A customer"} submitted a sell offer for ${data.deviceBrand || data.deviceName || data.item || "a device"}.`,
      link: "/sell-requests",
      data: { name: data.name, phone: data.phone }
    });

    res.status(201).json({ message: "Data saved successfully", data: result.ops ? result.ops[0] : doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/training-inquiry — Public: Customer submits training enrollment from website
router.post("/training-inquiry", async (req, res) => {
  try {
    const db = await connectDB();
    const { fullName, phone, email, program, description } = req.body;

    if (!fullName || !phone || !description || !program) {
      return res.status(400).json({ error: "Full name, phone, program, and description are required." });
    }

    const doc = {
      fullName: fullName.trim(),
      phone: phone.trim(),
      email: email ? email.trim() : "",
      program: program.trim(),
      description: description.trim(),
      status: "new",
      submittedAt: new Date(),
    };

    await db.collection("training_inquiries").insertOne(doc);

    broadcastNotification({
      type: "training_inquiry",
      title: `🎓 New Training Application — ${doc.program}`,
      message: `${doc.fullName} (${doc.phone}) applied for "${doc.program}". Note: ${doc.description.substring(0, 80)}${doc.description.length > 80 ? "…" : ""}`,
      link: "/web-requests",
      data: { name: doc.fullName, phone: doc.phone, program: doc.program },
    });

    res.status(201).json({ message: "Training application received! We will contact you within 24 hours." });
  } catch (error) {
    console.error("Error saving training inquiry:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/training-inquiries — Admin: List all training enrollment applications
router.get("/training-inquiries", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { status, search } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (search) {
      const q = new RegExp(search, "i");
      filter.$or = [{ fullName: q }, { phone: q }, { email: q }, { program: q }, { description: q }];
    }
    const items = await db.collection("training_inquiries").find(filter).sort({ submittedAt: -1 }).toArray();
    res.json(items.map((i) => ({ ...i, id: i._id.toString() })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/training-inquiries/:id/status — Admin: Update status
router.patch("/training-inquiries/:id/status", authenticateToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const db = await connectDB();
    const { id } = req.params;
    const { status } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });
    const valid = ["new", "contacted", "enrolled", "cancelled"];
    if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });
    await db.collection("training_inquiries").updateOne({ _id: new ObjectId(id) }, { $set: { status, updatedAt: new Date() } });
    res.json({ message: "Status updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/partner-application — Public: Submit a partnership application from Work With Us page
router.post("/partner-application", async (req, res) => {
  try {
    const db = await connectDB();
    const { fullName, phone, location, businessDescription } = req.body;
    if (!fullName || !phone || !location || !businessDescription) {
      return res.status(400).json({ error: "All fields (full name, phone, location, business description) are required." });
    }
    const doc = {
      fullName: fullName.trim(),
      phone: phone.trim(),
      location: location.trim(),
      businessDescription: businessDescription.trim(),
      status: "new",
      submittedAt: new Date(),
    };
    await db.collection("partner_applications").insertOne(doc);
    broadcastNotification({
      type: "partner_application",
      title: `🤝 New Partnership Application`,
      message: `${doc.fullName} (${doc.phone}) from ${doc.location} wants to partner with MOCOS. Business: ${doc.businessDescription.substring(0, 80)}${doc.businessDescription.length > 80 ? "…" : ""}`,
      link: "/web-requests?tab=partner-applications",
      data: { name: doc.fullName, phone: doc.phone, location: doc.location },
    });
    res.status(201).json({ message: "Partnership application received! Our team will reach out to you within 48 hours." });
  } catch (error) {
    console.error("Error saving partner application:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/partner-applications — Admin: List all partnership applications
router.get("/partner-applications", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { status, search } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (search) {
      const q = new RegExp(search, "i");
      filter.$or = [{ fullName: q }, { phone: q }, { location: q }, { businessDescription: q }];
    }
    const items = await db.collection("partner_applications").find(filter).sort({ submittedAt: -1 }).toArray();
    res.json(items.map((i) => ({ ...i, id: i._id.toString() })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/partner-applications/:id/status — Admin: Update status
router.patch("/partner-applications/:id/status", authenticateToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const db = await connectDB();
    const { id } = req.params;
    const { status } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });
    const valid = ["new", "reviewing", "approved", "rejected"];
    if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });
    await db.collection("partner_applications").updateOne({ _id: new ObjectId(id) }, { $set: { status, updatedAt: new Date() } });
    res.json({ message: "Status updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/location-inquiry — Public: Customer submits inquiry from a branch or partner card
router.post("/location-inquiry", async (req, res) => {
  try {
    const db = await connectDB();
    const {
      fullName,
      phoneNumber,
      locationAddress,
      issueDescription,
      // Selected location info
      locationId,
      locationName,
      locationType,   // 'branch' | 'partner'
      locationRegion,
    } = req.body;

    if (!fullName || !phoneNumber || !issueDescription) {
      return res.status(400).json({ error: "Full name, phone number, and issue description are required." });
    }

    const doc = {
      fullName: fullName.trim(),
      phoneNumber: phoneNumber.trim(),
      locationAddress: locationAddress ? locationAddress.trim() : "",
      issueDescription: issueDescription.trim(),
      selectedLocation: {
        id: locationId || null,
        name: locationName || "General",
        type: locationType || "branch",
        region: locationRegion || "",
      },
      status: "new",
      submittedAt: new Date(),
    };

    await db.collection("location_inquiries").insertOne(doc);

    // Broadcast real-time notification to admin dashboard
    broadcastNotification({
      type: "location_inquiry",
      title: `📍 New Walk-In Inquiry — ${doc.selectedLocation.name}`,
      message: `${doc.fullName} (${doc.phoneNumber}) has a service request at ${doc.selectedLocation.name}${doc.selectedLocation.region ? ` · ${doc.selectedLocation.region}` : ""}. Issue: ${doc.issueDescription.substring(0, 80)}${doc.issueDescription.length > 80 ? "…" : ""}`,
      link: "/web-requests?tab=location-inquiries",
      data: { name: doc.fullName, phone: doc.phoneNumber, location: doc.selectedLocation.name },
    });

    res.status(201).json({ message: "Your inquiry has been received! We will contact you shortly." });
  } catch (error) {
    console.error("Error saving location inquiry:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/location-inquiries — Admin: List all location inquiries with optional filters
router.get("/location-inquiries", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { status, type, search } = req.query;

    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (type && type !== 'all') filter['selectedLocation.type'] = type;
    if (search) {
      const q = new RegExp(search, 'i');
      filter.$or = [
        { fullName: q },
        { phoneNumber: q },
        { issueDescription: q },
        { 'selectedLocation.name': q },
        { 'selectedLocation.region': q },
        { locationAddress: q },
      ];
    }

    const items = await db.collection("location_inquiries")
      .find(filter)
      .sort({ submittedAt: -1 })
      .toArray();

    res.json(items.map((item) => ({
      id: item._id.toString(),
      fullName: item.fullName,
      phoneNumber: item.phoneNumber,
      locationAddress: item.locationAddress || '',
      issueDescription: item.issueDescription,
      selectedLocation: item.selectedLocation,
      status: item.status || 'new',
      submittedAt: item.submittedAt,
    })));
  } catch (error) {
    console.error("Error fetching location inquiries:", error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/location-inquiries/:id/status — Admin: Update inquiry status
router.patch("/location-inquiries/:id/status", authenticateToken, async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const db = await connectDB();
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });
    const validStatuses = ['new', 'contacted', 'resolved', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    await db.collection("location_inquiries").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } }
    );
    res.json({ message: 'Status updated successfully' });
  } catch (error) {
    console.error("Error updating inquiry status:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/repairData", async (req, res) => {
  try {
    const db = await connectDB();
    const data = req.body;
    const doc = { ...data, submittedAt: new Date() };
    const result = await db.collection("repairData").insertOne(doc);

    // Broadcast real-time push notification
    broadcastNotification({
      type: "repair",
      title: "New Remote Repair Request",
      message: `${data.remoteName || data.name || "A customer"} submitted a remote repair request.`,
      link: "/remote-requests",
      data: { name: data.remoteName || data.name, phone: data.remotePhone || data.phone }
    });

    res.status(201).json({ message: "Data saved successfully", data: result.ops ? result.ops[0] : doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/bookData", async (req, res) => {
  try {
    const db = await connectDB();
    const data = req.body;
    const doc = { ...data, submittedAt: new Date() };
    const result = await db.collection("bookData").insertOne(doc);

    // Broadcast real-time push notification
    broadcastNotification({
      type: "booking",
      title: "New Booking Request",
      message: `${data.bookName || data.name || "A customer"} submitted a booking request for ${data.bookDevice || data.device || "a repair service"}.`,
      link: "/bookings",
      data: { name: data.bookName || data.name, phone: data.bookPhone || data.phone }
    });

    res.status(201).json({ message: "Data saved successfully", data: result.ops ? result.ops[0] : doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tvHomeRepairData — Customer: Submit TV Home Repair request
router.post("/tvHomeRepairData", async (req, res) => {
  try {
    const db = await connectDB();
    const data = req.body;

    const { name, phone, tvSize, tvBrand, region, district, ward, street, problem } = data;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Full Name is required." });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: "Phone Number is required." });
    }
    const sizeNum = parseInt(tvSize, 10);
    if (isNaN(sizeNum) || sizeNum < 40) {
      return res.status(400).json({ error: "Acceptable TV size starts from 40 inches and above." });
    }
    if (!region || !region.trim()) {
      return res.status(400).json({ error: "Region is required." });
    }
    if (!district || !district.trim()) {
      return res.status(400).json({ error: "District is required." });
    }
    if (!ward || !ward.trim()) {
      return res.status(400).json({ error: "Ward is required." });
    }
    if (!street || !street.trim()) {
      return res.status(400).json({ error: "Street Name is required." });
    }
    if (!problem || !problem.trim()) {
      return res.status(400).json({ error: "Problem Description is required." });
    }

    const doc = {
      name: name.trim(),
      phone: phone.trim(),
      tvSize: sizeNum,
      tvBrand: (tvBrand || "").trim(),
      region: region.trim(),
      district: district.trim(),
      ward: ward.trim(),
      street: street.trim(),
      problem: problem.trim(),
      status: "Pending", // 'Pending' | 'Technician Assigned' | 'Completed' | 'Cancelled'
      submittedAt: new Date()
    };

    const result = await db.collection("tvHomeRepairData").insertOne(doc);

    // Broadcast real-time push notification for staff/admin
    broadcastNotification({
      type: "tv_repair",
      title: "📺 New TV Home Repair Request",
      message: `${doc.name} requested in-home repair for a ${doc.tvSize}" ${doc.tvBrand || 'TV'} in ${doc.district}, ${doc.region}.`,
      link: "/tv-home-repairs",
      data: { name: doc.name, phone: doc.phone, tvSize: doc.tvSize, region: doc.region }
    });

    res.status(201).json({
      success: true,
      message: `Your TV Home Repair request for your ${doc.tvSize}" TV has been received! Our technician team will contact you shortly to schedule an in-home visit.`,
      id: result.insertedId.toString(),
      data: doc
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tvHomeRepairData — Admin/Staff: List all TV Home Repair requests
router.get("/tvHomeRepairData", async (req, res) => {
  try {
    const db = await connectDB();
    const items = await db.collection("tvHomeRepairData").find().sort({ submittedAt: -1 }).toArray();
    res.json(items.map(item => ({
      id: item._id.toString(),
      name: item.name,
      phone: item.phone,
      tvSize: item.tvSize,
      tvBrand: item.tvBrand || '',
      region: item.region,
      district: item.district,
      ward: item.ward,
      street: item.street,
      problem: item.problem,
      status: item.status || 'Pending',
      submittedAt: item.submittedAt
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/bookData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("bookData").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $set: { new: "viewed" } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.get("/sellData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("sellData").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $set: { new: false } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});
router.get("/repairData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("repairData").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $set: { new: "viewed" } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ─── Status Update Endpoints ────────────────────────────────
router.patch("/bookData/:id/status", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const db = await connectDB();
    const { status, comment } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });
    
    const updateFields = { new: status };
    if (comment !== undefined) {
      updateFields.comment = comment;
    }
    
    const result = await db.collection("bookData").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.patch("/sellData/:id/status", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const db = await connectDB();
    const { status, comment } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });
    
    const updateFields = { new: status };
    if (comment !== undefined) {
      updateFields.comment = comment;
    }
    
    const result = await db.collection("sellData").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.patch("/repairData/:id/status", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const db = await connectDB();
    const { status, comment } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });
    
    const updateFields = { new: status };
    if (comment !== undefined) {
      updateFields.comment = comment;
    }
    
    const result = await db.collection("repairData").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ─── Delete Endpoints for Web Requests ──────────────────────────────
router.delete("/bookData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid booking request ID" });
  }
  try {
    const db = await connectDB();
    const result = await db.collection("bookData").deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Booking request not found" });
    }
    res.json({ message: "Booking request deleted successfully" });
  } catch (err) {
    console.error("Error deleting booking request:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.delete("/sellData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid sell request ID" });
  }
  try {
    const db = await connectDB();
    const result = await db.collection("sellData").deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Sell request not found" });
    }
    res.json({ message: "Sell request deleted successfully" });
  } catch (err) {
    console.error("Error deleting sell request:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.delete("/repairData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid remote repair request ID" });
  }
  try {
    const db = await connectDB();
    const result = await db.collection("repairData").deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Remote repair request not found" });
    }
    res.json({ message: "Remote repair request deleted successfully" });
  } catch (err) {
    console.error("Error deleting remote repair request:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// GET endpoint to fetch all data from MongoDB (protected)
router.get("/data", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("data").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/dashboard-stats", async (req, res) => {
  try {
    const db = await connectDB();
    const book = await db.collection("bookData").find({ new: "new" }).count();
    const sell = await db.collection("sellData").find({ new: "new" }).count();
    const repair = await db
      .collection("repairData")
      .find({ new: "new" })
      .count();
    const subscribers = await db.collection("newsletter_subscribers").countDocuments();
    res.status(200).json({ book, sell, repair, subscribers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/sellData", async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("sellData").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/repairData", async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("repairData").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Unauthenticated GET endpoint to fetch all data from MongoDB
router.get("/bookData", async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("bookData").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parseMetadataFromHtml(html) {
  if (!html || typeof html !== "string") return {};

  let meta = {};
  const scriptRegex = /<script\s+id="blog-metadata"\s+type="application\/json">([\s\S]*?)<\/script>/;
  const match = html.match(scriptRegex);
  if (match) {
    try {
      meta = JSON.parse(match[1]) || {};
    } catch (e) {}
  }

  const titleMatch = html.match(/<h[1-2]>([\s\S]*?)<\/h[1-2]>/);
  const title = meta.title || (titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "Untitled Post");

  let featuredImage = meta.featuredImage || "";
  if (!featuredImage) {
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/);
    featuredImage = imgMatch ? imgMatch[1] : "";
  }
  // Strip heavy base64 images from MongoDB metadata storage to preserve DB quota
  if (typeof featuredImage === "string" && featuredImage.startsWith("data:")) {
    featuredImage = "";
  }

  let summary = meta.summary || "No summary available.";
  if (summary === "No summary available.") {
    const pMatch = html.match(/<p>([\s\S]*?)<\/p>/);
    if (pMatch) {
      summary = pMatch[1].replace(/<[^>]*>/g, "").trim().slice(0, 140) + "...";
    }
  }

  return {
    title,
    summary,
    category: meta.category || "General",
    featuredImage,
    readTime: meta.readTime || "3 min read",
    author: meta.author || "Mocos Team",
  };
}

// POST a blog post (HTML as single text, unauthenticated, save to GCS & metadata to DB)
router.post("/blogpost", async (req, res) => {
  try {
    const db = await connectDB();
    const { html } = req.body;
    if (!html || typeof html !== "string" || !html.trim()) {
      return res.status(400).json({ error: "Blog post HTML content required" });
    }

    const meta = parseMetadataFromHtml(html);
    const createdAt = new Date();
    const filename = `${createdAt.getTime()}-${Math.round(Math.random() * 1e9)}.html`;
    const destPath = `blogposts/${filename}`;
    const url = await gcsStorage.uploadBuffer(html, destPath, "text/html");

    const doc = {
      url,
      gcsPath: destPath,
      createdAt,
      title: meta.title || "Untitled Post",
      summary: meta.summary || "No summary available.",
      category: meta.category || "General",
      featuredImage: meta.featuredImage || "",
      readTime: meta.readTime || "3 min read",
      author: meta.author || "Mocos Team",
      views: 0,
    };

    const result = await db.collection("blogposts").insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), url, createdAt, ...doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET the latest blog post (HTML stream, unauthenticated, fetch from GCS)
router.get("/blogpost", async (req, res) => {
  try {
    const db = await connectDB();
    const post = await db
      .collection("blogposts")
      .find()
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (!post) {
      return res.status(404).json({ error: "No blog post found" });
    }
    const gcsPath = post.gcsPath || (post.url && post.url.startsWith("http") ? gcsStorage.extractGcsPath(post.url) : `blogposts/${path.basename(post.url)}`);
    if (!gcsPath) return res.status(404).json({ error: "Blog post file not found" });

    const buffer = await gcsStorage.downloadFile(gcsPath);
    res.set("Content-Type", "text/html");
    res.send(buffer.toString("utf8"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET all blog posts metadata (lightweight, zero GCS overhead, pagination support)
router.get("/blogposts", async (req, res) => {
  try {
    const db = await connectDB();
    const limit = parseInt(req.query.limit) || 0;
    const page = parseInt(req.query.page) || 1;

    let query = db.collection("blogposts").find().sort({ createdAt: -1 });
    if (limit > 0) {
      query = query.skip((page - 1) * limit).limit(limit);
    }

    const posts = await query.toArray();

    const result = await Promise.all(posts.map(async (post) => {
      let title = post.title;
      let summary = post.summary;
      let category = post.category;
      let featuredImage = post.featuredImage;
      let readTime = post.readTime;
      let author = post.author;

      // Lazy-extract & backfill metadata for legacy DB documents missing title/summary
      if (!title || !summary) {
        try {
          const gcsPath = post.gcsPath || (post.url && post.url.startsWith("http") ? gcsStorage.extractGcsPath(post.url) : `blogposts/${path.basename(post.url)}`);
          if (gcsPath) {
            const buffer = await gcsStorage.downloadFile(gcsPath);
            const html = buffer.toString("utf8");
            const meta = parseMetadataFromHtml(html);
            title = meta.title;
            summary = meta.summary;
            category = meta.category;
            featuredImage = meta.featuredImage;
            readTime = meta.readTime;
            author = meta.author;

            db.collection("blogposts").updateOne(
              { _id: post._id },
              { $set: { title, summary, category, featuredImage, readTime, author } }
            ).catch(e => console.error("Error backfilling blog metadata:", e));
          }
        } catch (e) {
          console.error(`Failed to fetch HTML for blogpost ${post._id}:`, e.message);
        }
      }

      return {
        id: post._id.toString(),
        url: post.url,
        createdAt: post.createdAt,
        title: title || "Untitled Post",
        summary: summary || "No summary available.",
        category: category || "General",
        featuredImage: featuredImage || "",
        readTime: readTime || "3 min read",
        author: author || "Mocos Team",
        views: post.views || 0,
      };
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Lipa Namba Management Endpoints ──────────────────────────────
router.get("/lipa-namba", async (req, res) => {
  try {
    const db = await connectDB();
    let items = await db.collection("lipa_namba").find({}).sort({ createdAt: 1 }).toArray();
    if (items.length === 0) {
      const defaults = [
        { provider: "Lipa Mpesa", number: "5344198", name: "MOCO SERVICES", createdAt: new Date() },
        { provider: "Mpesa", number: "0767379327", name: "MOCO SERVICES", createdAt: new Date() },
        { provider: "Airtel Money", number: "0683156736", name: "MOCO SERVICES", createdAt: new Date() },
      ];
      await db.collection("lipa_namba").insertMany(defaults);
      items = await db.collection("lipa_namba").find({}).sort({ createdAt: 1 }).toArray();
    }
    res.json(items.map(i => ({ id: i._id.toString(), provider: i.provider, number: i.number, name: i.name })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/lipa-namba", async (req, res) => {
  try {
    const db = await connectDB();
    const { provider, number, name } = req.body;
    if (!provider || !number) return res.status(400).json({ error: "Provider and number are required" });
    const doc = { provider: provider.trim(), number: number.trim(), name: (name || "MOCO SERVICES").trim(), createdAt: new Date() };
    const result = await db.collection("lipa_namba").insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), ...doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/lipa-namba/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { provider, number, name } = req.body;
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    await db.collection("lipa_namba").updateOne(
      { _id: new ObjectId(id) },
      { $set: { provider: provider.trim(), number: number.trim(), name: (name || "MOCO SERVICES").trim() } }
    );
    res.json({ success: true, id, provider, number, name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/lipa-namba/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    await db.collection("lipa_namba").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET a blog post by id (unauthenticated, fetch from GCS)
router.get("/blogposts/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog post id" });
    }
    const post = await db
      .collection("blogposts")
      .findOne({ _id: new ObjectId(id) });
    if (!post) {
      return res.status(404).json({ error: "Blog post not found" });
    }
    const gcsPath = post.gcsPath || (post.url && post.url.startsWith("http") ? gcsStorage.extractGcsPath(post.url) : `blogposts/${path.basename(post.url)}`);
    if (!gcsPath) return res.status(404).json({ error: "Blog post file not found" });

    const buffer = await gcsStorage.downloadFile(gcsPath);
    res.set("Content-Type", "text/html");
    res.send(buffer.toString("utf8"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route to increment views by id
router.get("/articles/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("blogposts").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $inc: { views: 1 } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// DELETE a blog post by id (unauthenticated, remove GCS file and db record)
router.delete("/blogposts/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog post id" });
    }
    const post = await db
      .collection("blogposts")
      .findOne({ _id: new ObjectId(id) });
    if (!post) {
      return res.status(404).json({ error: "Blog post not found" });
    }
    const gcsPath = post.gcsPath || (post.url && post.url.startsWith("http") ? gcsStorage.extractGcsPath(post.url) : `blogposts/${path.basename(post.url)}`);
    if (gcsPath) await gcsStorage.deleteFile(gcsPath);

    await db.collection("blogposts").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Blog Categories ────────────────────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  { name: "Hardware Repair", color: "#ef4444" },
  { name: "Software Fixes",  color: "#6366f1" },
  { name: "Tech Tips",       color: "#10b981" },
  { name: "Mocos News",      color: "#f59e0b" },
];

// GET all blog categories
router.get("/blog-categories", async (req, res) => {
  try {
    const db = await connectDB();
    let cats = await db.collection("blog_categories").find().sort({ createdAt: 1 }).toArray();
    // Seed defaults if collection is empty
    if (cats.length === 0) {
      await db.collection("blog_categories").insertMany(
        DEFAULT_CATEGORIES.map((c) => ({ ...c, createdAt: new Date() }))
      );
      cats = await db.collection("blog_categories").find().sort({ createdAt: 1 }).toArray();
    }
    res.json(cats.map((c) => ({ id: c._id.toString(), name: c.name, color: c.color || "#6b7280" })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create a new blog category (protected)
router.post("/blog-categories", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { name, color } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }
    const exists = await db.collection("blog_categories").findOne({ name: name.trim() });
    if (exists) return res.status(409).json({ error: "Category already exists" });
    const doc = { name: name.trim(), color: color || "#6b7280", createdAt: new Date() };
    const result = await db.collection("blog_categories").insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), name: doc.name, color: doc.color });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE a blog category (protected)
router.delete("/blog-categories/:id", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { ObjectId } = require("mongodb");
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid category id" });
    const result = await db.collection("blog_categories").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

router.post("/comments", async (req, res) => {
  const db = await connectDB();
  const { fullName, comment, postId } = req.body;
  if (!fullName || !comment || !postId) {
    return res.status(400).json({ error: "All fields are required" });
  }
  try {
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }
    const post = await db
      .collection("blogposts")
      .findOne({ _id: new ObjectId(postId) });
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }
    const doc = {
      fullName,
      comment,
      postId: new ObjectId(postId),
      createdAt: new Date(),
    };
    const result = await db.collection("comments").insertOne(doc);
    res
      .status(201)
      .json({ id: result.insertedId.toString(), fullName, comment, postId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/comments/:postId", async (req, res) => {
  const db = await connectDB();
  const { postId } = req.params;
  try {
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }
    const comments = await db
      .collection("comments")
      .find({ postId: new ObjectId(postId) })
      .toArray();
    res.json(
      comments.map(({ _id, fullName, comment, createdAt }) => ({
        id: _id.toString(),
        fullName,
        comment,
        createdAt: createdAt.toISOString(),
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/service-cards", async (req, res) => {
  try {
    const db = await connectDB();
    const card = req.body;
    if (!card || typeof card !== "object") {
      return res.status(400).json({ error: "Service card data required" });
    }
    const result = await db.collection("service_cards").insertOne(card);
    res.status(201).json({ id: result.insertedId.toString(), ...card });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/service-cards", async (req, res) => {
  try {
    const db = await connectDB();
    const cards = await db.collection("service_cards").find().toArray();
    res.json(cards.map((card) => ({ id: card._id.toString(), ...card })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/service-cards/:id", async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid service card ID" });
    }
    const db = await connectDB();
    const result = await db.collection("service_cards").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Service card not found" });
    }
    res.json({ message: "Service card deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change password (authenticated)
router.post("/change-password", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Old and new passwords are required" });
    }
    const user = await db
      .collection("users")
      .findOne({ username: req.user.username });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const valid = await bcrypt.compare(oldPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: "Old password is incorrect" });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db
      .collection("users")
      .updateOne(
        { username: req.user.username },
        { $set: { password: hashedPassword } }
      );
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
