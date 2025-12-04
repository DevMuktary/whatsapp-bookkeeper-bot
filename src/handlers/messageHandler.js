import { findOrCreateUser, updateUser, updateUserState, createJoinCode, findOwnerByJoinCode, linkStaffToOwner } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { getAllBankAccounts, createBankAccount } from '../db/bankService.js';
import { 
    getIntent, gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, 
    gatherPaymentDetails,
    transcribeAudio, analyzeImage, parseBulkProductList 
} from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { 
    sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, sendReportMenu, 
    setTypingIndicator, uploadMedia, sendDocument, sendOnboardingFlow, sendAddBankFlow 
} from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';
import { queueReportGeneration } from '../services/QueueService.js';
import { parseExcelImport } from '../services/FileImportService.js';
import { generateDataExport } from '../services/exportService.js';
import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { executeTask } from './taskHandler.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const CANCEL_KEYWORDS = ['cancel', 'stop', 'exit', 'abort', 'quit'];
const MAX_MEMORY_DEPTH = 12;

// --- HELPERS ---

const limitMemory = (memory) => {
    if (memory.length > MAX_MEMORY_DEPTH) return memory.slice(-MAX_MEMORY_DEPTH);
    return memory;
};

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

const extractDateRange = (context, defaultPeriod = 'this_month') => {
    let dateInput = defaultPeriod;
    if (context.dateRange) {
        dateInput = context.dateRange;
    } else if (context.startDate && context.endDate) {
        dateInput = { startDate: context.startDate, endDate: context.endDate };
    }
    return getDateRange(dateInput);
};

async function getEffectiveUser(user) {
    if (user.role === 'STAFF' && user.linkedAccountId) {
        return {
            ...user,
            _id: user.linkedAccountId, // Swap ID to Owner's
            originalUserId: user._id,  // Keep track of real user
            staffName: user.businessName || user.whatsappId,
            isStaff: true
        };
    }
    return user;
}

// [EXPORTED] Smart Bank Selector
export async function askForBankSelection(user, transactionData, nextState, promptText) {
    const banks = await getAllBankAccounts(user._id);
    
    const options = banks.map(b => ({ id: `select_bank:${b._id}`, title: b.bankName }));
    options.push({ id: `select_bank:none`, title: 'No Bank / Cash' });

    await updateUserState(user.whatsappId, nextState, { transactionData });

    if (options.length <= 3) {
        await sendInteractiveButtons(user.whatsappId, promptText, options);
    } else {
        const sections = [{
            title: "Select Account",
            rows: options.map(opt => ({ id: opt.id, title: opt.title }))
        }];
        await sendInteractiveList(user.whatsappId, "Payment Method", promptText, "Choose Bank", sections);
    }
}

// [FIXED] FUNCTION DEFINITION FOR handleManageBanks
async function handleManageBanks(user) {
    if (user.isStaff) {
        await sendTextMessage(user.whatsappId, "⛔ Access Denied. Only the Business Owner can manage bank accounts.");
        return;
    }
    
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_MENU_SELECTION);
    
    await sendInteractiveButtons(user.whatsappId, "Manage Bank Accounts 🏦\nWhat would you like to do?", [
        { id: 'bank_action:add', title: 'Add New Bank ➕' },
        { id: 'bank_action:check', title: 'Check Balance 💰' }
    ]);
}

// --- MAIN HANDLER ---

