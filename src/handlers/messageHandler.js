import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { getAllBankAccounts } from '../db/bankService.js';
import { getRecentTransactions } from '../db/transactionService.js';
import { extractOnboardingDetails, extractCurrency, getIntent, gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, gatherPaymentDetails, gatherBankAccountDetails } from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, sendReportMenu } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';

const CANCEL_KEYWORDS = ['cancel', 'stop', 'exit', 'nevermind', 'abort'];

/**
 * Parses a price string (e.g., "₦1,000", "2.5m", "50k") into a number.
 * @param {string} priceStr The string to parse.
 * @returns {number} The parsed numeric value.
 */
const parsePrice = (priceStr) => {
    if (!priceStr) return NaN;
    const cleaned = priceStr.toString().replace(/₦|,/g, '').toLowerCase();
    let multiplier = 1;
    if (cleaned.endsWith('k')) {
        multiplier = 1000;
    } else if (cleaned.endsWith('m')) {
        multiplier = 1000000;
    }
    return parseFloat(cleaned) * multiplier;
};

/**
 * A reliable, deterministic parser for multi-line product lists.
 * @param {string} text The raw text message from the user.
 * @returns {Array<object>} An array of parsed product objects.
 */
const parseProductList = (text) => {
    const products = [];
    const lines = text.split('\n');
    const lineRegex = /^\s*\d+\.?\s+(\d+)\s+(.+?)\s*-\s*cost:\s*([^,]+),?\s*sell:\s*(.+)/i;

    for (const line of lines) {
        const match = line.trim().match(lineRegex);
        if (match) {
            try {
                const [, quantityAdded, productName, costPriceStr, sellingPriceStr] = match;
                products.push({
                    quantityAdded: parseInt(quantityAdded.trim(), 10),
                    productName: productName.trim(),
                    costPrice: parsePrice(costPriceStr.trim()),
                    sellingPrice: parsePrice(sellingPriceStr.trim())
                });
            } catch (e) {
                logger.warn(`Failed to parse line: "${line}"`);
            }
        }
    }
    return products;
};


