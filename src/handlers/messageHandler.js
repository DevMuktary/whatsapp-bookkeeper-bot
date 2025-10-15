import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { extractBusinessName, extractEmail } from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendInteractiveButtons } from '../api/whatsappService.js';
import { USER_STATES } from '../utils/constants.js';
import logger from '../utils/logger.js';

export async function handleMessage(message) {
  const whatsappId = message.from;
  const text = message.text.body;

  try {
    const user = await findOrCreateUser(whatsappId);

    // Main state machine logic
    switch (user.state) {
      case USER_STATES.ONBOARDING_AWAIT_BUSINESS_NAME:
        await handleBusinessName(user, text);
        break;

      case USER_STATES.ONBOARDING_AWAIT_EMAIL:
        await handleEmail(user, text);
        break;

      case USER_STATES.ONBOARDING_AWAIT_OTP:
        await handleOtp(user, text);
        break;

      // We will handle currency and idle states later
      case USER_STATES.IDLE:
        await sendTextMessage(whatsappId, "You're already set up! We will build the main menu next.");
        break;

      default:
        logger.warn(`Unhandled state: ${user.state} for user ${whatsappId}`);
        await sendTextMessage(whatsappId, "I'm sorry, I seem to be a little confused. Let's start over.");
        // Optional: Reset user state here if this happens
        break;
    }
  } catch (error) {
    logger.error(`Error in message handler for ${whatsappId}:`, error);
    await sendTextMessage(whatsappId, "I'm sorry, something went wrong on my end. Please try again in a moment.");
  }
}

async function handleBusinessName(user, text) {
  const { businessName } = await extractBusinessName(text);
  if (businessName) {
    await updateUser(user.whatsappId, { businessName });
    await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_EMAIL);
    await sendTextMessage(user.whatsappId, `Great! "${businessName}" sounds like a wonderful business. What's the best email address I can use to reach you?`);
  } else {
    await sendTextMessage(user.whatsappId, "I'm sorry, I didn't quite catch that. Could you please tell me your business name?");
  }
}

async function handleEmail(user, text) {
  const { email } = await extractEmail(text);
  if (email) {
    const otp = await sendOtp(email, user.businessName);
    const tenMinutes = 10 * 60 * 1000;
    const otpExpires = new Date(Date.now() + tenMinutes);

    await updateUser(user.whatsappId, { email, otp, otpExpires });
    await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_OTP);
    await sendTextMessage(user.whatsappId, `Perfect. I've just sent a 6-digit verification code to ${email}. Please enter it here.`);
  } else {
    await sendTextMessage(user.whatsappId, "That doesn't look like a valid email address. Could you please provide a correct one?");
  }
}

async function handleOtp(user, text) {
    const otpAttempt = text.trim();
    if (user.otpExpires < new Date()) {
        await sendTextMessage(user.whatsappId, "I'm sorry, that code has expired. Let's try sending a new one.");
        // Resend OTP
        await handleEmail(user, user.email);
        return;
    }

    if (user.otp === otpAttempt) {
        await updateUser(user.whatsappId, { isEmailVerified: true, otp: null, otpExpires: null });
        await updateUserState(user.whatsappId, USER_STATES.IDLE); // For now, we go straight to IDLE. Currency step next.
        await sendTextMessage(user.whatsappId, `✅ Email verified! Welcome aboard, ${user.businessName}. You're all set up!`);
        await sendTextMessage(user.whatsappId, `You can start by telling me about a sale, an expense, or a new product. For example, "I sold 2 shoes for 5000 each".`);
    } else {
        await sendTextMessage(user.whatsappId, "That code doesn't seem to match. Please double-check and try again.");
    }
}
