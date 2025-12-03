import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { getAllBankAccounts } from '../db/bankService.js';
import { getRecentTransactions } from '../db/transactionService.js';
import { 
    extractOnboardingDetails, extractCurrency, getIntent, 
    gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, 
    gatherPaymentDetails, gatherBankAccountDetails,
    transcribeAudio, analyzeImage 
} from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, sendReportMenu, setTypingIndicator } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';

// Import New Services
import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { createBankAccount } from '../db/bankService.js'; // Direct DB call for bank creation is fine
import { queueReportGeneration } from '../services/QueueService.js';
import { executeTask } from './taskHandler.js'; // Kept for legacy tasks (delete/edit)

const CANCEL_KEYWORDS = ['cancel', 'stop', 'exit', 'abort', 'quit'];

const parsePrice = (priceInput) => {
    if (typeof priceInput === 'number') return priceInput;
    if (typeof priceInput !== 'string') return NaN;
    const cleaned = priceInput.replace(/₦|,/g, '').toLowerCase().trim();
    let multiplier = 1;
    let numericPart = cleaned;
    if (cleaned.endsWith('k')) { multiplier = 1000; numericPart = cleaned.slice(0, -1); } 
    else if (cleaned.endsWith('m')) { multiplier = 1000000; numericPart = cleaned.slice(0, -1); }
    const value = parseFloat(numericPart);
    return isNaN(value) ? NaN : value * multiplier;
};

export async function handleMessage(message) {
  const whatsappId = message.from;
  const messageId = message.id; 
  
  try {
    await setTypingIndicator(whatsappId, 'on', messageId);
    
    // --- 1. MEDIA PROCESSING (Voice & Vision) ---
    let userInputText = "";

    if (message.type === 'text') {
        userInputText = message.text.body;
    } else if (message.type === 'audio') {
        await sendTextMessage(whatsappId, "🎧 Listening to your voice note...");
        const transcribed = await transcribeAudio(message.audio.id);
        if (transcribed) {
            userInputText = transcribed;
            await sendTextMessage(whatsappId, `_Transcribed: "${transcribed}"_`);
        } else {
            await sendTextMessage(whatsappId, "I couldn't quite hear that. Could you type it instead?");
            return;
        }
    } else if (message.type === 'image') {
        await sendTextMessage(whatsappId, "👀 Analyzing your image...");
        const caption = message.image.caption || "";
        const analysis = await analyzeImage(message.image.id, caption);
        if (analysis) {
            userInputText = analysis;
        } else {
            await sendTextMessage(whatsappId, "I couldn't read that image. Please try sending a clearer photo.");
            return;
        }
    } else {
        // Handle other types like stickers or location if necessary, or ignore
        return;
    }

    const user = await findOrCreateUser(whatsappId);
    const lowerCaseText = userInputText.trim().toLowerCase();

    // --- 2. ONBOARDING & CANCELLATION ---
    const onboardingStates = [
        USER_STATES.NEW_USER,
        USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL,
        USER_STATES.ONBOARDING_AWAIT_OTP,
        USER_STATES.ONBOARDING_AWAIT_CURRENCY
    ];

    if (onboardingStates.includes(user.state)) {
        await handleOnboardingFlow(user, userInputText);
        return; 
    }

    if (CANCEL_KEYWORDS.includes(lowerCaseText)) {
        if (user.state !== USER_STATES.IDLE) {
            await updateUserState(whatsappId, USER_STATES.IDLE, {});
            await sendTextMessage(whatsappId, "Cancelled. 👍");
            await sendMainMenu(whatsappId); 
            return;
        }
    }

    // --- 3. ACTIVE STATE HANDLER ---
    switch (user.state) {
      case USER_STATES.IDLE: 
          await handleIdleState(user, userInputText); 
          break;
      case USER_STATES.LOGGING_SALE: 
          await handleLoggingSale(user, userInputText); 
          break;
      case USER_STATES.LOGGING_EXPENSE: 
          await handleLoggingExpense(user, userInputText); 
          break;
      case USER_STATES.ADDING_PRODUCT: 
          await handleAddingProduct(user, userInputText); 
          break;
      case USER_STATES.LOGGING_CUSTOMER_PAYMENT: 
          await handleLoggingCustomerPayment(user, userInputText); 
          break;
      case USER_STATES.ADDING_BANK_ACCOUNT: 
          await handleAddingBankAccount(user, userInputText); 
          break;
      case USER_STATES.AWAITING_EDIT_VALUE:
          await handleEditValue(user, userInputText);
          break;

      // Handle Interactive States (User typed instead of clicked)
      case USER_STATES.AWAITING_BANK_SELECTION_SALE:
      case USER_STATES.AWAITING_BANK_SELECTION_EXPENSE:
      case USER_STATES.AWAITING_BANK_SELECTION_PURCHASE:
      case USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT:
      case USER_STATES.AWAITING_SALE_TYPE_CONFIRMATION:
      case USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION:
      case USER_STATES.AWAITING_INVOICE_CONFIRMATION:
      case USER_STATES.AWAITING_DELETE_CONFIRMATION:
      case USER_STATES.AWAITING_RECONCILE_ACTION:
      case USER_STATES.AWAITING_EDIT_FIELD_SELECTION:
      case USER_STATES.AWAITING_TRANSACTION_SELECTION:
      case USER_STATES.AWAITING_REPORT_TYPE_SELECTION:
        await sendTextMessage(whatsappId, "Please select an option from the buttons or list I sent above, or type 'cancel' to stop.");
        break;

      default:
        logger.warn(`Unhandled state: ${user.state} for user ${whatsappId}`);
        await sendTextMessage(whatsappId, "I'm a bit lost. Let's go to the main menu.");
        await updateUserState(whatsappId, USER_STATES.IDLE);
        await sendMainMenu(whatsappId);
        break;
    }
  } catch (error) {
    logger.error(`Error in message handler for ${whatsappId}:`, error);
    await sendTextMessage(whatsappId, "Something went wrong. Please try again. 🛠️");
  }
}

