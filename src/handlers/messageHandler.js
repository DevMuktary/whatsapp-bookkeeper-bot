import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { getAllBankAccounts } from '../db/bankService.js';
import { 
    extractOnboardingDetails, extractCurrency, getIntent, 
    gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, 
    gatherPaymentDetails, gatherBankAccountDetails,
    transcribeAudio, analyzeImage 
} from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendInteractiveButtons, sendMainMenu, sendReportMenu, setTypingIndicator, uploadMedia, sendDocument } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';
import { generateSalesReport, generateExpenseReport, generateInventoryReport, generatePnLReport } from '../services/pdfService.js';
import { getTransactionsByDateRange } from '../db/transactionService.js';
import { getAllProducts } from '../db/productService.js';
import { getPnLData } from '../services/ReportManager.js';
import logger from '../utils/logger.js';

// Managers
import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { createBankAccount } from '../db/bankService.js';
import { executeTask } from './taskHandler.js';

const CANCEL_KEYWORDS = ['cancel', 'stop', 'exit', 'abort', 'quit'];

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

// List Helper
const parseProductList = (text) => {
    const products = [];
    const lines = text.split('\n');
    const lineRegex = /^\s*\d+\.?\s+(\d+)\s+(.+?)\s*[-:]\s*cost\s*[-:]?\s*([^,]+),?\s*sell\s*[-:]?\s*(.+)/i;
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
            } catch (e) {}
        }
    }
    return products;
};

export async function handleMessage(message) {
  const whatsappId = message.from;
  const messageId = message.id; 
  
  try {
    await setTypingIndicator(whatsappId, 'on', messageId);
    
    // --- 1. SILENT MEDIA PROCESSING ---
    let userInputText = "";
    if (message.type === 'text') userInputText = message.text.body;
    else if (message.type === 'audio') userInputText = await transcribeAudio(message.audio.id) || "";
    else if (message.type === 'image') userInputText = await analyzeImage(message.image.id, message.image.caption) || "";
    else return; // Ignore other types

    if (!userInputText) {
        // Only reply if audio/image failed completely
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

    // --- 4. STATE HANDLING & SMART INTERRUPT ---
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

      // Smart Interrupt: If user sends a command while in a menu, reset and handle it
      default:
        if (user.state.startsWith('AWAITING_')) {
            if (userInputText.length > 2) { 
                // Assume it's a command, not a button click error
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

    } else if (intent === INTENTS.GENERATE_REPORT) {
        if (context.reportType) {
            // [FIXED] Direct call to generation function, no queue
            await generateAndSendReport(user, context.reportType.toUpperCase(), context.dateRange);
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

// --- REPORT GENERATION (Direct & Reliable) ---
async function generateAndSendReport(user, reportType, dateRange) {
    await sendTextMessage(user.whatsappId, "Generating your report... 📄");
    
    const { startDate, endDate } = getDateRange(dateRange || 'this_month');
    let pdfBuffer;
    let filename;

    try {
        if (reportType === 'SALES') {
            const txs = await getTransactionsByDateRange(user._id, 'SALE', startDate, endDate);
            pdfBuffer = await generateSalesReport(user, txs, `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`);
            filename = 'Sales_Report.pdf';
        } else if (reportType === 'EXPENSES') {
            const txs = await getTransactionsByDateRange(user._id, 'EXPENSE', startDate, endDate);
            pdfBuffer = await generateExpenseReport(user, txs, `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`);
            filename = 'Expense_Report.pdf';
        } else if (reportType === 'INVENTORY') {
            const prods = await getAllProducts(user._id);
            pdfBuffer = await generateInventoryReport(user, prods);
            filename = 'Inventory_Report.pdf';
        } else if (reportType === 'PNL' || reportType === 'PROFIT') {
            const pnlData = await getPnLData(user._id, startDate, endDate);
            pdfBuffer = await generatePnLReport(user, pnlData, `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`);
            filename = 'PnL_Report.pdf';
        }

        if (pdfBuffer) {
            const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
            if (mediaId) {
                await sendDocument(user.whatsappId, mediaId, filename, "Here is your report.");
                await sendMainMenu(user.whatsappId);
            } else {
                await sendTextMessage(user.whatsappId, "Failed to upload report.");
            }
        } else {
            await sendTextMessage(user.whatsappId, "No data found for this report.");
        }
    } catch (e) {
        logger.error("Report Gen Error:", e);
        await sendTextMessage(user.whatsappId, "Error generating report.");
    }
}

// --- TRANSACTION HANDLERS ---

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

// ... handleOnboardingFlow (Standard Logic) ...
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
