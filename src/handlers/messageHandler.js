import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { getAllBankAccounts } from '../db/bankService.js';
import { 
    extractOnboardingDetails, extractCurrency, getIntent, 
    gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, 
    gatherPaymentDetails, gatherBankAccountDetails,
    transcribeAudio, analyzeImage, parseBulkProductList 
} from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendInteractiveButtons, sendMainMenu, sendReportMenu, setTypingIndicator, uploadMedia, sendDocument } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';

// [NEW] Imports for Queue and File Import
import { queueReportGeneration } from '../services/QueueService.js';
import { parseExcelImport } from '../services/FileImportService.js';

// Managers
import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { createBankAccount } from '../db/bankService.js';
import { executeTask } from './taskHandler.js';
import logger from '../utils/logger.js';

const CANCEL_KEYWORDS = ['cancel', 'stop', 'exit', 'abort', 'quit'];
const MAX_MEMORY_DEPTH = 12; // Keep last 12 messages to save costs & prevent crashes

// Helper to keep memory size in check
const limitMemory = (memory) => {
    if (memory.length > MAX_MEMORY_DEPTH) {
        return memory.slice(-MAX_MEMORY_DEPTH);
    }
    return memory;
};

// Price Helper
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
    
    // --- 1. MEDIA & INPUT PROCESSING ---
    let userInputText = "";
    if (message.type === 'text') userInputText = message.text.body;
    else if (message.type === 'audio') userInputText = await transcribeAudio(message.audio.id) || "";
    else if (message.type === 'image') userInputText = await analyzeImage(message.image.id, message.image.caption) || "";
    
    // [NEW] HANDLE DOCUMENT UPLOAD IMMEDIATELY
    else if (message.type === 'document') {
        const mime = message.document.mime_type;
        const user = await findOrCreateUser(whatsappId); // Need user for state update
        
        if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
            await handleDocumentImport(user, message.document);
            return;
        } else {
            await sendTextMessage(whatsappId, "I can only read Excel (.xlsx) or CSV files for inventory.");
            return;
        }
    }
    else return; // Ignore other types

    if (!userInputText) {
        await sendTextMessage(whatsappId, "I couldn't understand that content. Please try again.");
        return;
    }

    const user = await findOrCreateUser(whatsappId);
    const lowerCaseText = userInputText.trim().toLowerCase();

    // --- 2. ONBOARDING ---
    if ([USER_STATES.NEW_USER, USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL, USER_STATES.ONBOARDING_AWAIT_OTP, USER_STATES.ONBOARDING_AWAIT_CURRENCY].includes(user.state)) {
        await handleOnboardingFlow(user, userInputText);
        return; 
    }

    // --- 3. CANCELLATION ---
    if (CANCEL_KEYWORDS.includes(lowerCaseText)) {
        if (user.state !== USER_STATES.IDLE) {
            await updateUserState(whatsappId, USER_STATES.IDLE, {});
            await sendTextMessage(whatsappId, "Cancelled. 👍");
            await sendMainMenu(whatsappId); 
            return;
        }
    }

    // --- 4. STATE HANDLING ---
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

      default:
        // Smart Interrupt: If user sends a command while in a menu
        if (user.state.startsWith('AWAITING_')) {
            if (userInputText.length > 2) { 
                await updateUserState(whatsappId, USER_STATES.IDLE);
                await handleIdleState(user, userInputText);
            } else {
                await sendTextMessage(whatsappId, "Please select an option from the menu.");
            }
        } else {
            await updateUserState(whatsappId, USER_STATES.IDLE);
            await sendMainMenu(whatsappId);
        }
        break;
    }
  } catch (error) {
    logger.error(`Error in message handler for ${whatsappId}:`, error);
    await sendTextMessage(whatsappId, `Something went wrong: ${error.message}.`);
  }
}

// --- STATE LOGIC ---

async function handleIdleState(user, text) {
    const { intent, context } = await getIntent(text);

    if (intent === INTENTS.GENERAL_CONVERSATION) {
        await sendTextMessage(user.whatsappId, context.generatedReply || "How can I help?");
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

    } else if (intent === INTENTS.ADD_PRODUCTS_FROM_LIST || intent === INTENTS.ADD_MULTIPLE_PRODUCTS) {
        // [UX] Suggest File Upload
        await sendTextMessage(user.whatsappId, "To add many products at once, the fastest way is to **send me an Excel file**! 📁\n\nEnsure it has columns: *Name, Qty, Cost, Sell*.\n\nOr, you can just paste the list here (e.g. '10 Rice 2000').");
        
        // If they actually sent text (not just "I want to add bulk"), try to parse it anyway
        if (text.length > 20) { 
             const products = await parseBulkProductList(text);
             if (products.length > 0) {
                 await updateUserState(user.whatsappId, USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION, { products });
                 const preview = products.slice(0, 5).map(p => `• ${p.quantityAdded}x ${p.productName}`).join('\n');
                 await sendInteractiveButtons(user.whatsappId, `I found ${products.length} items from your text.\n${preview}\n...`, [
                    { id: 'confirm_bulk_add', title: 'Add Text Items' },
                    { id: 'cancel', title: 'Cancel' }
                 ]);
             }
        }

    } else if (intent === INTENTS.GENERATE_REPORT) {
        if (context.reportType) {
            await sendTextMessage(user.whatsappId, "I've added your report to the queue. You'll receive it shortly! ⏳");
            const { startDate, endDate } = getDateRange(context.dateRange || 'this_month');
            
            // [SCALING] Use Queue
            await queueReportGeneration(
                user._id, 
                user.currency, 
                context.reportType.toUpperCase(), 
                { startDate, endDate }, 
                user.whatsappId
            );
            await sendMainMenu(user.whatsappId);
        } else {
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_REPORT_TYPE_SELECTION);
            await sendReportMenu(user.whatsappId);
        }

    } else if (intent === INTENTS.SHOW_MAIN_MENU) {
        await sendMainMenu(user.whatsappId);

    } else {
        await executeTask(intent, user, context);
    }
}