// --- STATE HANDLERS ---

async function handleIdleState(user, text) {
    const { intent, context } = await getIntent(text);

    if (intent === INTENTS.GENERAL_CONVERSATION) {
        const aiReply = context.generatedReply || "How can I help you with your bookkeeping today?";
        await sendTextMessage(user.whatsappId, aiReply);
        return;
    }

    if (intent === INTENTS.LOG_SALE) {
        const initialMemory = [{ role: 'user', content: text }];
        const existingProduct = context.productName ? await findProductByName(user._id, context.productName) : null;
        
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { 
            memory: initialMemory, 
            saleData: { items: [], customerName: context.customerName, saleType: context.saleType }, 
            existingProduct 
        });
        await handleLoggingSale({ ...user, stateContext: { memory: initialMemory, saleData: {}, existingProduct } }, text);

    } else if (intent === INTENTS.LOG_EXPENSE) {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: [{ role: 'user', content: text }] });
        await handleLoggingExpense({ ...user, stateContext: { memory: [{ role: 'user', content: text }] } }, text);

    } else if (intent === INTENTS.ADD_PRODUCT) {
        const existingProduct = context.productName ? await findProductByName(user._id, context.productName) : null;
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: [{ role: 'user', content: text }], existingProduct });
        await handleAddingProduct({ ...user, stateContext: { memory: [{ role: 'user', content: text }], existingProduct } }, text);

    } else if (intent === INTENTS.LOG_CUSTOMER_PAYMENT) {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: [{ role: 'user', content: text }] });
        await handleLoggingCustomerPayment({ ...user, stateContext: { memory: [{ role: 'user', content: text }] } }, text);

    } else if (intent === INTENTS.ADD_BANK_ACCOUNT) {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: [{ role: 'user', content: text }] });
        await handleAddingBankAccount({ ...user, stateContext: { memory: [{ role: 'user', content: text }] } }, text);

    } else if (intent === INTENTS.GENERATE_REPORT) {
        if (context.reportType) {
            await sendTextMessage(user.whatsappId, "Adding your report to the queue... ⏳");
            const dateRange = context.dateRange || { startDate: new Date(), endDate: new Date() };
            await queueReportGeneration(user._id, user.currency, context.reportType.toUpperCase(), dateRange, user.whatsappId);
        } else {
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_REPORT_TYPE_SELECTION);
            await sendReportMenu(user.whatsappId);
        }

    } else if (intent === INTENTS.CHECK_STOCK || intent === INTENTS.GET_FINANCIAL_SUMMARY || intent === INTENTS.CHECK_BANK_BALANCE || intent === INTENTS.GET_FINANCIAL_INSIGHT || intent === INTENTS.GET_CUSTOMER_BALANCES) {
        // These intents still rely on the legacy TaskHandler for read-only ops or simple queries
        await executeTask(intent, user, context);

    } else if (intent === INTENTS.SHOW_MAIN_MENU) {
        await sendMainMenu(user.whatsappId);

    } else if (intent === INTENTS.RECONCILE_TRANSACTION) {
        await executeTask(INTENTS.RECONCILE_TRANSACTION, user, {}); // Initiates the list selection flow

    } else {
        await sendTextMessage(user.whatsappId, "I can help with bookkeeping, sales, expenses, and reports. What would you like to do?");
        await sendMainMenu(user.whatsappId);
    }
}

