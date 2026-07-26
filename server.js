const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const config = require('./config');

const app = express();

// Configure CORS for production allowed origins
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin || config.ALLOWED_ORIGINS.includes('*') || config.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy does not allow access from origin: ${origin}`));
    }
  },
  credentials: true
};

app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '500mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Import and use the routers
const dataRouter = require('./routes/dataRouter');
const newsletterSubscribersRouter = require('./routes/newsletterSubscribersRouter');
const galleryRouter = require('./routes/galleryRouter');
const reportsRouter = require('./routes/reportsRouter');
const analyticsRouter = require('./routes/analyticsRouter');
const notificationRouter = require('./routes/notificationRouter');
const pushRouter = require('./routes/pushRouter');

app.use('/api', dataRouter);
app.use('/api/newsletter-subscribers', newsletterSubscribersRouter);
app.use('/api/gallery', galleryRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/push', pushRouter);

// Health check endpoint for deployment monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok', environment: process.env.NODE_ENV || 'development', timestamp: new Date() });
});

const PORT = config.PORT;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});
