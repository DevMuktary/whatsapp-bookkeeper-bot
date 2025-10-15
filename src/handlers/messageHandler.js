import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { extractOnboardingDetails, extractCurrency, getIntent, gatherSaleDetails, gatherExpenseDetails, gatherProductDetails } from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendInteractiveButtons } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';

export async function handleMessage(message) {
  const whatsappId = message.from;
  const text = message.text.body;

  try {
    const user = await findOrCreateUser(whatsappId);

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
        await handleIdleState(user, text);
        break;
      case USER_STATES.LOGGING_SALE:
        await handleLoggingSale(user, text);
        break;
      case USER_STATES.LOGGING_EXPENSE:
        await handleLoggingExpense(user, text);
        break;
      case USER_STATES.ADDING_PRODUCT:
        await handleAddingProduct(user, text);
        break;
      // We removed AWAITING_BULK_PRODUCT_CONFIRMATION from here
      // because it's handled by the interactiveHandler now.
      default:
        logger.warn(`Unhandled state: ${user.state} for user ${whatsappId}`);
        await sendTextMessage(whatsappId, "Apologies, I'm a bit stuck. Let's get you back on track.");
        await updateUserState(whatsappId, USER_STATES.IDLE);
        break;
    }
  } catch (error)
 {
    logger.error(`Error in message handler for ${whatsappId}:`, error);
    await sendTextMessage(whatsappId, "Oh dear, something went wrong on my end. Please try again in a moment. 🛠️");
  }
}

async function handleIdleState(user, text) {
    const { intent, context } = await getIntent(text);

    if (intent === INTENTS.LOG_SALE) {
        logger.info(`Intent detected: LOG_SALE for user ${user.whatsappId}`);
        const initialMemory = [{ role: 'user', content: text }];
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: initialMemory });
        await handleLoggingSale({ ...user, state: USER_STATES.LOGGING_SALE, stateContext: { memory: initialMemory } }, text);
    } else if (intent === INTENTS.LOG_EXPENSE) {
        logger.info(`Intent detected: LOG_EXPENSE for user ${user.whatsappId}`);
        const initialMemory = [{ role: 'user', content: text }];
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: initialMemory });
        await handleLoggingExpense({ ...user, state: USER_STATES.LOGGING_EXPENSE, stateContext: { memory: initialMemory } }, text);
    } else if (intent === INTENTS.ADD_PRODUCT) {
        logger.info(`Intent detected: ADD_PRODUCT for user ${user.whatsappId}`);
        
        let existingProduct = null;
        if (context.productName) {
            existingProduct = await findProductByName(user._id, context.productName);
        }

        const initialMemory = [{ role: 'user', content: text }];
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: initialMemory, existingProduct });
        await handleAddingProduct({ ...user, state: USER_STATES.ADDING_PRODUCT, stateContext: { memory: initialMemory, existingProduct } }, text);
    } else if (intent === INTENTS.ADD_MULTIPLE_PRODUCTS) {
        logger.info(`Intent detected: ADD_MULTIPLE_PRODUCTS for user ${user.whatsappId}`);
        
        const products = context.products || [];
        if (products.length === 0) {
            await sendTextMessage(user.whatsappId, "I see you want to add multiple products, but I had trouble understanding the list. Could you try a simpler format like:\n\n`Add 10 shirts (cost 1k, sell 2k) and 5 trousers (cost 2k, sell 4k)`");
            return;
        }

        // --- THE NEW CONFIRMATION FLOW ---
        let summary = "Great! I've found the following items. Please confirm:\n\n";
        products.forEach((p, index) => {
            const cost = new Intl.NumberFormat('en-US').format(p.costPrice);
            const sell = new Intl.NumberFormat('en-US').format(p.sellingPrice);
            summary += `${index + 1}. *${p.quantityAdded}x ${p.productName}*\n   Cost: ${user.currency} ${cost}, Sell: ${user.currency} ${sell}\n`;
        });
        
        // Store the parsed products in the user's state context
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION, { products: products });
        
        // Send the summary and interactive buttons
        await sendInteractiveButtons(
            user.whatsappId,
            summary,
            [
                { id: 'confirm_bulk_add', title: '✅ Yes, Proceed' },
                { id: 'cancel_bulk_add', title: '❌ No, Cancel' }
            ]
        );

    } else {
        await sendTextMessage(user.whatsappId, "I'm sorry, I can only help with bookkeeping tasks right now. Try saying 'log a sale' or 'add a new product'.");
    }
}

async function handleLoggingSale(user, text) {
    const currentMemory = user.stateContext.memory || [];
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    
    const aiResponse = await gatherSaleDetails(currentMemory);
    
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        await sendTextMessage(user.whatsappId, "Got it! Let me record that for you... 📝");
        await executeTask(INTENTS.LOG_SALE, user, aiResponse.data);
    }
}

async function handleLoggingExpense(user, text) {
    const currentMemory = user.stateContext.memory || [];
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }

    const aiResponse = await gatherExpenseDetails(currentMemory);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        await sendTextMessage(user.whatsappId, "Okay, noting that down... ✍️");
        await executeTask(INTENTS.LOG_EXPENSE, user, aiResponse.data);
    }
}

async function handleAddingProduct(user, text) {
    const { memory: currentMemory = [], existingProduct } = user.stateContext;

    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }

    const aiResponse = await gatherProductDetails(currentMemory, existingProduct);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: aiResponse.memory, existingProduct });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        await sendTextMessage(user.whatsappId, "Alright, adding that to your inventory... 📋");
        await executeTask(INTENTS.ADD_PRODUCT, user, aiResponse.data);
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

  if (updatedUser.businessName && updatedUser.email) {
    const otp = await sendOtp(updatedUser.email, updatedUser.businessName);
    const tenMinutes = 10 * 60 * 1000;
    const otpExpires = new Date(Date.now() + tenMinutes);

    await updateUser(updatedUser.whatsappId, { otp, otpExpires });
    await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_OTP);
    await sendTextMessage(updatedUser.whatsappId, `Perfect! I've just sent a 6-digit verification code to ${updatedUser.email}. 📧 Please enter it here to continue.`);
  } else if (updatedUser.businessName) {
    await sendTextMessage(updatedUser.whatsappId, `Got it! Your business is "${updatedUser.businessName}". Now, what's your email address?`);
  } else if (updatedUser.email) {
    await sendTextMessage(updatedUser.whatsappId, `Thanks! I have your email as ${updatedUser.email}. What's your business name?`);
  } else {
    await sendTextMessage(user.whatsappId, "I'm sorry, I couldn't quite understand that. Could you please provide your business name and email address?");
  }
}

async function handleOtp(user, text) {
  const otpAttempt = text.trim();
  if (user.otpExpires < new Date()) {
    await sendTextMessage(user.whatsappId, "It looks like that code has expired. 😥 Let's send a new one.");
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