async function handleLoggingSale(user, text) {
    const { memory, existingProduct, saleData } = user.stateContext;
    if (memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });

    const aiResponse = await gatherSaleDetails(memory, existingProduct, saleData?.isService);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { ...user.stateContext, memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const finalData = { ...saleData, ...aiResponse.data };
            // Auto-detect bank requirements
            const banks = await getAllBankAccounts(user._id);
            if (banks.length > 0 && !finalData.linkedBankId && finalData.saleType !== 'credit') {
                 await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_SALE, { transactionData: finalData });
                 const buttons = banks.map(b => ({ id: `select_bank:${b._id}`, title: b.bankName }));
                 buttons.push({ id: `select_bank:none`, title: 'None' });
                 await sendInteractiveButtons(user.whatsappId, 'Received payment into which account?', buttons);
                 return;
            }
            
            const txn = await TransactionManager.logSale(user, finalData);
            await sendTextMessage(user.whatsappId, `✅ Sale logged! Amount: ${user.currency} ${txn.amount.toLocaleString()}`);
            
            // Ask for Invoice
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transaction: txn });
            await sendInteractiveButtons(user.whatsappId, 'Generate Invoice?', [{ id: 'invoice_yes', title: 'Yes' }, { id: 'invoice_no', title: 'No' }]);
            
        } catch (e) {
            await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
        }
    }
}

async function handleLoggingExpense(user, text) {
    const { memory } = user.stateContext;
    if (memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });

    const aiResponse = await gatherExpenseDetails(memory);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const finalData = aiResponse.data;
            const banks = await getAllBankAccounts(user._id);
            if (banks.length > 0) {
                 await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_EXPENSE, { transactionData: finalData });
                 const buttons = banks.map(b => ({ id: `select_bank:${b._id}`, title: b.bankName }));
                 await sendInteractiveButtons(user.whatsappId, 'Paid from which account?', buttons);
                 return;
            }
            await TransactionManager.logExpense(user, finalData);
            await sendTextMessage(user.whatsappId, "✅ Expense logged.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendMainMenu(user.whatsappId);
        } catch (e) {
             await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
        }
    }
}

async function handleAddingProduct(user, text) {
    const { memory, existingProduct } = user.stateContext;
    if (memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });

    const aiResponse = await gatherProductDetails(memory, existingProduct);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: aiResponse.memory, existingProduct });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const productData = aiResponse.data;
            // Check if stock added > 0, if so, ask for bank for cost deduction
            if (parseInt(productData.quantityAdded) > 0) {
                 const banks = await getAllBankAccounts(user._id);
                 if (banks.length > 0) {
                     await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_PURCHASE, { transactionData: productData });
                     const buttons = banks.map(b => ({ id: `select_bank:${b._id}`, title: b.bankName }));
                     buttons.push({ id: `select_bank:none`, title: 'No Bank' });
                     await sendInteractiveButtons(user.whatsappId, 'Paid for stock from which account?', buttons);
                     return;
                 }
            }
            const product = await InventoryManager.addProduct(user, productData);
            await sendTextMessage(user.whatsappId, `✅ Product "${product.productName}" updated. New Qty: ${product.quantity}`);
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendMainMenu(user.whatsappId);
        } catch (e) {
            await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
        }
    }
}