// --- BULK IMPORT HANDLER ---

async function handleDocumentImport(user, document) {
    await sendTextMessage(user.whatsappId, "Receiving your file... 📂");
    try {
        const { products, errors } = await parseExcelImport(document.id);
        
        if (products.length === 0) {
            await sendTextMessage(user.whatsappId, "I couldn't find any valid products in that file. Check the columns: Name, Qty, Cost, Sell.");
            return;
        }

        // Save to state and ask for confirmation
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION, { products });
        
        const preview = products.slice(0, 5).map(p => `• ${p.quantityAdded}x ${p.productName}`).join('\n');
        const errorMsg = errors.length > 0 ? `\n⚠️ ${errors.length} rows skipped (missing info).` : "";
        
        await sendInteractiveButtons(user.whatsappId, `I read ${products.length} products from the file!${errorMsg}\n\nTop 5:\n${preview}`, [
            { id: 'confirm_bulk_add', title: '✅ Import All' },
            { id: 'cancel', title: '❌ Cancel' }
        ]);

    } catch (e) {
        await sendTextMessage(user.whatsappId, `Error reading file: ${e.message}`);
    }
}

// --- TRANSACTION HANDLERS (With Memory Limits) ---

async function handleLoggingSale(user, text) {
    let { memory, existingProduct, saleData } = user.stateContext;
    if (memory.length === 0 || memory[memory.length - 1].content !== text) {
        memory.push({ role: 'user', content: text });
    }
    
    // [OPTIMIZATION] Limit memory size
    memory = limitMemory(memory);

    const aiResponse = await gatherSaleDetails(memory, existingProduct, saleData?.isService);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { ...user.stateContext, memory: limitMemory(aiResponse.memory) });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const finalData = { ...saleData, ...aiResponse.data };
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
            
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transaction: txn });
            await sendInteractiveButtons(user.whatsappId, 'Generate Invoice?', [{ id: 'invoice_yes', title: 'Yes' }, { id: 'invoice_no', title: 'No' }]);
        } catch (e) {
            await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
        }
    }
}

async function handleLoggingExpense(user, text) {
    let { memory } = user.stateContext;
    if (memory.length === 0 || memory[memory.length - 1].content !== text) {
        memory.push({ role: 'user', content: text });
    }
    memory = limitMemory(memory);

    const aiResponse = await gatherExpenseDetails(memory);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: limitMemory(aiResponse.memory) });
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
    let { memory, existingProduct } = user.stateContext;
    if (memory.length === 0 || memory[memory.length - 1].content !== text) {
        memory.push({ role: 'user', content: text });
    }
    memory = limitMemory(memory);

    const aiResponse = await gatherProductDetails(memory, existingProduct);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: limitMemory(aiResponse.memory), existingProduct });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const productData = aiResponse.data;
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
    let { memory } = user.stateContext;
    if (memory.length === 0 || memory[memory.length - 1].content !== text) {
        memory.push({ role: 'user', content: text });
    }
    memory = limitMemory(memory);

    const aiResponse = await gatherPaymentDetails(memory, user.currency);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: limitMemory(aiResponse.memory) });
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
    let { memory } = user.stateContext;
    if (memory.length === 0 || memory[memory.length - 1].content !== text) {
        memory.push({ role: 'user', content: text });
    }
    memory = limitMemory(memory);

    const aiResponse = await gatherBankAccountDetails(memory, user.currency);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: limitMemory(aiResponse.memory) });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        const bankData = aiResponse.data;
        const balance = parsePrice(bankData.openingBalance);
        if (isNaN(balance)) {
             await sendTextMessage(user.whatsappId, "Invalid balance amount.");
             return;
        }
        await createBankAccount(user._id, bankData.bankName, balance);
        await sendTextMessage(user.whatsappId, `✅ Bank "${bankData.bankName}" added.`);
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendMainMenu(user.whatsappId);
    }
}

async function handleEditValue(user, text) {
    const { transaction, fieldToEdit } = user.stateContext;
    const changes = { [fieldToEdit]: text };
    await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId: transaction._id, action: 'edit', changes });
}

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
            await sendTextMessage(user.whatsappId, "I need both your Business Name and Email. Please try again.");
        }
    } else if (user.state === USER_STATES.ONBOARDING_AWAIT_OTP) {
        if (user.otp === text.trim()) {
            await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_CURRENCY);
            await sendTextMessage(user.whatsappId, "✅ Email verified! What currency do you use? (e.g., Naira, USD)");
        } else {
            await sendTextMessage(user.whatsappId, "Invalid code.");
        }
    } else if (user.state === USER_STATES.ONBOARDING_AWAIT_CURRENCY) {
        const { currency } = await extractCurrency(text);
        if (currency) {
            await updateUser(user.whatsappId, { currency });
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendTextMessage(user.whatsappId, `All set! Currency: ${currency}.`);
            await sendMainMenu(user.whatsappId);
        } else {
            await sendTextMessage(user.whatsappId, "Unknown currency.");
        }
    }
}