export async function handleMessage(message) {
  const whatsappId = message.from;
  const messageId = message.id; 
  
  try {
    await setTypingIndicator(whatsappId, 'on', messageId);
    
    // 1. MEDIA & INPUT PROCESSING
    let userInputText = "";
    if (message.type === 'text') userInputText = message.text.body;
    else if (message.type === 'audio') userInputText = await transcribeAudio(message.audio.id) || "";
    else if (message.type === 'image') userInputText = await analyzeImage(message.image.id, message.image.caption) || "";
    
    else if (message.type === 'document') {
        const mime = message.document.mime_type;
        const rawUser = await findOrCreateUser(whatsappId);
        const user = await getEffectiveUser(rawUser); 
        
        if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
            await handleDocumentImport(user, message.document);
            return;
        } else {
            await sendTextMessage(whatsappId, "I can only read Excel (.xlsx) or CSV files for inventory.");
            return;
        }
    }
    else return; 

    if (!userInputText) {
        await sendTextMessage(whatsappId, "I couldn't understand that content. Please try again.");
        return;
    }

    const rawUser = await findOrCreateUser(whatsappId);
    const user = await getEffectiveUser(rawUser);
    const lowerCaseText = userInputText.trim().toLowerCase();

    // 2. SYSTEM COMMANDS (JOIN TEAM)
    if (lowerCaseText.startsWith('join ')) {
        const code = lowerCaseText.split(' ')[1]?.toUpperCase();
        if (code) {
            const owner = await findOwnerByJoinCode(code);
            if (owner) {
                await linkStaffToOwner(whatsappId, owner._id);
                await sendTextMessage(whatsappId, `✅ Success! You have joined **${owner.businessName}**. You can now log sales for them.`);
                await sendTextMessage(owner.whatsappId, `🔔 **New Staff:** ${user.businessName || whatsappId} just joined your team.`);
            } else {
                await sendTextMessage(whatsappId, "❌ Invalid invite code.");
            }
        } else {
            await sendTextMessage(whatsappId, "Please type 'Join [Code]', e.g., 'Join X7K9P2'.");
        }
        return;
    }

    // 3. ONBOARDING (FLOWS)
    if (user.state === USER_STATES.NEW_USER && user.role !== 'STAFF') {
        if (CANCEL_KEYWORDS.includes(lowerCaseText)) {
             await sendTextMessage(whatsappId, "Okay, message me whenever you are ready to start!");
             return;
        }
        await sendOnboardingFlow(whatsappId);
        return; 
    }

    if (user.state === USER_STATES.ONBOARDING_AWAIT_OTP) {
        await handleOtpVerification(user, userInputText);
        return;
    }

    // 4. CANCELLATION
    if (CANCEL_KEYWORDS.includes(lowerCaseText)) {
        if (user.state !== USER_STATES.IDLE) {
            await updateUserState(whatsappId, USER_STATES.IDLE, {});
            await sendTextMessage(whatsappId, "Cancelled. 👍");
            await sendMainMenu(whatsappId); 
            return;
        }
    }

    // 5. STATE ROUTING
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
      case USER_STATES.AWAITING_EDIT_VALUE:
          await handleEditValue(user, userInputText);
          break;
      case USER_STATES.AWAITING_BANK_MENU_SELECTION:
          if (lowerCaseText.includes('add')) {
              await sendAddBankFlow(user.whatsappId);
          } else if (lowerCaseText.includes('check') || lowerCaseText.includes('balance')) {
              const banks = await getAllBankAccounts(user._id);
              if (banks.length === 0) {
                  await sendTextMessage(user.whatsappId, "You haven't added any banks yet.");
                  await updateUserState(user.whatsappId, USER_STATES.IDLE);
              } else {
                  const sections = [{
                      title: "Select Bank",
                      rows: banks.map(b => ({ id: `view_balance:${b._id}`, title: b.bankName }))
                  }];
                  await sendInteractiveList(user.whatsappId, "Check Balance", "Select a bank to view its balance.", "Show List", sections);
              }
          } else {
              await sendTextMessage(whatsappId, "Please select an option using the buttons above.");
          }
          break;

      default:
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

// --- SPECIAL HANDLERS (FLOWS, OTP, DOCS) ---

export async function handleFlowResponse(message) {
    const whatsappId = message.from;
    let responseJson = {};
    try {
        responseJson = JSON.parse(message.interactive.nfm_reply.response_json);
        logger.info(`Flow Response from ${whatsappId}:`, JSON.stringify(responseJson));
    } catch (parseError) {
        logger.error("Failed to parse flow response JSON", parseError);
        return;
    }

    let screen = responseJson.screen;
    if (!screen) {
        if (responseJson.business_name && responseJson.email) screen = 'SIGN_UP_SCREEN';
        else if (responseJson.bank_name) screen = 'ADD_BANK_SCREEN';
    }

    try {
        const rawUser = await findOrCreateUser(whatsappId);
        const user = await getEffectiveUser(rawUser);

        if (screen === 'SIGN_UP_SCREEN') {
            const { business_name, email, currency } = responseJson;
            await sendTextMessage(whatsappId, "Creating your account... 🔄");
            await updateUser(whatsappId, { businessName: business_name, email, currency: currency || 'NGN', isEmailVerified: false });
            const otp = await sendOtp(email, business_name);
            await updateUser(whatsappId, { otp, otpExpires: new Date(Date.now() + 600000) });
            await updateUserState(whatsappId, USER_STATES.ONBOARDING_AWAIT_OTP);
            await sendTextMessage(whatsappId, `✅ Account created for **${business_name}**!\n\nI sent a verification code to ${email}. Please enter it below.`);
        } else if (screen === 'ADD_BANK_SCREEN') {
            const { bank_name, opening_balance } = responseJson;
            const balance = parsePrice(opening_balance);
            if (isNaN(balance)) {
                await sendTextMessage(whatsappId, "Invalid balance provided. Please try again.");
                return;
            }
            if (user.isStaff) {
                await sendTextMessage(whatsappId, "⛔ Staff cannot add bank accounts.");
                return;
            }
            await createBankAccount(user._id, bank_name, balance);
            await sendTextMessage(whatsappId, `✅ Bank Account **${bank_name}** added with balance ${user.currency || 'NGN'} ${balance.toLocaleString()}.`);
            await updateUserState(whatsappId, USER_STATES.IDLE);
            await sendMainMenu(whatsappId);
        } else {
            await sendTextMessage(whatsappId, "I received your data, but I'm not sure which form it belongs to.");
        }
    } catch (error) {
        logger.error("Flow Error:", error);
        await sendTextMessage(whatsappId, "Error processing your request. Please try again.");
    }
}

async function handleOtpVerification(user, text) {
    const inputOtp = text.trim();
    if (user.otp === inputOtp) {
        await updateUser(user.whatsappId, { isEmailVerified: true }); 
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendTextMessage(user.whatsappId, "✅ Email verified! Your account is ready.");
        await sendMainMenu(user.whatsappId);
    } else {
        await sendTextMessage(user.whatsappId, "❌ Invalid code. Please check your email and try again.");
    }
}

async function handleDocumentImport(user, document) {
    await sendTextMessage(user.whatsappId, "Receiving your file... 📂");
    try {
        const { products, errors } = await parseExcelImport(document.id);
        if (products.length === 0) {
            await sendTextMessage(user.whatsappId, "I couldn't find any valid products in that file. Check the columns: Name, Qty, Cost, Sell.");
            return;
        }
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

// --- IDLE STATE LOGIC (INTENT ROUTING) ---

async function handleIdleState(user, text) {
    const { intent, context } = await getIntent(text);

    if (user.isStaff) {
        const RESTRICTED = [INTENTS.RECONCILE_TRANSACTION, INTENTS.ADD_BANK_ACCOUNT, 'EXPORT_DATA'];
        if (RESTRICTED.includes(intent) || (intent === 'EXPORT_DATA')) {
            await sendTextMessage(user.whatsappId, "⛔ Access Denied. Only the Business Owner can do that.");
            return;
        }
        if (intent === INTENTS.GENERATE_REPORT && (context.reportType === 'PNL' || context.reportType === 'PROFIT')) {
            await sendTextMessage(user.whatsappId, "⛔ Access Denied. Staff cannot view Profit & Loss.");
            return;
        }
    }

    if (intent === 'MANAGE_TEAM') {
        if (user.role === 'STAFF') {
            await sendTextMessage(user.whatsappId, "⛔ Only the Business Owner can invite staff.");
            return;
        }
        const code = await createJoinCode(user._id);
        await sendTextMessage(user.whatsappId, `👥 **Team Invite**\n\nShare this code with your staff:\n\n**${code}**\n\nAsk them to send the message: *"Join ${code}"* to this bot.`);
        return;
    }

    if (intent === 'EXPORT_DATA') {
        await sendTextMessage(user.whatsappId, "Gathering your records... 📊\nThis may take a few seconds.");
        const { startDate, endDate } = extractDateRange(context, 'this_year');
        try {
            const excelBuffer = await generateDataExport(user._id, startDate, endDate);
            const mediaId = await uploadMedia(excelBuffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            if (mediaId) {
                const filename = `Fynax_Data_${new Date().toISOString().split('T')[0]}.xlsx`;
                await sendDocument(user.whatsappId, mediaId, filename, "Here is your data export. 📁");
            } else {
                await sendTextMessage(user.whatsappId, "Failed to upload file.");
            }
        } catch (e) {
            logger.error("Export failed", e);
            await sendTextMessage(user.whatsappId, "Sorry, I couldn't generate the export file.");
        }
        return;
    }

    if (intent === INTENTS.ADD_BANK_ACCOUNT || intent === INTENTS.CHECK_BANK_BALANCE || text.toLowerCase().includes('manage bank')) {
        await handleManageBanks(user);
        return;
    }

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

    } else if (intent === INTENTS.ADD_PRODUCTS_FROM_LIST || intent === INTENTS.ADD_MULTIPLE_PRODUCTS) {
        await sendTextMessage(user.whatsappId, "To add many products at once, the fastest way is to **send me an Excel file**! 📁\n\nEnsure it has columns: *Name, Qty, Cost, Sell*.\n\nOr, you can just paste the list here.");
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
            const { startDate, endDate } = extractDateRange(context, 'this_month');
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

async function handleLoggingSale(user, text) {
    let { memory, existingProduct, saleData } = user.stateContext;
    if (memory.length === 0 || memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });
    memory = limitMemory(memory);
    const aiResponse = await gatherSaleDetails(memory, existingProduct, saleData?.isService);
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { ...user.stateContext, memory: limitMemory(aiResponse.memory) });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const finalData = { ...saleData, ...aiResponse.data };
            if (user.isStaff) finalData.loggedBy = user.staffName;
            const banks = await getAllBankAccounts(user._id);
            if (banks.length > 0 && !finalData.linkedBankId && finalData.saleType !== 'credit') {
                 await askForBankSelection(user, finalData, USER_STATES.AWAITING_BANK_SELECTION_SALE, 'Received payment into which account?');
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
    if (memory.length === 0 || memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });
    memory = limitMemory(memory);
    const aiResponse = await gatherExpenseDetails(memory);
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: limitMemory(aiResponse.memory) });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else {
        try {
            const expenses = aiResponse.data.expenses || [aiResponse.data];
            
            if (user.isStaff) {
                expenses.forEach(e => e.loggedBy = user.staffName);
            }

            const banks = await getAllBankAccounts(user._id);
            if (banks.length > 0) {
                 await askForBankSelection(user, { expenses }, USER_STATES.AWAITING_BANK_SELECTION_EXPENSE, 'Paid from which account?');
                 return;
            }
            
            for (const exp of expenses) {
                await TransactionManager.logExpense(user, exp);
            }
            await sendTextMessage(user.whatsappId, `✅ ${expenses.length} expense(s) logged.`);
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendMainMenu(user.whatsappId);
        } catch (e) {
             await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
        }
    }
}

async function handleAddingProduct(user, text) {
    let { memory, existingProduct } = user.stateContext;
    if (memory.length === 0 || memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });
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
                     await askForBankSelection(user, productData, USER_STATES.AWAITING_BANK_SELECTION_PURCHASE, 'Paid for stock from which account?');
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
    if (memory.length === 0 || memory[memory.length - 1].content !== text) memory.push({ role: 'user', content: text });
    memory = limitMemory(memory);
    const aiResponse = await gatherPaymentDetails(memory, user.currency);
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: limitMemory(aiResponse.memory) });
        await sendTextMessage(user.whatsappId, aiResponse.reply || "Could you provide the payment details?");
    } else {
        try {
            const paymentData = aiResponse.data;
            if (user.isStaff) paymentData.loggedBy = user.staffName;
            const banks = await getAllBankAccounts(user._id);
            if (banks.length > 0) {
                await askForBankSelection(user, paymentData, USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT, 'Which account received the payment?');
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

async function handleEditValue(user, text) {
    const { transaction, fieldToEdit } = user.stateContext;
    const changes = { [fieldToEdit]: text };
    await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId: transaction._id, action: 'edit', changes });
}
