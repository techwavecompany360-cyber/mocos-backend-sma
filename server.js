const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { initSocket } = require('./utils/socketManager');

const app = express();

// Configure CORS for allowed origins
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || config.ALLOWED_ORIGINS.includes('*') || config.ALLOWED_ORIGINS.includes(origin) || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy does not allow access from origin: ${origin}`));
    }
  },
  credentials: true
};

app.use(cors(corsOptions));
// Note: firmware file uploads bypass body-parser via busboy streaming.
// body-parser handles JSON/form API payloads only.
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
// No body size limit for raw binary streams (handled per-route by busboy)
app.use('/public', express.static(path.join(__dirname, 'public')));


// Import and use the routers
const dataRouter = require('./routes/dataRouter');
const newsletterSubscribersRouter = require('./routes/newsletterSubscribersRouter');
const galleryRouter = require('./routes/galleryRouter');
const reportsRouter = require('./routes/reportsRouter');
const analyticsRouter = require('./routes/analyticsRouter');
const notificationRouter = require('./routes/notificationRouter');
const pushRouter = require('./routes/pushRouter');
const apnsPushRouter = require('./routes/apnsPushRouter');
const { router: customerAuthRouter } = require('./routes/customerAuthRouter');
const walletRouter = require('./routes/walletRouter');
const firmwareRouter = require('./routes/firmwareRouter');
const shopRouter = require('./routes/shopRouter');
const branchRouter = require('./routes/branchRouter');
const branchStaffAuthRouter = require('./routes/branchStaffAuthRouter');
const serviceManagementRouter = require('./routes/serviceManagementRouter');
const partnerRouter = require('./routes/partnerRouter');
const chatRouter = require('./routes/chatRouter');
const beforeAfterRouter = require('./routes/beforeAfterRouter');
const depositRouter = require('./routes/depositRouter');

app.use('/api', dataRouter);
app.use('/api/newsletter-subscribers', newsletterSubscribersRouter);
app.use('/api/gallery', galleryRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/push', pushRouter);
app.use('/api/push/apns', apnsPushRouter);

app.use('/api/customer', customerAuthRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/firmware', firmwareRouter);
app.use('/api/shop', shopRouter);
app.use('/api/branches', branchRouter);
app.use('/api/partners', partnerRouter);
app.use('/api/branch-staff', branchStaffAuthRouter);
app.use('/api/service-management', serviceManagementRouter);
app.use('/api/chat', chatRouter);
app.use('/api/before-after', beforeAfterRouter);
app.use('/api/deposit', depositRouter);
app.use('/before-after', express.static(path.join(__dirname, 'public/before-after')));

// Health check endpoint for deployment monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok', environment: process.env.NODE_ENV || 'development', timestamp: new Date() });
});

// Create HTTP server and attach Socket.IO
const httpServer = http.createServer(app);
initSocket(httpServer);

const { ensureAdminUserExists } = require('./utils/adminSeeder');

const PORT = config.PORT;
httpServer.listen(PORT, async () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`Socket.IO chat server active on port ${PORT}`);
  await ensureAdminUserExists();
});
