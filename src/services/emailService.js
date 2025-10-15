import * as Brevo from '@getbrevo/brevo';
import config from '../config/index.js';
import logger from '../utils/logger.js';

// Configure the Brevo API client
const apiInstance = new Brevo.TransactionalEmailsApi();
apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, config.brevo.apiKey);

const SENDER_EMAIL = 'no-reply@fynaxtech.com'; // Replace with your verified sender email in Brevo
const SENDER_NAME = 'Fynax Bookkeeper';

/**
 * Generates a random 6-digit OTP.
 * @returns {string} The 6-digit OTP string.
 */
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Sends a verification OTP to the user's email address.
 * @param {string} userEmail The recipient's email address.
 * @param {string} businessName The user's business name for personalization.
 * @returns {Promise<string>} The generated OTP.
 */
export async function sendOtp(userEmail, businessName) {
  const otp = generateOtp();
  const sendSmtpEmail = new Brevo.SendSmtpEmail();

  // --- FIX APPLIED HERE ---
  // The newer Brevo SDK uses plain objects for recipients and senders, not constructors.
  sendSmtpEmail.to = [{ email: userEmail, name: businessName }];
  sendSmtpEmail.sender = { name: SENDER_NAME, email: SENDER_EMAIL };
  // --- END OF FIX ---
  
  sendSmtpEmail.subject = `Your Fynax Verification Code`;
  sendSmtpEmail.htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; color: #333;">
        <h1 style="color: #4CAF50;">Hello from Fynax!</h1>
        <p>Hi ${businessName},</p>
        <p>Your verification code is: <strong style="font-size: 1.2em; color: #333;">${otp}</strong></p>
        <p>This code will expire in 10 minutes.</p>
        <p>If you did not request this, you can safely ignore this email.</p>
      </body>
    </html>
  `;

  try {
    await apiInstance.sendTransacEmail(sendSmtpEmail);
    logger.info(`OTP successfully sent to ${userEmail}`);
    return otp;
  } catch (error) {
    // The Brevo SDK can sometimes wrap errors, so we log the full body for details.
    logger.error(`Failed to send OTP email to ${userEmail}:`, JSON.stringify(error, null, 2));
    throw new Error('Could not send OTP email.');
  }
}
