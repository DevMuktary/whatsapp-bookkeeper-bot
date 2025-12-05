import { updateUserState } from '../db/userService.js';
import { getAllBankAccounts } from '../db/bankService.js';
import { sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, sendAddBankFlow } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
// [UPDATED IMPORTS]
import { gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, gatherPaymentDetails } from '../ai/prompts.js';

import { parseExcelImport } from '../services/FileImportService.js';
import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { executeTask } from './taskHandler.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

// Helper to limit memory for AI context
const limitMemory = (memory, maxDepth = 12) => {
    if (memory.length > maxDepth) return memory.slice(-maxDepth);
    return memory;
};

// --- SHARED HELPERS (Exported for Interactive Handler) ---

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

export async function handleManageBanks(user) {
    if (user.role === 'STAFF') { // Use role check directly
        await sendTextMessage(user.whatsappId, "⛔ Access Denied. Only the Business Owner can manage bank accounts.");
        return;
    }
    
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_MENU_SELECTION);
    
    await sendInteractiveButtons(user.whatsappId, "Manage Bank Accounts 🏦\nWhat would you like to do?", [
        { id: 'bank_action:add', title: 'Add New Bank ➕' },
        { id: 'bank_action:check', title: 'Check Balance 💰' }
    ]);
}

export async function handleDocumentImport(user, document) {
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

// --- TRANSACTION HANDLERS ---

export async function handleLoggingSale(user, text) {
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
            // Ask for Invoice
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transaction: txn });
            await sendInteractiveButtons(user.whatsappId, 'Generate Invoice?', [{ id: 'invoice_yes', title: 'Yes' }, { id: 'invoice_no', title: 'No' }]);
        } catch (e) {
            await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
        }
    }
}

export async function handleLoggingExpense(user, text) {
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

export async function handleAddingProduct(user, text) {
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

export async function handleLoggingCustomerPayment(user, text) {
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

export async function handleEditValue(user, text) {
    const { transaction, fieldToEdit } = user.stateContext;
    const changes = { [fieldToEdit]: text };
    await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId: transaction._id, action: 'edit', changes });
}