export async function handleMessage(message) {
  const whatsappId = message.from;
  const originalText = message.text.body; 
  const lowerCaseText = originalText.trim().toLowerCase(); 

  try {
    const user = await findOrCreateUser(whatsappId);

    if (CANCEL_KEYWORDS.includes(lowerCaseText)) {
        if (user.state === USER_STATES.IDLE) {
            await sendTextMessage(whatsappId, "There's nothing to cancel. What would you like to do?");
            return;
        }
        logger.info(`User ${whatsappId} cancelled operation from state: ${user.state}`);
        await updateUserState(whatsappId, USER_STATES.IDLE, {});
        await sendTextMessage(whatsappId, "Okay, I've cancelled the current operation. 👍");
        await sendMainMenu(whatsappId); // Send main menu after cancelling
        return; 
    }

    switch (user.state) {
      case USER_STATES.NEW_USER: await handleNewUser(user); break;
      case USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL: await handleOnboardingDetails(user, originalText); break;
      case USER_STATES.ONBOARDING_AWAIT_OTP: await handleOtp(user, originalText); break;
      case USER_STATES.ONBOARDING_AWAIT_CURRENCY: await handleCurrency(user, originalText); break;
      case USER_STATES.IDLE: await handleIdleState(user, originalText); break;
      case USER_STATES.LOGGING_SALE: await handleLoggingSale(user, originalText); break;
      case USER_STATES.LOGGING_EXPENSE: await handleLoggingExpense(user, originalText); break;
      case USER_STATES.ADDING_PRODUCT: await handleAddingProduct(user, originalText); break;
      case USER_STATES.LOGGING_CUSTOMER_PAYMENT: await handleLoggingCustomerPayment(user, originalText); break;
      case USER_STATES.ADDING_BANK_ACCOUNT: await handleAddingBankAccount(user, originalText); break;
      case USER_STATES.AWAITING_EDIT_VALUE: await handleEditValue(user, originalText); break;
        
      case USER_STATES.AWAITING_BANK_SELECTION_SALE:
      case USER_STATES.AWAITING_BANK_SELECTION_EXPENSE:
        await sendTextMessage(whatsappId, "Please select one of the bank accounts from the buttons I sent, or type 'cancel' to start over.");
        break;
      case USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION:
      case USER_STATES.AWAITING_INVOICE_CONFIRMATION:
      case USER_STATES.AWAITING_DELETE_CONFIRMATION:
      case USER_STATES.AWAITING_RECONCILE_ACTION:
      case USER_STATES.AWAITING_EDIT_FIELD_SELECTION:
        await sendTextMessage(whatsappId, "Please choose one of the options from the buttons I sent, or type 'cancel'.");
        break;
      case USER_STATES.AWAITING_TRANSACTION_SELECTION:
        await sendTextMessage(whatsappId, "Please select an item from the list I sent to proceed, or type 'cancel'.");
        break;
      case USER_STATES.AWAITING_REPORT_TYPE_SELECTION:
        await sendTextMessage(whatsappId, "Please select a report from the list I sent, or type 'cancel'.");
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

    if (intent === INTENTS.CHITCHAT) {
        logger.info(`Intent detected: CHITCHAT for user ${user.whatsappId}`);
        await sendTextMessage(user.whatsappId, "No problem! What can I help you with?");
        await sendMainMenu(user.whatsappId);
    } else if (intent === INTENTS.SHOW_MAIN_MENU) {
        logger.info(`Intent detected: SHOW_MAIN_MENU for user ${user.whatsappId}`);
        await sendMainMenu(user.whatsappId);
    } else if (intent === INTENTS.ADD_PRODUCTS_FROM_LIST) {
        logger.info(`Intent detected: ADD_PRODUCTS_FROM_LIST for user ${user.whatsappId}`);
        const products = parseProductList(text);
        if (products.length === 0) {
            await sendTextMessage(user.whatsappId, "I see you sent a list, but I couldn't understand its format. Please try a format like:\n\n`1. 10 Shirts - cost: 5000, sell: 8000`");
            return;
        }
        let summary = "Great! I've parsed your list. Please confirm these items:\n\n";
        products.forEach((p, index) => {
            const cost = new Intl.NumberFormat('en-US').format(p.costPrice);
            const sell = new Intl.NumberFormat('en-US').format(p.sellingPrice);
            summary += `${index + 1}. *${p.quantityAdded}x ${p.productName}*\n   Cost: ${user.currency} ${cost}, Sell: ${user.currency} ${sell}\n`;
        });
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION, { products });
        await sendInteractiveButtons(user.whatsappId, summary, [
            { id: 'confirm_bulk_add', title: '✅ Yes, Proceed' },
            { id: 'cancel_bulk_add', title: '❌ No, Cancel' }
        ]);
    } else if (intent === INTENTS.LOG_SALE) {
        let existingProduct = null;
        if (context.productName) {
            existingProduct = await findProductByName(user._id, context.productName);
        }
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: [{ role: 'user', content: text }], existingProduct });
        await handleLoggingSale({ ...user, state: USER_STATES.LOGGING_SALE, stateContext: { memory: [{ role: 'user', content: text }], existingProduct } }, text);
    } else if (intent === INTENTS.LOG_EXPENSE) {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: [{ role: 'user', content: text }] });
        await handleLoggingExpense({ ...user, state: USER_STATES.LOGGING_EXPENSE, stateContext: { memory: [{ role: 'user', content: text }] } }, text);
    } else if (intent === INTENTS.ADD_PRODUCT) {
        let existingProduct = null;
        if (context.productName) {
            existingProduct = await findProductByName(user._id, context.productName);
        }
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: [{ role: 'user', content: text }], existingProduct });
        await handleAddingProduct({ ...user, state: USER_STATES.ADDING_PRODUCT, stateContext: { memory: [{ role: 'user', content: text }], existingProduct } }, text);
    } else if (intent === INTENTS.LOG_CUSTOMER_PAYMENT) {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: [{ role: 'user', content: text }] });
        await handleLoggingCustomerPayment({ ...user, state: USER_STATES.LOGGING_CUSTOMER_PAYMENT, stateContext: { memory: [{ role: 'user', content: text }] } }, text);
    } else if (intent === INTENTS.ADD_BANK_ACCOUNT || text.toLowerCase().includes('manage bank')) {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: [{ role: 'user', content: text }] });
        await handleAddingBankAccount({ ...user, state: USER_STATES.ADDING_BANK_ACCOUNT, stateContext: { memory: [{ role: 'user', content: text }] } }, text);
    } else if (intent === INTENTS.RECONCILE_TRANSACTION) {
        logger.info(`Intent detected: RECONCILE_TRANSACTION for user ${user.whatsappId}`);
        const recentTransactions = await getRecentTransactions(user._id, 5);
        if (recentTransactions.length === 0) {
            await sendTextMessage(user.whatsappId, "You don't have any recent transactions to modify.");
            await sendMainMenu(user.whatsappId);
            return;
        }
        const rows = recentTransactions.map(tx => {
            const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(tx.amount);
            const title = tx.description.length > 24 ? tx.description.substring(0, 21) + '...' : tx.description;
            return { id: `select_tx:${tx._id}`, title: title, description: `${tx.type} - ${formattedAmount}` };
        });
        const sections = [{ title: "Recent Transactions", rows: rows }];
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_TRANSACTION_SELECTION);
        await sendInteractiveList(user.whatsappId, "Modify Transaction", "Please select the transaction you would like to modify.", "View Transactions", sections);
    } else if (intent === INTENTS.GENERATE_REPORT) {
        if (context.reportType) {
            await executeTask(intent, user, context);
        } else {
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_REPORT_TYPE_SELECTION);
            await sendReportMenu(user.whatsappId);
        }
    } else if (intent === INTENTS.CHECK_STOCK || intent === INTENTS.GET_FINANCIAL_SUMMARY || intent === INTENTS.CHECK_BANK_BALANCE || intent === INTENTS.GET_FINANCIAL_INSIGHT || intent === INTENTS.GET_CUSTOMER_BALANCES) {
        logger.info(`Intent detected: ${intent} for user ${user.whatsappId}`);
        await executeTask(intent, user, context);
    } else {
        await sendTextMessage(user.whatsappId, "I'm not sure I understood that. You can choose an option from the main menu or ask me something like 'log a sale'.");
        await sendMainMenu(user.whatsappId);
    }
}

