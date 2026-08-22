const nodemailer = require('nodemailer');
const connectDB = require('./db');

// SMTP Transporter Configuration
const SMTP_HOST = process.env.SMTP_HOST || 'mail.mocos.co.tz';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_SECURE = process.env.SMTP_SECURE !== 'false';
const SMTP_USER = process.env.SMTP_USER || 'updates@mocos.co.tz';
const SMTP_PASS = process.env.SMTP_PASS || 'mocos@updates';
const DEFAULT_FROM = `MOCOS Updates <${SMTP_USER}>`;

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  }
  return transporter;
}

/**
 * Get Admin Email Notification Settings from Database
 */
async function getAdminEmailSettings() {
  try {
    const db = await connectDB();
    const setting = await db.collection('system_settings').findOne({ key: 'admin_notification_email' });
    if (setting) {
      return {
        enabled: setting.enabled !== false,
        email: setting.email || 'info@mocos.co.tz',
        updatedAt: setting.updatedAt
      };
    }
    return {
      enabled: true,
      email: 'info@mocos.co.tz',
      updatedAt: null
    };
  } catch (error) {
    console.error('[Email Service] Error fetching admin email settings:', error.message);
    return { enabled: true, email: 'info@mocos.co.tz', updatedAt: null };
  }
}

/**
 * Save / Update Admin Email Notification Settings in Database
 */
async function setAdminEmailSettings(email, enabled = true) {
  try {
    const db = await connectDB();
    await db.collection('system_settings').updateOne(
      { key: 'admin_notification_email' },
      {
        $set: {
          key: 'admin_notification_email',
          email: email.trim().toLowerCase(),
          enabled: !!enabled,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`[Email Service] Admin notification email updated to: ${email} (Enabled: ${enabled})`);
    return { success: true, email, enabled };
  } catch (error) {
    console.error('[Email Service] Error saving admin email settings:', error.message);
    throw error;
  }
}

/**
 * Send an email via nodemailer
 */
async function sendMail({ to, subject, html, text }) {
  try {
    const mailOptions = {
      from: DEFAULT_FROM,
      to,
      subject,
      text: text || html.replace(/<[^>]*>?/gm, ''),
      html
    };

    const info = await getTransporter().sendMail(mailOptions);
    console.log(`[Email Service] Email sent successfully to ${to}. Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Email Service] Failed to send email to ${to}:`, error.message);
    throw error;
  }
}

/**
 * Format & Send Notification Email to Admin
 */
async function sendAdminUpdateEmail(notification) {
  try {
    const settings = await getAdminEmailSettings();

    if (!settings.enabled || !settings.email) {
      console.log('[Email Service] Email notifications are disabled or recipient email not configured. Skipping email.');
      return;
    }

    const title = notification.title || '🔔 MOCOS System Update';
    const message = notification.message || 'A new update was registered on the system.';
    const type = notification.type ? notification.type.toUpperCase() : 'UPDATE';
    const timeStr = notification.createdAt
      ? new Date(notification.createdAt).toLocaleString('en-US', { timeZone: 'Africa/Dar_es_Salaam' })
      : new Date().toLocaleString('en-US', { timeZone: 'Africa/Dar_es_Salaam' });

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px; color: #333; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #e5e7eb; }
          .header { background: linear-gradient(135deg, #111827 0%, #991b1b 100%); color: #ffffff; padding: 24px; text-align: center; }
          .header h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
          .header p { margin: 4px 0 0 0; font-size: 12px; color: #fca5a5; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
          .content { padding: 32px 24px; }
          .badge { display: inline-block; background-color: #fee2e2; color: #991b1b; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
          .title { font-size: 18px; font-weight: 800; color: #111827; margin: 0 0 12px 0; }
          .message-box { background-color: #f9fafb; border-left: 4px solid #dc2626; padding: 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; line-height: 1.6; color: #374151; }
          .time { font-size: 12px; color: #6b7280; margin-top: 12px; }
          .footer { background-color: #f9fafb; padding: 16px 24px; text-align: center; font-size: 11px; color: #9ca3af; border-top: 1px solid #f3f4f6; }
          .footer a { color: #dc2626; text-decoration: none; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>MOCOS SERVICES</h1>
            <p>Admin System Notification</p>
          </div>
          <div class="content">
            <span class="badge">${type}</span>
            <h2 class="title">${title}</h2>
            <div class="message-box">
              ${message}
            </div>
            <p class="time">🕒 Sent at: ${timeStr} (EAT)</p>
          </div>
          <div class="footer">
            Sent via <strong>updates@mocos.co.tz</strong> to admin recipient: <strong>${settings.email}</strong><br>
            MOCOS Electronics Services &bull; <a href="https://mocos.co.tz">mocos.co.tz</a>
          </div>
        </div>
      </body>
      </html>
    `;

    return await sendMail({
      to: settings.email,
      subject: `[MOCOS Update] ${title}`,
      html: htmlContent
    });
  } catch (error) {
    console.error('[Email Service] Error sending admin update email:', error.message);
    // Don't crash calling thread
    return { success: false, error: error.message };
  }
}

module.exports = {
  getAdminEmailSettings,
  setAdminEmailSettings,
  sendMail,
  sendAdminUpdateEmail,
  SENDER_EMAIL: SMTP_USER
};
