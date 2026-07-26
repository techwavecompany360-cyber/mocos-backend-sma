require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://techwave:X7vX4IJQAlDck1gI@techwave.6n65bsi.mongodb.net',
  DB_NAME: process.env.DB_NAME || 'mocos_database',
  JWT_SECRET: process.env.JWT_SECRET || 'b6e2c7e7-8f2a-4c1e-9d2e-7a3f4b8c2d1f',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) 
    : ['http://localhost:5173', 'http://localhost:5174', 'https://dashboard.mocos.co.tz', 'https://mocos.co.tz', 'https://www.mocos.co.tz'],
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:admin@mocos.co.tz'
};
