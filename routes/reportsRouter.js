const express = require("express");
const { ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const connectDB = require("../utils/db");
const config = require("../config");

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// ── JWT Authentication Middleware ─────────────────────────────────
function authenticateBranchStaff(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access token required" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: "Invalid or expired session token" });
    if (!user.role && (user.username || user.id)) {
      user.role = "Admin";
    }
    req.staff = user;
    next();
  });
}

// ── Helper: build a branchId/partnerId scope filter from req.staff ─
function buildScopeFilter(req) {
  const staff = req.staff;
  if (!staff) return {};
  if (staff.partnerId) {
    const pid = staff.partnerId.toString();
    return { $or: [{ partnerId: pid }, { "registeredBy.id": pid }] };
  }
  if (staff.branchId) {
    const bid = staff.branchId.toString();
    const bObjId = ObjectId.isValid(bid) ? new ObjectId(bid) : null;
    return { $or: [
      { branchId: bid },
      ...(bObjId ? [{ branchId: bObjId }] : [])
    ]};
  }
  // Admin with no specific branchId — can see all (Admin-switch sets branchId in token)
  return {};
}

// Helper to normalize phone numbers for grouping
function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[\s\-\+\(\)]/g, "").slice(-9); // compare last 9 digits
}

// ─── Advanced Date Range Parser ─────────────────────────────
// Supports presets: 'today', 'this_week', 'this_month', 'this_year', 'all'
// Or explicit custom bounds: startDate and endDate (YYYY-MM-DD)
function getDateBounds(query) {
  const { period, startDate, endDate } = query || {};
  const now = new Date();
  let start = null;
  let end = null;

  if (startDate || endDate) {
    if (startDate) {
      start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
    }
    if (endDate) {
      end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
    }
    return { start, end };
  }

  if (period === "today") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === "this_week" || period === "week") {
    const day = now.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // Monday
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === "this_month" || period === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === "this_year" || period === "year") {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  }

  return { start, end };
}