async function handleLoggingSale(user, text) {
    const { memory: currentMemory = [], existingProduct } = user.stateContext;
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    const aiResponse = await gatherSaleDetails(currentMemory, existingProduct);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: aiResponse.memory, existingProduct });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        const saleData = aiResponse.data;
        if (isNaN(parsePrice(saleData.amountPerUnit))) {
            await sendTextMessage(user.whatsappId, "There was an issue with the price. Let's try that again. What is the price per unit?");
            return;
        }
        
        if (saleData.saleType.toLowerCase() === 'credit') {
            await sendTextMessage(user.whatsappId, "Got it! Let me record that credit sale... 📝");
            await executeTask(INTENTS.LOG_SALE, user, saleData);
        } else {
            const banks = await getAllBankAccounts(user._id);
            if (banks.length === 0) {
                await sendTextMessage(user.whatsappId, "FYI: You haven't set up any bank accounts. I'll log this sale, but I can't track it against a specific account.");
                await executeTask(INTENTS.LOG_SALE, user, saleData);
            } else {
                await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_SALE, { transactionData: saleData });
                const buttons = banks.map(bank => ({ id: `select_bank:${bank._id}`, title: bank.bankName }));
                await sendInteractiveButtons(user.whatsappId, 'Which account received the payment?', buttons);
            }
        }
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
        const expenseData = aiResponse.data;
        const banks = await getAllBankAccounts(user._id);

        if (banks.length === 0) {
            await sendTextMessage(user.whatsappId, "FYI: You haven't set up any bank accounts. I'll log this expense, but I can't track it against a specific account.");
            await executeTask(INTENTS.LOG_EXPENSE, user, expenseData);
        } else {
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_EXPENSE, { transactionData: expenseData });
            const buttons = banks.map(bank => ({ id: `select_bank:${bank._id}`, title: bank.bankName }));
            await sendInteractiveButtons(user.whatsappId, 'Which account was used for this payment?', buttons);
        }
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

async function handleLoggingCustomerPayment(user, text) {
    const currentMemory = user.stateContext.memory || [];
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    const aiResponse = await gatherPaymentDetails(currentMemory, user.currency);
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        await sendTextMessage(user.whatsappId, "Perfect, let me record that payment... 💰");
        await executeTask(INTENTS.LOG_CUSTOMER_PAYMENT, user, aiResponse.data);
    }
}

async function handleAddingBankAccount(user, text) {
    const currentMemory = user.stateContext.memory || [];
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }

    const aiResponse = await gatherBankAccountDetails(currentMemory, user.currency);
    
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        await sendTextMessage(user.whatsappId, "Got it! Adding your new bank account... 🏦");
        await executeTask(INTENTS.ADD_BANK_ACCOUNT, user, aiResponse.data);
    }
}

async function handleEditValue(user, text) {
    const { transaction, fieldToEdit } = user.stateContext;
    if (!transaction || !fieldToEdit) {
        await sendTextMessage(user.whatsappId, "I've lost my train of thought. Please start the edit process again.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        return;
    }
    
    let newValue;
    if (['unitsSold', 'amountPerUnit', 'amount'].includes(fieldToEdit)) {
        newValue = parseFloat(text);
        if (isNaN(newValue)) {
            await sendTextMessage(user.whatsappId, "That doesn't seem to be a valid number. Please provide a number for this field.");
            return;
        }
    } else {
        newValue = text;
    }

    const changes = { [fieldToEdit]: newValue };
    
    await sendTextMessage(user.whatsappId, "Okay, applying your changes... 🔄");
    await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId: transaction._id, action: 'edit', changes });
}

async function handleNewUser(user) {
  await updateUserState(user.whatsappId, USER_STATES.NEW_USER);
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
    await sendTextMessage(user.whatsappId, `Perfect! I've just sent a 6-digit verification code to ${updatedUser.email}. 📧 Please enter it here to continue.`);
  } else if (updatedUser.businessName) {
    await sendTextMessage(user.whatsappId, `Got it! Your business is "${updatedUser.businessName}". Now, what's your email address?`);
  } else if (updatedUser.email) {
    await sendTextMessage(user.whatsappId, `Thanks! I have your email as ${updatedUser.email}. What's your business name?`);
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
    
    await sendInteractiveButtons(
        user.whatsappId,
        "You're all set! What would you like to do first?",
        [
            { id: 'log a sale', title: 'Log a Sale' },
            { id: 'log an expense', title: 'Log an Expense' },
            { id: 'add a new product', title: 'Add a Product' },
        ]
    );

  } else {
    await sendTextMessage(user.whatsappId, "I didn't recognize that currency. Please tell me your main currency, like 'Naira', 'Dollars', or 'GHS'.");
  }
}
