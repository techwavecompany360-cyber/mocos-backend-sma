const express = require("express");
const { ObjectId } = require("mongodb");
const connectDB = require("../utils/db");

const router = express.Router();

// Helper to normalize phone numbers for grouping
function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[\s\-\+\(\)]/g, "").slice(-9); // compare last 9 digits
}

// ─── Device Reports ─────────────────────────────────────────
router.get("/device-reports", async (req, res) => {
  try {
    const db = await connectDB();
    const bookings = await db.collection("bookData").find().toArray();
    const repairs = await db.collection("repairData").find().toArray();
    const sells = await db.collection("sellData").find().toArray();
    const serviceCards = await db.collection("service_cards").find().toArray();

    const deviceReports = [];

    bookings.forEach((b) => {
      deviceReports.push({
        id: b._id.toString(),
        deviceModel: b.device || "Unknown Device",
        customerName: b.name || "Unknown Customer",
        customerPhone: b.phone || "",
        issue: b.problem || "No description",
        source: "Website Booking",
        status: b.new || "New",
        dateReceived: b.submittedAt || b.date || new Date(),
      });
    });

    repairs.forEach((r) => {
      deviceReports.push({
        id: r._id.toString(),
        deviceModel: r.remoteDevice || "Unknown Device",
        customerName: r.remoteName || "Unknown Customer",
        customerPhone: r.remotePhone || "",
        issue: r.remoteProblem || "No description",
        source: "Remote Repair Request",
        status: r.new || "New",
        dateReceived: r.submittedAt || new Date(),
      });
    });

    sells.forEach((s) => {
      deviceReports.push({
        id: s._id.toString(),
        deviceModel: "Device Sell Request",
        customerName: s.name || "Unknown Customer",
        customerPhone: s.phone || "",
        issue: s.condition || "No description",
        source: "Website Sell Request",
        status: s.status || "Pending Offer",
        dateReceived: s.submittedAt || new Date(),
      });
    });

    serviceCards.forEach((c) => {
      const model = `${c.deviceInfo?.make || ""} ${c.deviceInfo?.model || ""}`.trim();
      deviceReports.push({
        id: c._id.toString(),
        deviceModel: model || "Unknown Device",
        customerName: c.customerInfo?.fullName || "Unknown Customer",
        customerPhone: c.customerInfo?.phoneNumber || "",
        issue: Array.isArray(c.services) ? c.services.map(s => s.problem).filter(Boolean).join(", ") || "In-store Repair" : "In-store Repair",
        source: "Service Card",
        status: c.status || "Pending",
        dateReceived: c.createdAt || new Date(),
      });
    });

    // Sort by date received descending
    deviceReports.sort((a, b) => new Date(b.dateReceived) - new Date(a.dateReceived));

    res.json(deviceReports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Customer Reports ───────────────────────────────────────
router.get("/customer-reports", async (req, res) => {
  try {
    const db = await connectDB();
    const bookings = await db.collection("bookData").find().toArray();
    const repairs = await db.collection("repairData").find().toArray();
    const sells = await db.collection("sellData").find().toArray();
    const serviceCards = await db.collection("service_cards").find().toArray();

    const customersMap = new Map();

    function processCustomer(name, phone, email, region, district, type, date) {
      if (!name && !phone) return;
      const key = phone ? normalizePhone(phone) : name.toLowerCase().trim();
      
      const existing = customersMap.get(key) || {
        fullName: name || "Unknown",
        phone: phone || "",
        email: email || "",
        address: [region, district].filter(Boolean).join(", ") || "",
        bookingsCount: 0,
        repairsCount: 0,
        sellsCount: 0,
        serviceCardsCount: 0,
        lastVisit: date,
        status: "Active"
      };

      // Keep the most detailed fields
      if (name && (!existing.fullName || existing.fullName === "Unknown")) existing.fullName = name;
      if (phone && !existing.phone) existing.phone = phone;
      if (email && !existing.email) existing.email = email;
      
      const newAddress = [region, district].filter(Boolean).join(", ");
      if (newAddress && (!existing.address || existing.address.length < newAddress.length)) {
        existing.address = newAddress;
      }

      if (type === "booking") existing.bookingsCount++;
      if (type === "repair") existing.repairsCount++;
      if (type === "sell") existing.sellsCount++;
      if (type === "service-card") existing.serviceCardsCount++;

      if (date && (!existing.lastVisit || new Date(date) > new Date(existing.lastVisit))) {
        existing.lastVisit = date;
      }

      customersMap.set(key, existing);
    }

    bookings.forEach((b) => processCustomer(b.name, b.phone, b.email, null, null, "booking", b.submittedAt || b.date));
    repairs.forEach((r) => processCustomer(r.remoteName, r.remotePhone, null, r.remoteRegion, r.remoteDistrict, "repair", r.submittedAt));
    sells.forEach((s) => processCustomer(s.name, s.phone, null, s.region, s.district, "sell", s.submittedAt));
    serviceCards.forEach((c) => processCustomer(c.customerInfo?.fullName, c.customerInfo?.phoneNumber, c.customerInfo?.email, null, null, "service-card", c.createdAt));

    const customersList = Array.from(customersMap.values());
    customersList.sort((a, b) => new Date(b.lastVisit || 0) - new Date(a.lastVisit || 0));

    res.json(customersList);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Spare Cost Reports ─────────────────────────────────────
router.get("/spare-cost-reports", async (req, res) => {
  try {
    const db = await connectDB();
    const spares = await db.collection("spare_cost_reports").find().toArray();
    const mappedSpares = spares.map((s) => ({ id: s._id.toString(), ...s, _id: undefined }));

    // Fetch service cards and extract spare costs
    const serviceCards = await db.collection("service_cards").find().toArray();
    serviceCards.forEach((card) => {
      const cardDate = card.createdAt
        ? new Date(card.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (Array.isArray(card.services)) {
        card.services.forEach((service, index) => {
          if (service.spareCostExpense && Number(service.spareCostExpense) > 0) {
            mappedSpares.push({
              id: `${card._id.toString()}-spare-${index}`,
              partName: `${service.problem || "Spare Part"} (Spare Expense)`,
              deviceModel: `${card.deviceInfo?.make || ""} ${card.deviceInfo?.model || ""}`.trim() || "Unknown",
              supplier: "Service Card",
              quantity: 1,
              unitCost: Number(service.spareCostExpense),
              status: "Used",
              date: cardDate,
              linkedRequestInfo: `Service Card: ${card.customerInfo?.fullName || "Customer"}`,
            });
          }
          if (service.serviceCostExpense && Number(service.serviceCostExpense) > 0) {
            mappedSpares.push({
              id: `${card._id.toString()}-service-exp-${index}`,
              partName: `${service.problem || "Service"} (Service Expense)`,
              deviceModel: `${card.deviceInfo?.make || ""} ${card.deviceInfo?.model || ""}`.trim() || "Unknown",
              supplier: "Service Card",
              quantity: 1,
              unitCost: Number(service.serviceCostExpense),
              status: "Used",
              date: cardDate,
              linkedRequestInfo: `Service Card: ${card.customerInfo?.fullName || "Customer"}`,
            });
          }
        });
      }
    });

    // Sort by date descending
    mappedSpares.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(mappedSpares);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/spare-cost-reports", async (req, res) => {
  try {
    const db = await connectDB();
    const doc = { ...req.body, createdAt: new Date() };
    const result = await db.collection("spare_cost_reports").insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), ...doc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/spare-cost-reports/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const id = req.params.id;

    // Handle dynamic service card spares deletion
    if (id.includes("-spare-") || id.includes("-service-exp-")) {
      const parts = id.split("-");
      const cardId = parts[0];
      const serviceIndex = parseInt(parts[parts.length - 1], 10);
      if (ObjectId.isValid(cardId)) {
        const card = await db.collection("service_cards").findOne({ _id: new ObjectId(cardId) });
        if (card && Array.isArray(card.services)) {
          card.services.splice(serviceIndex, 1);
          await db.collection("service_cards").updateOne(
            { _id: new ObjectId(cardId) },
            {
              $set: {
                services: card.services,
                totalPrice: card.services.reduce((sum, s) => sum + Number(s.spareCost || 0) + Number(s.serviceCost || 0), 0)
              }
            }
          );
          return res.json({ success: true });
        }
      }
    }

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    await db.collection("spare_cost_reports").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Repair Cost Reports ────────────────────────────────────
router.get("/repair-cost-reports", async (req, res) => {
  try {
    const db = await connectDB();
    const repairs = await db.collection("repair_cost_reports").find().toArray();
    const mappedRepairs = repairs.map((r) => ({ id: r._id.toString(), ...r, _id: undefined }));

    // Fetch service cards and extract service costs
    const serviceCards = await db.collection("service_cards").find().toArray();
    serviceCards.forEach((card) => {
      const cardDate = card.createdAt
        ? new Date(card.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (Array.isArray(card.services)) {
        card.services.forEach((service, index) => {
          if (service.serviceCost && Number(service.serviceCost) > 0) {
            mappedRepairs.push({
              id: `${card._id.toString()}-repair-${index}`,
              customerName: card.customerInfo?.fullName || "Customer",
              customerPhone: card.customerInfo?.phoneNumber || "",
              deviceModel: `${card.deviceInfo?.make || ""} ${card.deviceInfo?.model || ""}`.trim() || "Unknown",
              repairType: service.problem || "Repair Service",
              source: "Service Card",
              laborCost: Number(service.serviceCost),
              partsCost: Number(service.spareCost || 0),
              paymentStatus: "Paid",
              date: cardDate,
              notes: "Auto-generated from Service Card",
              linkedRequestInfo: "Service Card",
            });
          }
        });
      }
    });

    // Sort by date descending
    mappedRepairs.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(mappedRepairs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/repair-cost-reports", async (req, res) => {
  try {
    const db = await connectDB();
    const doc = { ...req.body, createdAt: new Date() };
    const result = await db.collection("repair_cost_reports").insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), ...doc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/repair-cost-reports/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const id = req.params.id;

    // Handle dynamic service card repairs deletion
    if (id.includes("-repair-")) {
      const parts = id.split("-");
      const cardId = parts[0];
      const serviceIndex = parseInt(parts[2], 10);
      if (ObjectId.isValid(cardId)) {
        const card = await db.collection("service_cards").findOne({ _id: new ObjectId(cardId) });
        if (card && Array.isArray(card.services)) {
          card.services.splice(serviceIndex, 1);
          await db.collection("service_cards").updateOne(
            { _id: new ObjectId(cardId) },
            {
              $set: {
                services: card.services,
                totalPrice: card.services.reduce((sum, s) => sum + Number(s.spareCost || 0) + Number(s.serviceCost || 0), 0)
              }
            }
          );
          return res.json({ success: true });
        }
      }
    }

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    await db.collection("repair_cost_reports").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