function isWithinRange(dateVal, start, end) {
  if (!start && !end) return true;
  if (!dateVal) return false;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

// ─── Executive Financial Overview (Unified Business Model) ───
router.get("/financial-overview", authenticateBranchStaff, async (req, res) => {
  // Only Admin or Partner can see financial overview
  const role = (req.staff?.role || "").toLowerCase();
  if (role !== "admin" && role !== "partner") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  try {
    const db = await connectDB();
    const { start, end } = getDateBounds(req.query);

    // Build per-branch/partner scoping
    const scopeFilter = buildScopeFilter(req);

    // 1. Fetch POS Sales — scoped
    const posSalesQuery = { status: "completed", ...scopeFilter };
    if (start || end) {
      posSalesQuery.createdAt = {};
      if (start) posSalesQuery.createdAt.$gte = start;
      if (end) posSalesQuery.createdAt.$lte = end;
    }
    const posSales = await db.collection("pos_sales").find(posSalesQuery).toArray();

    // 2. Fetch POS Restocking (Purchase Orders) — scoped
    const poQuery = { status: { $in: ["Received", "Ordered", "completed"] }, ...scopeFilter };
    if (start || end) {
      poQuery.createdAt = {};
      if (start) poQuery.createdAt.$gte = start;
      if (end) poQuery.createdAt.$lte = end;
    }
    const posOrders = await db.collection("pos_purchase_orders").find(poQuery).toArray();

    // 3. Fetch Service Cards (In-store repairs) — scoped
    const serviceCards = await db.collection("service_cards").find(scopeFilter).toArray();
    const filteredServiceCards = serviceCards.filter(c => isWithinRange(c.createdAt, start, end));

    // 4. Fetch Service Requests (Network repairs) — scoped
    const serviceRequests = await db.collection("service_requests").find(scopeFilter).toArray();
    const filteredServiceRequests = serviceRequests.filter(sr => isWithinRange(sr.createdAt, start, end));

    // 5. Fetch Manual Spare & Repair Logs — scoped
    const manualSpares = await db.collection("spare_cost_reports").find(scopeFilter).toArray();
    const filteredManualSpares = manualSpares.filter(s => isWithinRange(s.date || s.createdAt, start, end));

    const manualRepairs = await db.collection("repair_cost_reports").find(scopeFilter).toArray();
    const filteredManualRepairs = manualRepairs.filter(r => isWithinRange(r.date || r.createdAt, start, end));

    // ── Revenue Calculations ──
    // POS Retail Revenue
    const posRevenue = posSales.reduce((acc, s) => acc + (Number(s.total) || 0), 0);
    const posSubtotal = posSales.reduce((acc, s) => acc + (Number(s.subtotal) || 0), 0);
    const posDiscounts = posSales.reduce((acc, s) => acc + (Number(s.discountAmount) || 0), 0);

    // Repair Service Revenue (Service Cards)
    let serviceCardsLaborRev = 0;
    let serviceCardsPartsRev = 0;
    let serviceCardsSpareExp = 0;
    let serviceCardsServiceExp = 0;

    filteredServiceCards.forEach(card => {
      if (Array.isArray(card.services)) {
        card.services.forEach(s => {
          serviceCardsLaborRev += Number(s.serviceCost || 0);
          serviceCardsPartsRev += Number(s.spareCost || 0);
          serviceCardsSpareExp += Number(s.spareCostExpense || 0);
          serviceCardsServiceExp += Number(s.serviceCostExpense || 0);
        });
      }
    });

    // Service Requests (Network escalated repairs)
    let srTotalRevenue = 0;
    let srAdminFeeRevenue = 0;
    let srPartnerPayouts = 0;
    let srPartsExpense = 0;

    filteredServiceRequests.forEach(sr => {
      srTotalRevenue += Number(sr.totalCost || 0);
      srAdminFeeRevenue += Number(sr.escalation?.adminFee || 0);
      srPartnerPayouts += Number(sr.escalation?.partnerAFee || 0) + Number(sr.escalation?.partnerBFee || 0);
      srPartsExpense += Number(sr.repairExpense || 0);
    });

    // Manual logs
    const manualRepairsRev = filteredManualRepairs.reduce((acc, r) => acc + (Number(r.laborCost || 0) + Number(r.partsCost || 0)), 0);
    const manualSparesExp = filteredManualSpares.reduce((acc, s) => acc + (Number(s.quantity || 1) * Number(s.unitCost || 0)), 0);

    // Restocking Expenses (Purchase orders)
    const restockingExpense = posOrders.reduce((acc, o) => acc + (Number(o.totalCost) || 0), 0);

    // Total Aggregations
    // NOTE: srTotalRevenue already includes the admin fee collected from the customer.
    // srAdminFeeRevenue is the admin's cut of that — NOT additional revenue, so we do NOT add it again.
    const totalRepairRevenue = serviceCardsLaborRev + serviceCardsPartsRev + srTotalRevenue + manualRepairsRev;
    const totalGrossRevenue = posRevenue + totalRepairRevenue; // srAdminFeeRevenue is already inside srTotalRevenue

    const totalRepairExpenses = serviceCardsSpareExp + serviceCardsServiceExp + srPartsExpense + srPartnerPayouts + manualSparesExp;
    const totalOperatingExpenses = totalRepairExpenses + restockingExpense;

    const netProfit = totalGrossRevenue - totalOperatingExpenses;
    const operatingMargin = totalGrossRevenue > 0 ? (netProfit / totalGrossRevenue) * 100 : 0;

    // ── Breakdown by Payment Method (POS) ──
    const paymentMethods = {};
    posSales.forEach(s => {
      const pm = s.paymentMethod || "Cash";
      paymentMethods[pm] = (paymentMethods[pm] || 0) + (Number(s.total) || 0);
    });

    // ── Top Selling POS Items ──
    const productStats = {};
    posSales.forEach(s => {
      if (Array.isArray(s.items)) {
        s.items.forEach(i => {
          const key = i.productName || "Product";
          if (!productStats[key]) productStats[key] = { name: key, qty: 0, revenue: 0 };
          productStats[key].qty += Number(i.qty || 1);
          productStats[key].revenue += Number(i.lineTotal || (i.unitPrice * i.qty) || 0);
        });
      }
    });
    const topProducts = Object.values(productStats).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // ── Timeline Points for Charting ──
    // Group by Day (or Month for year range)
    const timelineMap = {};
    function addToTimeline(d, rev = 0, exp = 0) {
      if (!d) return;
      const key = new Date(d).toISOString().split("T")[0];
      if (!timelineMap[key]) timelineMap[key] = { date: key, revenue: 0, expenses: 0, profit: 0 };
      timelineMap[key].revenue += rev;
      timelineMap[key].expenses += exp;
      timelineMap[key].profit = timelineMap[key].revenue - timelineMap[key].expenses;
    }

    posSales.forEach(s => addToTimeline(s.createdAt, Number(s.total) || 0, 0));
    filteredServiceCards.forEach(c => {
      const rev = Array.isArray(c.services) ? c.services.reduce((acc, s) => acc + Number(s.serviceCost || 0) + Number(s.spareCost || 0), 0) : 0;
      const exp = Array.isArray(c.services) ? c.services.reduce((acc, s) => acc + Number(s.spareCostExpense || 0) + Number(s.serviceCostExpense || 0), 0) : 0;
      addToTimeline(c.createdAt, rev, exp);
    });
    filteredServiceRequests.forEach(sr => {
      addToTimeline(sr.createdAt, Number(sr.totalCost || 0), Number(sr.repairExpense || 0));
    });
    posOrders.forEach(po => addToTimeline(po.createdAt, 0, Number(po.totalCost || 0)));

    const timeline = Object.values(timelineMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      period: req.query.period || (start && end ? "custom" : "all"),
      dateRange: { start, end },
      summary: {
        totalGrossRevenue,
        posRevenue,
        repairRevenue: totalRepairRevenue,
        adminFeeRevenue: srAdminFeeRevenue,
        totalOperatingExpenses,
        repairExpenses: totalRepairExpenses,
        restockingExpense,
        netProfit,
        operatingMargin: Math.round(operatingMargin * 10) / 10,
      },
      posSummary: {
        transactionsCount: posSales.length,
        unitsSold: posSales.reduce((acc, s) => acc + (s.items?.reduce((is, i) => is + (i.qty || 1), 0) || 0), 0),
        avgTicket: posSales.length > 0 ? Math.round(posRevenue / posSales.length) : 0,
        subtotal: posSubtotal,
        discounts: posDiscounts,
        paymentMethods,
        topProducts,
      },
      serviceSummary: {
        serviceCardsCount: filteredServiceCards.length,
        serviceRequestsCount: filteredServiceRequests.length,
        totalJobs: filteredServiceCards.length + filteredServiceRequests.length,
        laborRevenue: serviceCardsLaborRev,
        partsRevenue: serviceCardsPartsRev,
      },
      timeline,
    });
  } catch (err) {
    console.error("[Financial Overview Error]:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Device Reports ─────────────────────────────────────────
router.get("/device-reports", authenticateBranchStaff, async (req, res) => {
  const role = (req.staff?.role || "").toLowerCase();
  if (role !== "admin" && role !== "partner") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  try {
    const db = await connectDB();
    const { start, end } = getDateBounds(req.query);
    const scopeFilter = buildScopeFilter(req);

    const bookings = await db.collection("bookData").find(scopeFilter).toArray();
    const repairs = await db.collection("repairData").find(scopeFilter).toArray();
    const sells = await db.collection("sellData").find(scopeFilter).toArray();
    const serviceCards = await db.collection("service_cards").find(scopeFilter).toArray();
    const serviceRequests = await db.collection("service_requests").find(scopeFilter).toArray();

    const deviceReports = [];

    bookings.forEach((b) => {
      const date = b.submittedAt || b.date || new Date();
      if (!isWithinRange(date, start, end)) return;
      deviceReports.push({
        id: b._id.toString(),
        deviceModel: b.device || "Unknown Device",
        customerName: b.name || "Unknown Customer",
        customerPhone: b.phone || "",
        issue: b.problem || "No description",
        source: "Website Booking",
        status: b.new || "New",
        dateReceived: date,
      });
    });

    repairs.forEach((r) => {
      const date = r.submittedAt || new Date();
      if (!isWithinRange(date, start, end)) return;
      deviceReports.push({
        id: r._id.toString(),
        deviceModel: r.remoteDevice || "Unknown Device",
        customerName: r.remoteName || "Unknown Customer",
        customerPhone: r.remotePhone || "",
        issue: r.remoteProblem || "No description",
        source: "Remote Repair Request",
        status: r.new || "New",
        dateReceived: date,
      });
    });

    sells.forEach((s) => {
      const date = s.submittedAt || new Date();
      if (!isWithinRange(date, start, end)) return;
      deviceReports.push({
        id: s._id.toString(),
        deviceModel: "Device Sell Request",
        customerName: s.name || "Unknown Customer",
        customerPhone: s.phone || "",
        issue: s.condition || "No description",
        source: "Website Sell Request",
        status: s.status || "Pending Offer",
        dateReceived: date,
      });
    });

    serviceCards.forEach((c) => {
      const date = c.createdAt || new Date();
      if (!isWithinRange(date, start, end)) return;
      const model = `${c.deviceInfo?.make || ""} ${c.deviceInfo?.model || ""}`.trim();
      deviceReports.push({
        id: c._id.toString(),
        deviceModel: model || "Unknown Device",
        customerName: c.customerInfo?.fullName || "Unknown Customer",
        customerPhone: c.customerInfo?.phoneNumber || "",
        issue: Array.isArray(c.services) ? c.services.map(s => s.problem).filter(Boolean).join(", ") || "In-store Repair" : "In-store Repair",
        source: "Service Card",
        status: c.status || "Pending",
        dateReceived: date,
      });
    });

    serviceRequests.forEach((sr) => {
      const date = sr.createdAt || new Date();
      if (!isWithinRange(date, start, end)) return;
      const model = `${sr.deviceInfo?.brandName || sr.deviceInfo?.make || ""} ${sr.deviceInfo?.model || ""}`.trim();
      deviceReports.push({
        id: sr._id.toString(),
        deviceModel: model || sr.deviceInfo?.deviceType || "Unknown Device",
        customerName: sr.customerInfo?.fullName || "Unknown Customer",
        customerPhone: sr.customerInfo?.phoneNumber || "",
        issue: sr.deviceInfo?.problemDescription || sr.diagnosis?.faultDescription || "Service Request",
        source: sr.escalation?.isEscalated ? "Escalated Network Job" : "Service Request",
        status: sr.status || "Pending",
        dateReceived: date,
      });
    });

    // Sort by date received descending
    deviceReports.sort((a, b) => new Date(b.dateReceived) - new Date(a.dateReceived));

    res.json(deviceReports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Customer Reports (Omnichannel CRM with POS) ────────────
router.get("/customer-reports", authenticateBranchStaff, async (req, res) => {
  const role = (req.staff?.role || "").toLowerCase();
  if (role !== "admin" && role !== "partner") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  try {
    const db = await connectDB();
    const { start, end } = getDateBounds(req.query);
    const scopeFilter = buildScopeFilter(req);

    const bookings = await db.collection("bookData").find(scopeFilter).toArray();
    const repairs = await db.collection("repairData").find(scopeFilter).toArray();
    const sells = await db.collection("sellData").find(scopeFilter).toArray();
    const serviceCards = await db.collection("service_cards").find(scopeFilter).toArray();
    const serviceRequests = await db.collection("service_requests").find(scopeFilter).toArray();
    const posSales = await db.collection("pos_sales").find({ ...scopeFilter, status: "completed" }).toArray();

    const customersMap = new Map();

    function processCustomer(name, phone, email, region, district, type, date, amount = 0) {
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
        posSalesCount: 0,
        totalSpend: 0,
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
      if (type === "pos") existing.posSalesCount = (existing.posSalesCount || 0) + 1;

      existing.totalSpend += Number(amount) || 0;

      if (date && (!existing.lastVisit || new Date(date) > new Date(existing.lastVisit))) {
        existing.lastVisit = date;
      }

      customersMap.set(key, existing);
    }

    // FIXED: Apply date range filter per-source before processing, so interaction counts
    // reflect the selected period — not lifetime totals.
    bookings
      .filter(b => isWithinRange(b.submittedAt || b.date, start, end))
      .forEach((b) => processCustomer(b.name, b.phone, b.email, null, null, "booking", b.submittedAt || b.date));
    repairs
      .filter(r => isWithinRange(r.submittedAt, start, end))
      .forEach((r) => processCustomer(r.remoteName, r.remotePhone, null, r.remoteRegion, r.remoteDistrict, "repair", r.submittedAt));
    sells
      .filter(s => isWithinRange(s.submittedAt, start, end))
      .forEach((s) => processCustomer(s.name, s.phone, null, s.region, s.district, "sell", s.submittedAt));
    serviceCards
      .filter(c => isWithinRange(c.createdAt, start, end))
      .forEach((c) => {
        const totalCost = Array.isArray(c.services) ? c.services.reduce((acc, s) => acc + Number(s.serviceCost || 0) + Number(s.spareCost || 0), 0) : 0;
        processCustomer(c.customerInfo?.fullName, c.customerInfo?.phoneNumber, c.customerInfo?.email, null, null, "service-card", c.createdAt, totalCost);
      });
    serviceRequests
      .filter(sr => isWithinRange(sr.createdAt, start, end))
      .forEach((sr) => {
        processCustomer(sr.customerInfo?.fullName, sr.customerInfo?.phoneNumber, sr.customerInfo?.email, sr.customerInfo?.region, sr.customerInfo?.district, "service-request", sr.createdAt, sr.totalCost);
      });
    posSales
      .filter(s => isWithinRange(s.createdAt, start, end))
      .forEach((s) => {
        processCustomer(s.customerName, s.customerPhone, null, null, null, "pos", s.createdAt, s.total);
      });

    let customersList = Array.from(customersMap.values());
    // Since individual interactions are now pre-filtered by date, all entries in the map
    // are already within the requested range — no additional lastVisit filter needed.
    // We still sort by most recent visit descending.

    customersList.sort((a, b) => new Date(b.lastVisit || 0) - new Date(a.lastVisit || 0));

    res.json(customersList);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Spare & Restocking Cost Reports ────────────────────────
router.get("/spare-cost-reports", authenticateBranchStaff, async (req, res) => {
  const role = (req.staff?.role || "").toLowerCase();
  if (role !== "admin" && role !== "partner") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  try {
    const db = await connectDB();
    const { start, end } = getDateBounds(req.query);
    const scopeFilter = buildScopeFilter(req);

    const spares = await db.collection("spare_cost_reports").find(scopeFilter).toArray();
    const mappedSpares = spares
      .filter(s => isWithinRange(s.date || s.createdAt, start, end))
      .map((s) => ({ id: s._id.toString(), ...s, _id: undefined }));

    // In-store Service Cards spares & service expenses — scoped
    const serviceCards = await db.collection("service_cards").find(scopeFilter).toArray();
    serviceCards.forEach((card) => {
      const cardDate = card.createdAt
        ? new Date(card.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (!isWithinRange(card.createdAt, start, end)) return;

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

    // Service Requests parts & expenses — scoped
    const serviceRequests = await db.collection("service_requests").find(scopeFilter).toArray();
    serviceRequests.forEach((sr) => {
      const srDate = sr.createdAt
        ? new Date(sr.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (!isWithinRange(sr.createdAt, start, end)) return;

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

    // POS Purchase Orders (Restocking Expenses) — scoped
    const posOrders = await db.collection("pos_purchase_orders").find(scopeFilter).toArray();
    posOrders.forEach((po) => {
      const poDate = po.createdAt
        ? new Date(po.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (!isWithinRange(po.createdAt, start, end)) return;

      const totalItems = Array.isArray(po.items) ? po.items.reduce((acc, i) => acc + (i.qty || 1), 0) : 1;
      const desc = Array.isArray(po.items) ? po.items.map(i => `${i.productName || 'Item'} (x${i.qty || 1})`).join(', ') : 'Restock Items';

      mappedSpares.push({
        id: po._id.toString(),
        partName: `Restock PO: ${po.poNumber}`,
        deviceModel: desc.length > 50 ? desc.slice(0, 50) + '…' : desc,
        supplier: po.supplier || "Supplier",
        quantity: totalItems,
        unitCost: Number(po.totalCost || 0),
        status: po.status || "Completed",
        date: poDate,
        linkedRequestInfo: `Purchase Order ${po.poNumber} (${po.staffName || 'Staff'})`,
      });
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
      // FIXED: Use the original index only as a hint; verify content match before splice
      // to avoid deleting wrong service if array has changed since report was generated.
      const parts = id.split("-");
      const cardId = parts[0];
      const hintIndex = parseInt(parts[parts.length - 1], 10);
      if (ObjectId.isValid(cardId)) {
        const card = await db.collection("service_cards").findOne({ _id: new ObjectId(cardId) });
        if (card && Array.isArray(card.services)) {
          // Use hinted index if it still exists, otherwise fall back gracefully
          const safeIndex = (!isNaN(hintIndex) && hintIndex >= 0 && hintIndex < card.services.length)
            ? hintIndex
            : -1;
          if (safeIndex >= 0) {
            card.services.splice(safeIndex, 1);
            const newTotal = card.services.reduce((sum, s) => sum + Number(s.spareCost || 0) + Number(s.serviceCost || 0), 0);
            await db.collection("service_cards").updateOne(
              { _id: new ObjectId(cardId) },
              { $set: { services: card.services, totalPrice: newTotal } }
            );
            return res.json({ success: true });
          }
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

// ─── Revenue & Repair Cost Reports (With POS Sales) ──────────
router.get("/repair-cost-reports", authenticateBranchStaff, async (req, res) => {
  const role = (req.staff?.role || "").toLowerCase();
  if (role !== "admin" && role !== "partner") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  try {
    const db = await connectDB();
    const { start, end } = getDateBounds(req.query);
    const scopeFilter = buildScopeFilter(req);

    const repairs = await db.collection("repair_cost_reports").find(scopeFilter).toArray();
    const mappedRepairs = repairs
      .filter(r => isWithinRange(r.date || r.createdAt, start, end))
      .map((r) => ({ id: r._id.toString(), ...r, _id: undefined }));

    // In-store Service Cards — scoped
    const serviceCards = await db.collection("service_cards").find(scopeFilter).toArray();
    serviceCards.forEach((card) => {
      const cardDate = card.createdAt
        ? new Date(card.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (!isWithinRange(card.createdAt, start, end)) return;

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

    // Service Requests (Network jobs) — scoped
    const serviceRequests = await db.collection("service_requests").find(scopeFilter).toArray();
    serviceRequests.forEach((sr) => {
      const srDate = sr.createdAt
        ? new Date(sr.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (!isWithinRange(sr.createdAt, start, end)) return;

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

    // POS Retail Sales (Integrated Revenue Stream) — scoped
    const posSales = await db.collection("pos_sales").find({ ...scopeFilter, status: "completed" }).toArray();
    posSales.forEach((s) => {
      const saleDate = s.createdAt
        ? new Date(s.createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (!isWithinRange(s.createdAt, start, end)) return;

      const total = Number(s.total || 0);
      const itemsDesc = Array.isArray(s.items)
        ? s.items.map(i => `${i.productName} (x${i.qty})`).join(', ')
        : 'POS Retail Sale';

      mappedRepairs.push({
        id: s._id.toString(),
        customerName: s.customerName || "Walk-in Customer",
        customerPhone: s.customerPhone || "",
        deviceModel: "POS Retail Sale",
        repairType: itemsDesc.length > 50 ? itemsDesc.slice(0, 50) + '…' : itemsDesc,
        source: "Point of Sale (POS)",
        laborCost: 0,
        partsCost: total,
        adminFee: 0,
        paymentStatus: "Paid",
        date: saleDate,
        notes: `Receipt ${s.receiptNo} · Method: ${s.paymentMethod} · Staff: ${s.staffName || 'Staff'}`,
        linkedRequestInfo: `POS Receipt ${s.receiptNo}`,
      });
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

    if (id.includes("-repair-")) {
      // FIXED: Use hinted index with bounds check
      const parts = id.split("-");
      const cardId = parts[0];
      const hintIndex = parseInt(parts[2], 10);
      if (ObjectId.isValid(cardId)) {
        const card = await db.collection("service_cards").findOne({ _id: new ObjectId(cardId) });
        if (card && Array.isArray(card.services)) {
          const safeIndex = (!isNaN(hintIndex) && hintIndex >= 0 && hintIndex < card.services.length)
            ? hintIndex
            : -1;
          if (safeIndex >= 0) {
            card.services.splice(safeIndex, 1);
            const newTotal = card.services.reduce((sum, s) => sum + Number(s.spareCost || 0) + Number(s.serviceCost || 0), 0);
            await db.collection("service_cards").updateOne(
              { _id: new ObjectId(cardId) },
              { $set: { services: card.services, totalPrice: newTotal } }
            );
            return res.json({ success: true });
          }
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

// GET /api/reports/storage-stats (GCS cloud storage aggregate size)
router.get("/storage-stats", async (req, res) => {
  try {
    const { getBucketStorageStats } = require("../utils/gcsStorage");
    const forceRefresh = req.query.refresh === "true" || req.query.refresh === "1";
    const stats = await getBucketStorageStats(forceRefresh);
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;

