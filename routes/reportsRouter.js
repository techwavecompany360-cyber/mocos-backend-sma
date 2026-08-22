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
    const serviceRequests = await db.collection("service_requests").find().toArray();

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

    serviceRequests.forEach((sr) => {
      const model = `${sr.deviceInfo?.brandName || sr.deviceInfo?.make || ""} ${sr.deviceInfo?.model || ""}`.trim();
      deviceReports.push({
        id: sr._id.toString(),
        deviceModel: model || sr.deviceInfo?.deviceType || "Unknown Device",
        customerName: sr.customerInfo?.fullName || "Unknown Customer",
        customerPhone: sr.customerInfo?.phoneNumber || "",
        issue: sr.deviceInfo?.problemDescription || sr.diagnosis?.faultDescription || "Service Request",
        source: sr.escalation?.isEscalated ? "Escalated Network Job" : "Service Request",
        status: sr.status || "Pending",
        dateReceived: sr.createdAt || new Date(),
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
    const serviceRequests = await db.collection("service_requests").find().toArray();

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
        serviceRequestsCount: 0,
        lastVisit: date,
        status: "Active"
      };

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
      if (type === "service-request") existing.serviceRequestsCount = (existing.serviceRequestsCount || 0) + 1;

      if (date && (!existing.lastVisit || new Date(date) > new Date(existing.lastVisit))) {
        existing.lastVisit = date;
      }

      customersMap.set(key, existing);
    }

    bookings.forEach((b) => processCustomer(b.name, b.phone, b.email, null, null, "booking", b.submittedAt || b.date));
    repairs.forEach((r) => processCustomer(r.remoteName, r.remotePhone, null, r.remoteRegion, r.remoteDistrict, "repair", r.submittedAt));
    sells.forEach((s) => processCustomer(s.name, s.phone, null, s.region, s.district, "sell", s.submittedAt));
    serviceCards.forEach((c) => processCustomer(c.customerInfo?.fullName, c.customerInfo?.phoneNumber, c.customerInfo?.email, null, null, "service-card", c.createdAt));
    serviceRequests.forEach((sr) => processCustomer(sr.customerInfo?.fullName, sr.customerInfo?.phoneNumber, sr.customerInfo?.email, sr.customerInfo?.region, sr.customerInfo?.district, "service-request", sr.createdAt));

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

    const serviceRequests = await db.collection("service_requests").find().toArray();
    serviceRequests.forEach((sr) => {
      const srDate = sr.createdAt
        ? new Date(sr.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      const cards = sr.serviceCards || [];
      cards.forEach((service, index) => {
        if (service.spareCostExpense && Number(service.spareCostExpense) > 0) {
          mappedSpares.push({
            id: `${sr._id.toString()}-sr-spare-${index}`,
            partName: `${service.fault || service.category || "Spare Part"} (Spare Expense)`,
            deviceModel: `${sr.deviceInfo?.brandName || ""} ${sr.deviceInfo?.model || ""}`.trim() || "Unknown",
            supplier: sr.partnerName || sr.branchName || "Service Request",
            quantity: 1,
            unitCost: Number(service.spareCostExpense),
            status: "Used",
            date: srDate,
            linkedRequestInfo: `Service Request: ${sr.trackingId} (${sr.customerInfo?.fullName || "Customer"})`,
          });
        }
      });

      if (sr.repairExpense && Number(sr.repairExpense) > 0 && cards.length === 0) {
        mappedSpares.push({
          id: `${sr._id.toString()}-sr-repair-exp`,
          partName: `Repair Expense (${sr.trackingId})`,
          deviceModel: `${sr.deviceInfo?.brandName || ""} ${sr.deviceInfo?.model || ""}`.trim() || "Unknown",
          supplier: sr.partnerName || sr.branchName || "Service Request",
          quantity: 1,
          unitCost: Number(sr.repairExpense),
          status: "Used",
          date: srDate,
          linkedRequestInfo: `Service Request: ${sr.trackingId} (${sr.customerInfo?.fullName || "Customer"})`,
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
              adminFee: 0,
              paymentStatus: "Paid",
              date: cardDate,
              notes: "Auto-generated from Service Card",
              linkedRequestInfo: "Service Card",
            });
          }
        });
      }
    });

    const serviceRequests = await db.collection("service_requests").find().toArray();
    serviceRequests.forEach((sr) => {
      const srDate = sr.createdAt
        ? new Date(sr.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      const totalCost = Number(sr.totalCost || 0);
      const adminFee = Number(sr.escalation?.adminFee || 0);
      const partnerAFee = Number(sr.escalation?.partnerAFee || 0);
      const partnerBFee = Number(sr.escalation?.partnerBFee || 0);
      const partsCost = Number(sr.repairExpense || 0);
      const laborCost = Math.max(0, totalCost - partsCost);

      if (totalCost > 0 || adminFee > 0) {
        mappedRepairs.push({
          id: sr._id.toString(),
          customerName: sr.customerInfo?.fullName || "Customer",
          customerPhone: sr.customerInfo?.phoneNumber || "",
          deviceModel: `${sr.deviceInfo?.brandName || sr.deviceInfo?.make || ""} ${sr.deviceInfo?.model || ""}`.trim() || "Unknown Device",
          repairType: sr.deviceInfo?.problemDescription || (sr.escalation?.isEscalated ? "Escalated Network Job" : "Repair Service"),
          source: sr.escalation?.isEscalated ? "Escalated Job" : "Service Request",
          laborCost: laborCost,
          partsCost: partsCost,
          adminFee: adminFee,
          partnerAFee: partnerAFee,
          partnerBFee: partnerBFee,
          paymentStatus: sr.paymentStatus === "paid" ? "Paid" : "Unpaid",
          date: srDate,
          notes: sr.escalation?.isEscalated
            ? `Escalated Job — Total: TZS ${totalCost.toLocaleString()} (Partner A: ${partnerAFee.toLocaleString()}, Admin Fee: ${adminFee.toLocaleString()}, Partner B: ${partnerBFee.toLocaleString()})`
            : `Service Request ${sr.trackingId}`,
          linkedRequestInfo: sr.trackingId || "Service Request",
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
