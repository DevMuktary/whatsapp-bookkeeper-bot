import { findOrCreateUser, updateUserState, createJoinCode, findOwnerByJoinCode, linkStaffToOwner } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { getAllBankAccounts } from '../db/bankService.js';
// [UPDATED IMPORTS]
import { getIntent, parseBulkProductList } from '../ai/prompts.js';
import { transcribeAudio, analyzeImage } from '../ai/media.js';

import { 
    sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, sendReportMenu, 
    setTypingIndicator, uploadMedia, sendDocument, sendOnboardingFlow, sendAddBankFlow 
} from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';
import { queueReportGeneration } from '../services/QueueService.js';
import { generateDataExport } from '../services/exportService.js';
import { executeTask } from './taskHandler.js';
import logger from '../utils/logger.js';

// [IMPORTED HANDLERS]
import { handleFlowResponse, handleOtpVerification } from './flowHandler.js';
import { 
    handleLoggingSale, handleLoggingExpense, handleAddingProduct, handleLoggingCustomerPayment, 
    handleEditValue, handleDocumentImport, handleManageBanks 
} from './actionHandler.js';

const CANCEL_KEYWORDS = ['cancel', 'stop', 'exit', 'abort', 'quit'];

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
            _id: user.linkedAccountId, 
            originalUserId: user._id, 
            staffName: user.businessName || user.whatsappId,
            isStaff: true
        };
    }
    return user;
}

// --- EXPORTED HANDLERS FOR WEBHOOK ---

export { handleFlowResponse }; // Re-export for webhook

export async function handleMessage(message) {
  const whatsappId = message.from;
  const messageId = message.id; 
  
  try {
    await setTypingIndicator(whatsappId, 'on', messageId);
    
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

    // 1. SYSTEM COMMANDS
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

    // 2. ONBOARDING
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

    // 3. CANCELLATION
    if (CANCEL_KEYWORDS.includes(lowerCaseText)) {
        if (user.state !== USER_STATES.IDLE) {
            await updateUserState(whatsappId, USER_STATES.IDLE, {});
            await sendTextMessage(whatsappId, "Cancelled. 👍");
            await sendMainMenu(whatsappId); 
            return;
        }
    }

    // 4. STATE ROUTING
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
          // Handles text response if user types instead of clicking buttons
          if (lowerCaseText.includes('add')) {
              await sendAddBankFlow(user.whatsappId);
          } else if (lowerCaseText.includes('check') || lowerCaseText.includes('balance')) {
              // Re-trigger check logic locally or via generic handler
              const banks = await getAllBankAccounts(user._id);
              if (banks.length > 0) {
                 const sections = [{
                      title: "Select Bank",
                      rows: banks.map(b => ({ id: `view_balance:${b._id}`, title: b.bankName }))
                  }];
                  await sendInteractiveList(user.whatsappId, "Check Balance", "Select a bank to view its balance.", "Show List", sections);
              } else {
                  await sendTextMessage(user.whatsappId, "No banks found.");
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

    // State Transitions
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
