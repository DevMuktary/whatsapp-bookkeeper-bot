import { updateUserState } from '../db/userService.js';
import { getAllBankAccounts } from '../db/bankService.js';
import { sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, sendAddBankFlow } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import { gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, gatherPaymentDetails } from '../ai/prompts.js';

import { parseExcelImport } from '../services/FileImportService.js';
import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { findProductByName, findProductFuzzy } from '../db/productService.js'; // [NEW]
import { executeTask } from './taskHandler.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

// Helper to limit memory for AI context
const limitMemory = (memory, maxDepth = 12) => {
    if (memory.length > maxDepth) return memory.slice(-maxDepth);
    return memory;
};

// --- SHARED HELPERS ---

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
    if (user.role === 'STAFF') { 
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

// --- SMART SALE PROCESSING ---

// This function checks items one by one for ambiguity or missing inventory
export async function processSaleItems(user, saleData, startIndex = 0) {
    const items = saleData.items;

    for (let i = startIndex; i < items.length; i++) {
        const item = items[i];

        // 1. Skip if already marked as service or resolved
        if (item.isService || item.productId) continue;

        // 2. Exact Match Check
        const exactProduct = await findProductByName(user._id, item.productName);
        if (exactProduct) {
            item.productId = exactProduct._id;
            item.productName = exactProduct.productName; // Normalize name casing
            continue; // Move to next item
        }

        // 3. Fuzzy Match Check ("Did you mean X?")
        const fuzzyMatches = await findProductFuzzy(user._id, item.productName);
        if (fuzzyMatches.length > 0) {
            // STOP! Ask User.
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_PRODUCT_CONFIRMATION, {
                saleData,
                currentItemIndex: i,
                potentialMatches: fuzzyMatches
            });

            // Create buttons for top 3 matches
            const buttons = fuzzyMatches.slice(0, 3).map(p => ({
                id: `confirm_prod:${p._id}`,
                title: p.productName.substring(0, 20) // Button title limit
            }));
            buttons.push({ id: 'confirm_prod:none', title: 'None of these' });

            await sendInteractiveButtons(user.whatsappId, 
                `🤔 I couldn't find exactly "${item.productName}". Did you mean one of these?`, 
                buttons
            );
            return; // Exit loop, wait for user
        }

        // 4. No Match - Ask "Product or Service?"
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_ITEM_TYPE_CONFIRMATION, {
            saleData,
            currentItemIndex: i
        });
        
        await sendInteractiveButtons(user.whatsappId, 
            `❓ I don't see "${item.productName}" in your inventory.\n\nIs this a **Service** (like labor/design) or a **Product**?`,
            [
                { id: 'type_choice:service', title: 'It is a Service 🛠️' },
                { id: 'type_choice:product', title: 'It is a Product 📦' }
            ]
        );
        return; // Exit loop, wait for user
    }

    // --- ALL ITEMS CHECKED & RESOLVED ---
    
    // Check if staff, add name
    if (user.isStaff) saleData.loggedBy = user.staffName;

    const banks = await getAllBankAccounts(user._id);
    if (banks.length > 0 && !saleData.linkedBankId && saleData.saleType !== 'credit') {
         await askForBankSelection(user, saleData, USER_STATES.AWAITING_BANK_SELECTION_SALE, 'Received payment into which account?');
         return;
    }

    try {
        const txn = await TransactionManager.logSale(user, saleData);
        await sendTextMessage(user.whatsappId, `✅ Sale logged! Amount: ${user.currency} ${txn.amount.toLocaleString()}`);
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transaction: txn });
        await sendInteractiveButtons(user.whatsappId, 'Generate Invoice?', [{ id: 'invoice_yes', title: 'Yes' }, { id: 'invoice_no', title: 'No' }]);
    } catch (e) {
        await sendTextMessage(user.whatsappId, `Error: ${e.message}`);
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
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
        // [FIX] Instead of logging immediately, start the checking process
        const finalData = { ...saleData, ...aiResponse.data };
        await processSaleItems(user, finalData);
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
