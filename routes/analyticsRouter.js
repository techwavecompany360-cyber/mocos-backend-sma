const express = require("express");
const connectDB = require("../utils/db");

const router = express.Router();

// Real-world demo geolocations for loopback connections (development mode)
const demoCities = [
  { city: "Dar es Salaam", country: "Tanzania", countryCode: "TZ", region: "Dar es Salaam", lat: -6.7924, lon: 39.2083, isp: "Tanzania Telecommunications" },
  { city: "Nairobi", country: "Kenya", countryCode: "KE", region: "Nairobi", lat: -1.2921, lon: 36.8219, isp: "Safaricom" },
  { city: "Kampala", country: "Uganda", countryCode: "UG", region: "Central", lat: 0.3476, lon: 32.5825, isp: "MTN Uganda" },
  { city: "Arusha", country: "Tanzania", countryCode: "TZ", region: "Arusha", lat: -3.3731, lon: 36.6857, isp: "Airtel Tanzania" },
  { city: "Mwanza", country: "Tanzania", countryCode: "TZ", region: "Mwanza", lat: -2.5164, lon: 32.9000, isp: "Vodacom Tanzania" },
  { city: "Zanzibar City", country: "Tanzania", countryCode: "TZ", region: "Zanzibar", lat: -6.1659, lon: 39.2026, isp: "Zantel" },
  { city: "Kigali", country: "Rwanda", countryCode: "RW", region: "Kigali Province", lat: -1.9441, lon: 30.0619, isp: "MTN Rwanda" },
  { city: "Dodoma", country: "Tanzania", countryCode: "TZ", region: "Dodoma", lat: -6.1630, lon: 35.7516, isp: "Halotel" },
  { city: "London", country: "United Kingdom", countryCode: "GB", region: "England", lat: 51.5074, lon: -0.1278, isp: "British Telecom" },
  { city: "New York", country: "United States", countryCode: "US", region: "New York", lat: 40.7128, lon: -74.0060, isp: "Verizon Wireless" },
  { city: "Tokyo", country: "Japan", countryCode: "JP", region: "Tokyo", lat: 35.6762, lon: 139.6503, isp: "Softbank" }
];

// Demo referrers for local development enrichment
const demoReferrers = [
  "https://www.google.com/search?q=mocos+phone+repair",
  "https://www.instagram.com/mocos_tz",
  "https://www.facebook.com/mocos",
  "Direct",
  "Direct",
  "https://twitter.com/mocos_tz",
  "https://wa.me/255712345678",
  "Direct",
  "https://www.google.com/search?q=phone+repair+dar+es+salaam",
  "https://www.tiktok.com/@mocos_tz"
];

// Helper to determine browser from User-Agent
function parseBrowser(ua) {
  if (!ua) return "Other";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg")) return "Edge";
  if (ua.includes("Chrome") && !ua.includes("Chromium")) return "Chrome";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
  if (ua.includes("OPR") || ua.includes("Opera")) return "Opera";
  return "Other";
}

// Helper to determine OS/Device Type from User-Agent
function parseDeviceType(ua) {
  if (!ua) return "Desktop";
  if (ua.includes("iPad") || (ua.includes("Macintosh") && "ontouchend" in global)) return "Tablet";
  if (ua.includes("Mobi") || ua.includes("Android") || ua.includes("iPhone")) return "Mobile";
  return "Desktop";
}

function parseOS(ua) {
  if (!ua) return "Other";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "macOS";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  if (ua.includes("Linux")) return "Linux";
  return "Other";
}

// Helper to classify referrer source into a category
function classifyReferrerSource(referrer) {
  if (!referrer || referrer === "Direct" || referrer === "") return "Direct";
  const r = referrer.toLowerCase();
  if (r.includes("google.com") || r.includes("bing.com") || r.includes("yahoo.com") || r.includes("duckduckgo.com") || r.includes("baidu.com")) return "Search Engine";
  if (r.includes("facebook.com") || r.includes("fb.com") || r.includes("instagram.com") || r.includes("twitter.com") || r.includes("x.com") || r.includes("tiktok.com") || r.includes("linkedin.com") || r.includes("reddit.com") || r.includes("youtube.com")) return "Social Media";
  if (r.includes("wa.me") || r.includes("whatsapp.com") || r.includes("t.me") || r.includes("telegram.org")) return "Messaging";
  return "Other Website";
}

