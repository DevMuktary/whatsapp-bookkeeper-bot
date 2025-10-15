import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { extractOnboardingDetails, extractCurrency, getIntent, gatherSaleDetails } from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';

export async function handleMessage(message) {
  const whatsappId = message.from;
  const text = message.text.body;

  try {
    const user = await findOrCreateUser(whatsappId);

    switch (user.state) {
      // --- ONBOARDING STATES (Unchanged) ---
      case USER_STATES.NEW_USER: await handleNewUser(user); break;
      case USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL: await handleOnboardingDetails(user, text); break;
      case USER_STATES.ONBOARDING_AWAIT_OTP: await handleOtp(user, text); break;
      case USER_STATES.ONBOARDING_AWAIT_CURRENCY: await handleCurrency(user, text); break;

      // --- CORE LOGIC ---
      case USER_STATES.IDLE:
        await handleIdleState(user, text);
        break;

      case USER_STATES.LOGGING_SALE:
        await handleLoggingSale(user, text);
        break;

      default:
        logger.warn(`Unhandled state: ${user.state} for user ${whatsappId}`);
        await sendTextMessage(whatsappId, "Apologies, I'm a bit stuck. Let's get you back on track.");
        await updateUserState(whatsappId, USER_STATES.IDLE);
        break;
    }
  } catch (error) {
    logger.error(`Error in message handler for ${whatsappId}:`, error);
    await sendTextMessage(whatsappId, "Oh dear, something went wrong on my end. Please try again in a moment. 🛠️");
  }
}

async function handleIdleState(user, text) {
    const { intent, context } = await getIntent(text);

    if (intent === INTENTS.LOG_SALE) {
        logger.info(`Intent detected: LOG_SALE for user ${user.whatsappId}`);
        
        // The first message from the user becomes the start of the conversation memory
        const initialMemory = [{ role: 'user', content: text }];

        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: initialMemory });
        
        // Immediately process the first turn
        await handleLoggingSale({ ...user, state: USER_STATES.LOGGING_SALE, stateContext: { memory: initialMemory } }, text);

    } else {
        await sendTextMessage(user.whatsappId, "I'm sorry, I can only help with bookkeeping tasks right now. Try saying something like 'I made a sale'.");
    }
}

async function handleLoggingSale(user, text) {
    // Append the user's latest message to the conversation history
    const currentMemory = user.stateContext.memory || [];
    
    // Make sure not to add the very first message twice
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    
    const aiResponse = await gatherSaleDetails(currentMemory);
    
    if (aiResponse.status === 'incomplete') {
        // AI needs more info, so we ask the user and save the new conversation memory
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        // AI has all info, execute the task
        await sendTextMessage(user.whatsappId, "Got it! Let me record that for you... 📝");
        await executeTask(INTENTS.LOG_SALE, user, aiResponse.data);
    }
}

// --- ONBOARDING HANDLERS (Unchanged) ---
async function handleNewUser(user) { /* ... no changes ... */ }
async function handleOnboardingDetails(user, text) { /* ... no changes ... */ }
async function handleOtp(user, text) { /* ... no changes ... */ }
async function handleCurrency(user, text) { /* ... no changes ... */ }
