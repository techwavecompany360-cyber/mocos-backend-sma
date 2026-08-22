const bcrypt = require('bcryptjs');
const connectDB = require('./db');

const ADMIN_EMAIL = 'mocoservicesinfo@gmail.com';
const DEFAULT_PASSWORD = 'mocoservices@2025';

/**
 * Ensures that the admin user exists in MongoDB on server startup.
 * Includes automatic retry logic in case database connection initializes asynchronously.
 */
async function ensureAdminUserExists(retries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const db = await connectDB();

      const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);

      // 1. Check & Ensure in 'users' collection
      const existingUser = await db.collection('users').findOne({
        $or: [
          { username: ADMIN_EMAIL.toLowerCase() },
          { email: ADMIN_EMAIL.toLowerCase() }
        ]
      });

      if (!existingUser) {
        await db.collection('users').insertOne({
          username: ADMIN_EMAIL.toLowerCase(),
          email: ADMIN_EMAIL.toLowerCase(),
          password: hashedPassword,
          role: 'admin',
          fullName: 'System Admin',
          createdAt: new Date()
        });
        console.log(`[Admin Seeder] Created default admin user in 'users' collection: ${ADMIN_EMAIL}`);
      } else {
        console.log(`[Admin Seeder] Admin user '${ADMIN_EMAIL}' verified in 'users' collection.`);
      }

      // 2. Check & Ensure in 'branch_staff' collection
      const existingStaff = await db.collection('branch_staff').findOne({
        $or: [
          { email: ADMIN_EMAIL.toLowerCase() },
          { role: 'admin' }
        ]
      });

      if (!existingStaff) {
        await db.collection('branch_staff').insertOne({
          fullName: 'System Admin',
          email: ADMIN_EMAIL.toLowerCase(),
          phoneNumber: '0767379327',
          password: hashedPassword,
          role: 'admin',
          createdAt: new Date()
        });
        console.log(`[Admin Seeder] Created default admin staff in 'branch_staff' collection: ${ADMIN_EMAIL}`);
      } else {
        console.log(`[Admin Seeder] Admin staff '${ADMIN_EMAIL}' verified in 'branch_staff' collection.`);
      }

      return; // Successfully completed
    } catch (error) {
      console.warn(`[Admin Seeder] Attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, delayMs));
      } else {
        console.error('[Admin Seeder] Could not verify/seed admin user after maximum retries.');
      }
    }
  }
}

module.exports = { ensureAdminUserExists };