async function handleLoggingCustomerPayment(user, text) {
    const { memory } = user.stateContext;
    if (memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });

    const aiResponse = await gatherPaymentDetails(memory, user.currency);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const paymentData = aiResponse.data;
            const banks = await getAllBankAccounts(user._id);
            if (banks.length > 0) {
                await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT, { transactionData: paymentData });
                const buttons = banks.map(b => ({ id: `select_bank:${b._id}`, title: b.bankName }));
                await sendInteractiveButtons(user.whatsappId, 'Which account received the payment?', buttons);
                return;
            }
            await TransactionManager.logCustomerPayment(user, paymentData);
            await sendTextMessage(user.whatsappId, "✅ Payment recorded.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendMainMenu(user.whatsappId);
        } catch (e) {
            await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
        }
    }
}

async function handleAddingBankAccount(user, text) {
    const { memory } = user.stateContext;
    if (memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });

    const aiResponse = await gatherBankAccountDetails(memory, user.currency);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        const bankData = aiResponse.data;
        const balance = parsePrice(bankData.openingBalance);
        if (isNaN(balance)) {
             await sendTextMessage(user.whatsappId, "Invalid balance amount.");
             return;
        }
        await createBankAccount(user._id, bankData.bankName, balance);
        await sendTextMessage(user.whatsappId, `✅ Bank "${bankData.bankName}" added with balance ${user.currency} ${balance.toLocaleString()}`);
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendMainMenu(user.whatsappId);
    }
}

async function handleEditValue(user, text) {
    const { transaction, fieldToEdit } = user.stateContext;
    // Pass this back to the legacy task handler or a new edit service
    // For now, delegating to the existing task handler logic
    const changes = { [fieldToEdit]: text }; // Simplification, validation needed
    await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId: transaction._id, action: 'edit', changes });
}

// --- ONBOARDING FLOW ---

async function handleOnboardingFlow(user, text) {
    if (user.state === USER_STATES.NEW_USER) {
        await sendTextMessage(user.whatsappId, "Welcome to Fynax Bookkeeper! 📊\nLet's get you set up.\n\nWhat is your **Business Name** and **Email Address**?");
        await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL);
    } else if (user.state === USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL) {
        const { businessName, email } = await extractOnboardingDetails(text);
        if (businessName && email) {
            const otp = await sendOtp(email, businessName);
            await updateUser(user.whatsappId, { businessName, email, otp, otpExpires: new Date(Date.now() + 600000) });
            await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_OTP);
            await sendTextMessage(user.whatsappId, `I've sent a code to ${email}. Please enter it here.`);
        } else {
            await sendTextMessage(user.whatsappId, "I need both your Business Name and Email to proceed. Please try again.");
        }
    } else if (user.state === USER_STATES.ONBOARDING_AWAIT_OTP) {
        if (user.otp === text.trim()) {
            await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_CURRENCY);
            await sendTextMessage(user.whatsappId, "✅ Email verified! What currency do you use? (e.g., Naira, USD)");
        } else {
            await sendTextMessage(user.whatsappId, "Invalid code. Please check your email and try again.");
        }
    } else if (user.state === USER_STATES.ONBOARDING_AWAIT_CURRENCY) {
        const { currency } = await extractCurrency(text);
        if (currency) {
            await updateUser(user.whatsappId, { currency });
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendTextMessage(user.whatsappId, `All set! Your currency is ${currency}.`);
            await sendMainMenu(user.whatsappId);
        } else {
            await sendTextMessage(user.whatsappId, "I didn't recognize that currency. Please try standard codes like 'NGN' or 'USD'.");
        }
    }
}