// ─── Track pageview log ──────────────────────────────────────
router.post("/track", async (req, res) => {
  try {
    const db = await connectDB();
    const {
      path, referrer, screenResolution, language, userAgent,
      geo, timestamp, visitorId, sessionId, sessionPageCount,
      utmSource, utmMedium, utmCampaign, funnelStep
    } = req.body;

    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const isLocal = ip.includes("127.0.0.1") || ip.includes("::1") || ip.includes("localhost") || !ip;

    let finalGeo = {};

    if (isLocal) {
      const idx = Math.floor(Math.random() * demoCities.length);
      finalGeo = {
        ...demoCities[idx],
        ip: "197.250." + Math.floor(Math.random() * 255) + "." + Math.floor(Math.random() * 255)
      };
    } else {
      // Backend-side public IP lookup (CORS immune)
      try {
        const geoRes = await fetch(`https://ipapi.co/${ip}/json/`);
        if (geoRes.ok) {
          const geoData = await geoRes.json();
          finalGeo = {
            ip,
            city: geoData.city || "Unknown City",
            country: geoData.country_name || "Unknown Country",
            countryCode: geoData.country_code || "",
            region: geoData.region || "",
            lat: Number(geoData.latitude || 0),
            lon: Number(geoData.longitude || 0),
            isp: geoData.org || ""
          };
        } else {
          throw new Error(`IP lookup failed with status: ${geoRes.status}`);
        }
      } catch (err) {
        console.warn(`Backend Geolocation lookup failed for IP ${ip}:`, err.message);
        // Fallback to random demo database on external service downtime
        const idx = Math.floor(Math.random() * demoCities.length);
        finalGeo = {
          ...demoCities[idx],
          ip
        };
      }
    }

    // Enrich referrer for local dev
    let finalReferrer = referrer || "Direct";
    if (isLocal && (!referrer || referrer === "Direct" || referrer === "")) {
      finalReferrer = demoReferrers[Math.floor(Math.random() * demoReferrers.length)];
    }

    const referrerSource = classifyReferrerSource(finalReferrer);

    const doc = {
      path: path || "/",
      referrer: finalReferrer,
      referrerSource,
      screenResolution: screenResolution || "1920x1080",
      language: language || "en",
      userAgent: userAgent || "",
      browser: parseBrowser(userAgent),
      deviceType: parseDeviceType(userAgent),
      os: parseOS(userAgent),
      ip: finalGeo.ip,
      city: finalGeo.city,
      country: finalGeo.country,
      countryCode: finalGeo.countryCode,
      region: finalGeo.region,
      lat: finalGeo.lat,
      lon: finalGeo.lon,
      isp: finalGeo.isp,
      visitorId: visitorId || null,
      sessionId: sessionId || null,
      sessionPageCount: Number(sessionPageCount) || 1,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      funnelStep: funnelStep || "pageview",
      timestamp: timestamp ? new Date(timestamp) : new Date()
    };

    await db.collection("analytics_traffic").insertOne(doc);
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fetch aggregated analytics stats ────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const db = await connectDB();
    const collection = db.collection("analytics_traffic");

    // Date range filtering
    const { range } = req.query; // '7d' | '30d' | 'today' | 'all'
    let dateFilter = {};
    const now = new Date();

    if (range === "today") {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      dateFilter = { timestamp: { $gte: startOfDay } };
    } else if (range === "30d") {
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      dateFilter = { timestamp: { $gte: thirtyDaysAgo } };
    } else if (range !== "all") {
      // Default to 7d
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      dateFilter = { timestamp: { $gte: sevenDaysAgo } };
    }

    // Total Pageviews
    const totalPageviews = await collection.countDocuments(dateFilter);

    // Unique Visitors (based on visitorId, fallback IP)
    const uniqueVisitorIds = await collection.distinct("visitorId", dateFilter);
    const uniqueIPs = await collection.distinct("ip", dateFilter);
    const uniqueVisitors = uniqueVisitorIds.filter(Boolean).length || uniqueIPs.length;

    // Returning vs New visitors
    let newVisitors = 0;
    let returningVisitors = 0;
    if (uniqueVisitorIds.filter(Boolean).length > 0) {
      const visitorCounts = await collection.aggregate([
        { $match: { ...dateFilter, visitorId: { $ne: null } } },
        { $group: { _id: "$visitorId", count: { $sum: 1 } } }
      ]).toArray();
      visitorCounts.forEach(v => {
        if (v.count === 1) newVisitors++;
        else returningVisitors++;
      });
    }

    // Bounce Rate (sessions with only 1 page view)
    const sessionStats = await collection.aggregate([
      { $match: { ...dateFilter, sessionId: { $ne: null } } },
      { $group: { _id: "$sessionId", pageCount: { $max: "$sessionPageCount" } } }
    ]).toArray();
    const totalSessions = sessionStats.length || 1;
    const bouncedSessions = sessionStats.filter(s => s.pageCount <= 1).length;
    const bounceRate = Math.round((bouncedSessions / totalSessions) * 100);

    // Average Session Duration (estimated from timestamps per session)
    const sessionDurations = await collection.aggregate([
      { $match: { ...dateFilter, sessionId: { $ne: null } } },
      {
        $group: {
          _id: "$sessionId",
          minTime: { $min: "$timestamp" },
          maxTime: { $max: "$timestamp" },
          count: { $sum: 1 }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    let avgDuration = 0;
    if (sessionDurations.length > 0) {
      const totalMs = sessionDurations.reduce((sum, s) => sum + (new Date(s.maxTime) - new Date(s.minTime)), 0);
      avgDuration = Math.round(totalMs / sessionDurations.length / 1000); // seconds
    }

    // Timeline (days count depends on range)
    const timelineDays = range === "30d" ? 30 : range === "today" ? 1 : 7;
    const timelineStart = new Date(now);
    timelineStart.setDate(timelineStart.getDate() - (timelineDays - 1));
    timelineStart.setHours(0, 0, 0, 0);

    const timelineRaw = await collection.aggregate([
      { $match: { timestamp: { $gte: timelineStart } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]).toArray();

    const timelineMap = new Map(timelineRaw.map(t => [t._id, t.count]));
    const timeline = [];
    for (let i = 0; i < timelineDays; i++) {
      const d = new Date(timelineStart);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split("T")[0];
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      timeline.push({
        date: dateStr,
        label,
        count: timelineMap.get(dateStr) || 0
      });
    }

    // Peak Hours (0-23 hour distribution)
    const peakHoursRaw = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: { $hour: "$timestamp" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();
    const peakHoursMap = new Map(peakHoursRaw.map(h => [h._id, h.count]));
    const peakHours = [];
    for (let h = 0; h < 24; h++) {
      peakHours.push({ hour: h, count: peakHoursMap.get(h) || 0 });
    }

    // Referrer Sources (classified)
    const referrerSources = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$referrerSource", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { source: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Top raw referrers
    const topReferrers = await collection.aggregate([
      { $match: { ...dateFilter, referrer: { $ne: "Direct" } } },
      { $group: { _id: "$referrer", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
      { $project: { referrer: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Top Pages visited
    const topPages = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$path", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { path: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Top Countries
    const topCountries = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: { country: "$country", code: "$countryCode" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $project: { country: "$_id.country", code: "$_id.code", count: 1, _id: 0 } }
    ]).toArray();

    // Top Cities
    const topCities = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: { city: "$city", country: "$country" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $project: { city: "$_id.city", country: "$_id.country", count: 1, _id: 0 } }
    ]).toArray();

    // Browsers
    const browsers = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$browser", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { browser: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Device Types
    const devices = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$deviceType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { deviceType: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Operating Systems
    const operatingSystems = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$os", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { os: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Screen Resolutions
    const screenResolutions = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$screenResolution", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
      { $project: { resolution: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Languages
    const languages = await collection.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$language", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
      { $project: { language: "$_id", count: 1, _id: 0 } }
    ]).toArray();

    // Conversion Funnel
    const funnelPageviews = await collection.countDocuments({ ...dateFilter, funnelStep: "pageview" });
    const funnelFormViews = await collection.countDocuments({ ...dateFilter, funnelStep: "form_view" });
    const funnelSubmissions = await collection.countDocuments({ ...dateFilter, funnelStep: "form_submit" });
    const funnel = [
      { step: "Page Visits", count: funnelPageviews || totalPageviews },
      { step: "Form Viewed", count: funnelFormViews },
      { step: "Form Submitted", count: funnelSubmissions }
    ];

    // UTM Campaigns
    const utmCampaigns = await collection.aggregate([
      { $match: { ...dateFilter, utmSource: { $ne: null } } },
      { $group: { _id: { source: "$utmSource", medium: "$utmMedium", campaign: "$utmCampaign" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $project: { source: "$_id.source", medium: "$_id.medium", campaign: "$_id.campaign", count: 1, _id: 0 } }
    ]).toArray();

    // Last 150 visitor coordinates for Map Pins
    const mapMarkers = await collection.find(dateFilter)
      .sort({ timestamp: -1 })
      .limit(150)
      .project({
        path: 1, browser: 1, deviceType: 1, os: 1,
        city: 1, country: 1, lat: 1, lon: 1, ip: 1,
        referrerSource: 1, timestamp: 1
      })
      .toArray();

    const formattedMarkers = mapMarkers.map(m => ({
      id: m._id.toString(),
      path: m.path,
      browser: m.browser,
      deviceType: m.deviceType,
      os: m.os,
      city: m.city,
      country: m.country,
      lat: m.lat,
      lon: m.lon,
      ip: m.ip,
      referrerSource: m.referrerSource,
      timestamp: m.timestamp
    }));

    res.json({
      totalPageviews,
      uniqueVisitors,
      newVisitors,
      returningVisitors,
      bounceRate,
      avgDuration,
      totalSessions,
      timeline,
      peakHours,
      referrerSources,
      topReferrers,
      topPages,
      topCountries,
      topCities,
      browsers,
      devices,
      operatingSystems,
      screenResolutions,
      languages,
      funnel,
      utmCampaigns,
      mapMarkers: formattedMarkers
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
