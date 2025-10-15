import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { extractOnboardingDetails, extractCurrency } from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage } from '../api/whatsappService.js';
import { USER_STATES } from '../utils/constants.js';
import logger from '../utils/logger.js';

export async function handleMessage(message) {
  const whatsappId = message.from;
  const text = message.text.body;

  try {
    const user = await findOrCreateUser(whatsappId);

    // Main state machine logic
    switch (user.state) {
      case USER_STATES.NEW_USER:
        await handleNewUser(user);
        break;

      case USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL:
        await handleOnboardingDetails(user, text);
        break;

      case USER_STATES.ONBOARDING_AWAIT_OTP:
        await handleOtp(user, text);
        break;

      case USER_STATES.ONBOARDING_AWAIT_CURRENCY:
        await handleCurrency(user, text);
        break;

      case USER_STATES.IDLE:
        // This is where our main "Router AI" will live later.
        await sendTextMessage(whatsappId, "You're all set up! We will build the main menu next phase. 🚀");
        break;

      default:
        logger.warn(`Unhandled state: ${user.state} for user ${whatsappId}`);
        await sendTextMessage(whatsappId, "Apologies, I'm a bit stuck. Let's get you back on track.");
        // We could reset the user's state here if needed.
        break;
    }
  } catch (error) {
    logger.error(`Error in message handler for ${whatsappId}:`, error);
    await sendTextMessage(whatsappId, "Oh dear, something went wrong on my end. Please try again in a moment. 🛠️");
  }
}

async function handleNewUser(user) {
  await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL);
  await sendTextMessage(user.whatsappId, "👋 Welcome to Fynax Bookkeeper! I'm here to help you manage your business finances effortlessly.");
  await sendTextMessage(user.whatsappId, "To get started, what is your business name and your email address?");
}

async function handleOnboardingDetails(user, text) {
  const { businessName, email } = await extractOnboardingDetails(text);
  
  let updates = {};
  if (businessName) updates.businessName = businessName;
  if (email) updates.email = email;

  let updatedUser = user;
  if (Object.keys(updates).length > 0) {
    updatedUser = await updateUser(user.whatsappId, updates);
  }

  // Check if we have everything we need
  if (updatedUser.businessName && updatedUser.email) {
    const otp = await sendOtp(updatedUser.email, updatedUser.businessName);
    const tenMinutes = 10 * 60 * 1000;
    const otpExpires = new Date(Date.now() + tenMinutes);

    await updateUser(updatedUser.whatsappId, { otp, otpExpires });
    await updateUserState(updatedUser.whatsappId, USER_STATES.ONBOARDING_AWAIT_OTP);
    await sendTextMessage(updatedUser.whatsappId, `Perfect! I've just sent a 6-digit verification code to ${updatedUser.email}. 📧 Please enter it here to continue.`);
  } else if (updatedUser.businessName) {
    await sendTextMessage(updatedUser.whatsappId, `Got it! Your business is "${updatedUser.businessName}". Now, what's your email address?`);
  } else if (updatedUser.email) {
    await sendTextMessage(updatedUser.whatsappId, `Thanks! I have your email as ${updatedUser.email}. What's your business name?`);
  } else {
    await sendTextMessage(updatedUser.whatsappId, "I'm sorry, I couldn't quite understand that. Could you please provide your business name and email address?");
  }
}

async function handleOtp(user, text) {
  const otpAttempt = text.trim();
  if (user.otpExpires < new Date()) {
    await sendTextMessage(user.whatsappId, "It looks like that code has expired. 😥 Let's send a new one.");
    // Re-trigger the email sending process
    await handleOnboardingDetails(user, user.email);
    return;
  }

  if (user.otp === otpAttempt) {
    await updateUser(user.whatsappId, { isEmailVerified: true, otp: null, otpExpires: null });
    await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_CURRENCY);
    await sendTextMessage(user.whatsappId, `✅ Email verified! Just one last thing: what is your primary business currency? (e.g., Naira, GHS, USD)`);
  } else {
    await sendTextMessage(user.whatsappId, "That code doesn't seem to match. Please double-check and try again. 🤔");
  }
}

async function handleCurrency(user, text) {
  const { currency } = await extractCurrency(text);
  if (currency) {
    await updateUser(user.whatsappId, { currency });
    await updateUserState(user.whatsappId, USER_STATES.IDLE);
    await sendTextMessage(user.whatsappId, `Excellent! Your account is fully set up with ${currency} as your currency. 🎉`);
    await sendTextMessage(user.whatsappId, `You can now start managing your finances. Try telling me about a sale or an expense. For example:\n\n_"I sold 2 loaves of bread for 500 each"_`);
  } else {
    await sendTextMessage(user.whatsappId, "I didn't recognize that currency. Please tell me your main currency, like 'Naira', 'Dollars', or 'GHS'.");
  }
}

