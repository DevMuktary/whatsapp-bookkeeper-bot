import { findOrCreateUser, updateUserState } from '../db/userService.js';
import { findTransactionById } from '../db/transactionService.js';
import { findCustomerById } from '../db/customerService.js';
import { generateInvoice } from '../services/pdfService.js';
import { uploadMedia, sendDocument, sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, setTypingIndicator, sendAddBankFlow, sendReportMenu } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { handleMessage } from './messageHandler.js';
import { askForBankSelection, processSaleItems, handleLoggingSale, handleLoggingExpense, handleAddingProduct } from './actionHandler.js'; 
import { getAllBankAccounts } from '../db/bankService.js'; 
import { createDedicatedAccount, initializePayment } from '../services/paymentService.js'; 
import { ObjectId } from 'mongodb';
import config from '../config/index.js';

import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { executeTask } from './taskHandler.js'; 

import { getDateRange } from '../utils/dateUtils.js';
import { queueReportGeneration } from '../services/QueueService.js';

export async function handleInteractiveMessage(message) {
    const whatsappId = message.from;
    const messageId = message.id;
    const interactive = message.interactive;
    
    await setTypingIndicator(whatsappId, 'on', messageId);

    const user = await findOrCreateUser(whatsappId);

    try {
        if (interactive.type === 'button_reply') {
            await handleButtonReply(user, interactive.button_reply.id, message);
        } else if (interactive.type === 'list_reply') {
            await handleListReply(user, interactive.list_reply.id, message);
        }
    } catch (error) {
        logger.error(`Error in interactive handler for ${whatsappId}:`, error);
        await sendTextMessage(whatsappId, `Something went wrong: ${error.message}`);
    }
}

async function handleButtonReply(user, buttonId, originalMessage) {
    // [NEW] Handle the Help Menu Actions
    if (buttonId.startsWith('help_action:')) {
        const action = buttonId.split(':')[1];
        if (action === 'usage') {
            await sendTextMessage(user.whatsappId, `📖 *Product Usage & Guides*\n\nJoin our WhatsApp Channel for tutorials, tips, and updates:\n${config.support.channelLink}`);
        } else if (action === 'contact') {
            await sendTextMessage(user.whatsappId, `💬 *Contact Sales & Support*\n\nYou can chat with our representative directly by clicking the link below or saving the number:\n\nwa.me/${config.support.salesPhone.replace('+', '')}\nPhone: ${config.support.salesPhone}`);
        }
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendMainMenu(user.whatsappId);
        return;
    }

    // [NEW] Handle Explicit Payment Method Selection
    if (buttonId.startsWith('payment_method_sel:')) {
        const type = buttonId.split(':')[1];
        const { saleData } = user.stateContext;
        saleData.saleType = type;
        
        // Resume the sale flow now that we have the payment method
        await processSaleItems(user, saleData);
        return;
    }

    if (buttonId.startsWith('payment_method:')) {
        const type = buttonId.split(':')[1];
        if (type === 'ngn') {
            await sendTextMessage(user.whatsappId, "Generating your dedicated account number... ⏳");
            try {
                const account = await createDedicatedAccount(user);
                await sendTextMessage(user.whatsappId, 
                    `🏦 *Bank Transfer Details*\n\nPlease transfer *₦7,500* to:\n\nBank: *${account.bankName}*\nAccount: *${account.accountNumber}*\nName: *${account.accountName}*\n\nOnce you transfer, your subscription will activate automatically within minutes!`
                );
            } catch (e) {
                await sendTextMessage(user.whatsappId, "Error creating account. Please try again later.");
            }
        } else if (type === 'usd') {
            await sendTextMessage(user.whatsappId, "Generating secure payment link... ⏳");
            try {
                const link = await initializePayment(user, 'USD');
                await sendTextMessage(user.whatsappId, `🌍 *Pay securely via Card*\n\nClick here to pay $5.00: ${link}`);
            } catch (e) {
                await sendTextMessage(user.whatsappId, "Error creating link.");
            }
        }
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        return;
    }

    switch (user.state) {
        case USER_STATES.AWAITING_BANK_MENU_SELECTION:
            if (buttonId === 'bank_action:add') {
                if (user.role === 'STAFF') {
                    await sendTextMessage(user.whatsappId, "⛔ Staff cannot add bank accounts.");
                    await updateUserState(user.whatsappId, USER_STATES.IDLE);
                } else {
                    await sendAddBankFlow(user.whatsappId);
                }
            } else if (buttonId === 'bank_action:check') {
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
            }
            break;

        case USER_STATES.AWAITING_PRODUCT_CONFIRMATION:
            const { saleData, currentItemIndex, potentialMatches } = user.stateContext;
            const [action, prodId] = buttonId.split(':');

            if (action === 'confirm_prod') {
                if (prodId === 'none') {
                    await updateUserState(user.whatsappId, USER_STATES.AWAITING_ITEM_TYPE_CONFIRMATION, { saleData, currentItemIndex });
                    await sendInteractiveButtons(user.whatsappId, 
                        `Okay. Since I don't know this item, is this a **Service** or a **Product**?`,
                        [
                            { id: 'type_choice:service', title: 'Service 🛠️' },
                            { id: 'type_choice:product', title: 'Product 📦' }
                        ]
                    );
                } else {
                    const matched = potentialMatches.find(p => p._id === prodId);
                    if (matched) {
                        saleData.items[currentItemIndex].productId = matched._id;
                        saleData.items[currentItemIndex].productName = matched.productName;
                        await sendTextMessage(user.whatsappId, `Got it! Using "${matched.productName}".`);
                        await processSaleItems(user, saleData, currentItemIndex + 1);
                    }
                }
            }
            break;

        case USER_STATES.AWAITING_ITEM_TYPE_CONFIRMATION:
            const ctx = user.stateContext;
            const [tAction, typeChoice] = buttonId.split(':');

            if (tAction === 'type_choice') {
                if (typeChoice === 'service') {
                    ctx.saleData.items[ctx.currentItemIndex].isService = true;
                    await sendTextMessage(user.whatsappId, "Noted as a Service.");
                    await processSaleItems(user, ctx.saleData, ctx.currentItemIndex + 1);
                } else {
                    const itemName = ctx.saleData.items[ctx.currentItemIndex].productName;
                    await sendTextMessage(user.whatsappId, 
                        `⛔ **Unlisted Product**\n\nYou are trying to sell "${itemName}", but it is not in your inventory.\n\nPlease add it first by typing:\n*"Restock ${itemName}..."*`
                    );
                    await updateUserState(user.whatsappId, USER_STATES.IDLE);
                }
            }
            break;

        case USER_STATES.IDLE:
            await handleMessage({
                from: originalMessage.from,
                id: originalMessage.id,
                text: { body: buttonId },
                type: 'text'
            });
            break;

        case USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION:
            await handleBulkProductConfirmation(user, buttonId);
            break;
        case USER_STATES.AWAITING_INVOICE_CONFIRMATION:
            await handleInvoiceConfirmation(user, buttonId);
            break;
        case USER_STATES.AWAITING_BANK_SELECTION_SALE:
            await handleBankSelection(user, buttonId, INTENTS.LOG_SALE);
            break;
        case USER_STATES.AWAITING_BANK_SELECTION_EXPENSE:
            await handleBankSelection(user, buttonId, INTENTS.LOG_EXPENSE);
            break;
        case USER_STATES.AWAITING_BANK_SELECTION_PURCHASE:
             await handleBankSelection(user, buttonId, INTENTS.ADD_PRODUCT);
             break;
        case USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT:
            await handleBankSelection(user, buttonId, INTENTS.LOG_CUSTOMER_PAYMENT);
            break;
        case USER_STATES.AWAITING_BANK_SELECTION_BULK:
            await handleBankSelection(user, buttonId, INTENTS.ADD_PRODUCTS_FROM_LIST);
            break;

        case USER_STATES.AWAITING_SALE_TYPE_CONFIRMATION:
            await handleSaleTypeConfirmation(user, buttonId);
            break;
        case USER_STATES.AWAITING_RECONCILE_ACTION:
            await handleReconcileAction(user, buttonId);
            break;
        case USER_STATES.AWAITING_EDIT_FIELD_SELECTION:
            await handleEditFieldSelection(user, buttonId);
            break;
        case USER_STATES.AWAITING_DELETE_CONFIRMATION:
            await handleDeleteConfirmation(user, buttonId);
            break;
        default:
            await sendTextMessage(user.whatsappId, "Session expired or invalid state. Please start over.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendMainMenu(user.whatsappId);
            break;
    }
}

async function handleListReply(user, listId, originalMessage) {
    
    // --- MAIN MENU ROUTING ---
    switch (listId) {
        case 'log a sale':
            await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: [], saleData: { items: [] } });
            await sendTextMessage(user.whatsappId, "What did you sell? (e.g., 'Sold 2 Rice to John')");
            return;

        case 'log an expense':
            await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: [] });
            await sendTextMessage(user.whatsappId, "What did you spend money on? (e.g., 'Fuel 5k')");
            return;

        case 'add a product':
            await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: [], existingProduct: null });
            await sendTextMessage(user.whatsappId, "What product are you adding/restocking? (e.g., 'Restock 50 Coke')");
            return;

        case 'generate report':
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_REPORT_TYPE_SELECTION);
            await sendReportMenu(user.whatsappId);
            return;
        
        case 'get financial insight':
            await executeTask(INTENTS.GET_FINANCIAL_INSIGHT, user, {});
            return;

        case 'edit a transaction':
            await executeTask(INTENTS.RECONCILE_TRANSACTION, user, {});
            return;

        case 'manage bank accounts':
            await sendInteractiveButtons(user.whatsappId, "Manage Bank Accounts 🏦\nWhat would you like to do?", [
                { id: 'bank_action:add', title: 'Add New Bank ➕' },
                { id: 'bank_action:check', title: 'Check Balance 💰' }
            ]);
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_MENU_SELECTION);
            return;

        case 'check subscription':
            await executeTask(INTENTS.CHECK_SUBSCRIPTION, user, {}); 
             await handleMessage({
                from: originalMessage.from,
                id: originalMessage.id,
                text: { body: 'check subscription' },
                type: 'text'
            });
            return;

        // [NEW] Help Menu Link
        case 'help menu':
            await sendInteractiveButtons(user.whatsappId, "Support & Guidance 🆘\n\nHow can we assist you today?", [
                { id: 'help_action:usage', title: '📖 Product Usage' },
                { id: 'help_action:contact', title: '💬 Contact Sales' }
            ]);
            return;
    }

    // --- OTHER LIST ACTIONS ---

    if (listId.startsWith('view_balance:')) {
        const bankId = listId.split(':')[1];
        const banks = await getAllBankAccounts(user._id);
        const bank = banks.find(b => b._id.toString() === bankId);
        
        if (bank) {
            await sendTextMessage(user.whatsappId, `🏦 *${bank.bankName}*\n\nBalance: *${user.currency} ${bank.balance.toLocaleString()}*`);
        } else {
            await sendTextMessage(user.whatsappId, "Bank not found.");
        }
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendMainMenu(user.whatsappId);
        return;
    }

    if (listId.startsWith('select_bank:')) {
        let intent;
        if (user.state === USER_STATES.AWAITING_BANK_SELECTION_SALE) intent = INTENTS.LOG_SALE;
        else if (user.state === USER_STATES.AWAITING_BANK_SELECTION_EXPENSE) intent = INTENTS.LOG_EXPENSE;
        else if (user.state === USER_STATES.AWAITING_BANK_SELECTION_PURCHASE) intent = INTENTS.ADD_PRODUCT;
        else if (user.state === USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT) intent = INTENTS.LOG_CUSTOMER_PAYMENT;
        else if (user.state === USER_STATES.AWAITING_BANK_SELECTION_BULK) intent = INTENTS.ADD_PRODUCTS_FROM_LIST;

        if (intent) {
            await handleBankSelection(user, listId, intent);
            return;
        }
    }

    if (user.state === USER_STATES.AWAITING_TRANSACTION_SELECTION) {
        await handleTransactionSelection(user, listId);
        return;
    } 
    
    // --- REPORT SELECTION ---
    if (user.state === USER_STATES.AWAITING_REPORT_TYPE_SELECTION) {
        let reportType = 'SALES';
        if (listId === 'generate expense report') reportType = 'EXPENSES';
        if (listId === 'generate p&l report') reportType = 'PNL';
        if (listId === 'generate cogs report') reportType = 'COGS';
        if (listId === 'generate inventory report') reportType = 'INVENTORY';

        const extractedDates = user.stateContext?.extractedDates || {};
        
        let startDate, endDate;
        if (extractedDates.startDate && extractedDates.endDate) {
            const range = getDateRange({ startDate: extractedDates.startDate, endDate: extractedDates.endDate });
            startDate = range.startDate;
            endDate = range.endDate;
        } else if (extractedDates.dateRange) {
            const range = getDateRange(extractedDates.dateRange);
            startDate = range.startDate;
            endDate = range.endDate;
        } else {
            const range = getDateRange('this_month');
            startDate = range.startDate;
            endDate = range.endDate;
        }

        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendTextMessage(user.whatsappId, "I've added your report to the generation queue. You'll receive it shortly! ⏳");
        
        await queueReportGeneration(
            user._id, 
            user.currency, 
            reportType, 
            { startDate, endDate }, 
            user.whatsappId
        );
        await sendMainMenu(user.whatsappId);
        return;
    }

    // Default Fallback
    await handleMessage({
        from: originalMessage.from,
        id: originalMessage.id,
        text: { body: listId },
        type: 'text'
    });
}

async function handleBankSelection(user, buttonId, intent) {
    const [action, bankIdStr] = buttonId.split(':');
    if (action !== 'select_bank') return;

    let transactionData = user.stateContext.transactionData;
    let linkedBankId = null;
    
    if (bankIdStr !== 'none') {
         linkedBankId = new ObjectId(bankIdStr);
    }

    if (intent === INTENTS.ADD_PRODUCTS_FROM_LIST) {
        const productsToAdd = transactionData.products || [];
        transactionData = { 
            products: productsToAdd, 
            linkedBankId: linkedBankId 
        };
    } else if (intent === INTENTS.LOG_EXPENSE && transactionData.expenses) {
        transactionData.expenses = transactionData.expenses.map(e => ({ ...e, linkedBankId }));
    } else {
        transactionData.linkedBankId = linkedBankId;
    }

    await sendTextMessage(user.whatsappId, "Great, noting that down... 📝");

    try {
        if (intent === INTENTS.LOG_SALE) {
            const txn = await TransactionManager.logSale(user, transactionData);
            await sendTextMessage(user.whatsappId, `✅ Sale logged! Amount: ${user.currency} ${txn.amount.toLocaleString()}`);
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transaction: txn });
            await sendInteractiveButtons(user.whatsappId, 'Generate Invoice?', [{ id: 'invoice_yes', title: 'Yes' }, { id: 'invoice_no', title: 'No' }]);
            return; 

        } else if (intent === INTENTS.LOG_EXPENSE) {
            if (transactionData.expenses) {
                for (const exp of transactionData.expenses) {
                    await TransactionManager.logExpense(user, exp);
                }
                await sendTextMessage(user.whatsappId, `✅ ${transactionData.expenses.length} expenses logged successfully.`);
            } else {
                await TransactionManager.logExpense(user, transactionData);
                await sendTextMessage(user.whatsappId, "✅ Expense logged successfully.");
            }

        } else if (intent === INTENTS.LOG_CUSTOMER_PAYMENT) {
            await TransactionManager.logCustomerPayment(user, transactionData);
            await sendTextMessage(user.whatsappId, "✅ Payment recorded.");

        } else if (intent === INTENTS.ADD_PRODUCT) {
            const product = await InventoryManager.addProduct(user, transactionData);
            await sendTextMessage(user.whatsappId, `✅ Stock updated for "${product.productName}".`);
        
        } else if (intent === INTENTS.ADD_PRODUCTS_FROM_LIST) {
            const productsToAdd = transactionData.products;
            const enrichedProducts = productsToAdd.map(p => ({ 
                ...p, 
                linkedBankId: transactionData.linkedBankId,
                costPrice: p.costPrice || 0,
                sellingPrice: p.sellingPrice || 0,
                quantityAdded: p.quantityAdded || 0
            }));
            
            await sendTextMessage(user.whatsappId, "Adding products... 📦");
            const result = await InventoryManager.addBulkProducts(user, enrichedProducts);
            
            if (result.errors.length > 0) {
                await sendTextMessage(user.whatsappId, `✅ Added ${result.added.length} items.\n⚠️ Failed to add: ${result.errors.join(', ')}`);
            } else {
                await sendTextMessage(user.whatsappId, `✅ Successfully added all ${result.added.length} products!`);
            }
        }

        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendMainMenu(user.whatsappId);

    } catch (error) {
        logger.error(`Error processing bank selection for ${intent}:`, error);
        await sendTextMessage(user.whatsappId, "I ran into an error saving that transaction.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
    }
}

async function handleBulkProductConfirmation(user, buttonId) {
    if (buttonId === 'confirm_bulk_add') {
        const productsToAdd = user.stateContext.products;
        if (productsToAdd && productsToAdd.length > 0) {
            
            const banks = await getAllBankAccounts(user._id);
            if (banks.length > 0) {
                await askForBankSelection(
                    user, 
                    { products: productsToAdd }, 
                    USER_STATES.AWAITING_BANK_SELECTION_BULK, 
                    'Paid for stock from which account?'
                );
                return;
            }

            await sendTextMessage(user.whatsappId, "Adding products... 📦");
            const result = await InventoryManager.addBulkProducts(user, productsToAdd);
            
            if (result.errors.length > 0) {
                await sendTextMessage(user.whatsappId, `✅ Added ${result.added.length} items.\n⚠️ Failed to add: ${result.errors.join(', ')}`);
            } else {
                await sendTextMessage(user.whatsappId, `✅ Successfully added all ${result.added.length} products!`);
            }
        } else {
            await sendTextMessage(user.whatsappId, "Session expired. Please send the list again.");
        }
    } else {
        await sendTextMessage(user.whatsappId, "Cancelled.");
    }
    await updateUserState(user.whatsappId, USER_STATES.IDLE);
    await sendMainMenu(user.whatsappId);
}

async function handleInvoiceConfirmation(user, buttonId) {
    if (buttonId === 'invoice_yes') {
        const { transaction } = user.stateContext;
        if (!transaction) {
            await sendTextMessage(user.whatsappId, "Transaction details lost. Cannot generate invoice.");
        } else {
            await sendTextMessage(user.whatsappId, "Generating invoice... 🧾");
            try {
                const customerId = new ObjectId(transaction.linkedCustomerId);
                const customer = await findCustomerById(customerId);

                const pdfBuffer = await generateInvoice(user, transaction, customer);
                const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
                if (mediaId) {
                    const filename = `Invoice_${transaction._id.toString().slice(-6).toUpperCase()}.pdf`;
                    await sendDocument(user.whatsappId, mediaId, filename, "Here is your invoice.");
                } else {
                    await sendTextMessage(user.whatsappId, "Created invoice but upload failed.");
                }
            } catch (e) {
                logger.error("Invoice Gen Error:", e);
                await sendTextMessage(user.whatsappId, "Error generating invoice.");
            }
        }
    } else {
        await sendTextMessage(user.whatsappId, "Okay, no invoice generated.");
    }
    await updateUserState(user.whatsappId, USER_STATES.IDLE);
    await sendMainMenu(user.whatsappId);
}

async function handleSaleTypeConfirmation(user, buttonId) {
    const { memory, saleData, productName } = user.stateContext;
    const [action, type] = buttonId.split(':');

    if (action !== 'sale_type') return;

    if (type === 'product') {
        await sendTextMessage(user.whatsappId, `Okay, let's add "${productName}" to inventory first. How many units?`);
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, {
            memory: [],
            existingProduct: null
        });
    } else if (type === 'service') {
        const updatedSaleData = { ...saleData };
        if (updatedSaleData.items && updatedSaleData.items[0]) {
            updatedSaleData.items[0].isService = true;
            delete updatedSaleData.items[0].productId;
        }
        await sendTextMessage(user.whatsappId, "Noted as service. Continuing sale...");
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory, saleData: updatedSaleData, isService: true });
        await handleMessage({ from: user.whatsappId, id: null, text: { body: memory[memory.length -1]?.content || "" }, type: 'text'});
    }
}

async function handleTransactionSelection(user, listId) {
    const [action, txIdStr] = listId.split(':');
    if (action !== 'select_tx') return;

    const transaction = await findTransactionById(new ObjectId(txIdStr));
    if (!transaction) {
        await sendTextMessage(user.whatsappId, "Transaction not found.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        return;
    }
    
    const summary = `*Selected Transaction:*\nType: ${transaction.type}\nAmount: ${transaction.amount}\nDate: ${new Date(transaction.date).toLocaleDateString()}`;
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_RECONCILE_ACTION, { transaction });
    await sendTextMessage(user.whatsappId, summary);
    await sendInteractiveButtons(user.whatsappId, "Choose action:", [
        { id: 'action_edit', title: '✏️ Edit' },
        { id: 'action_delete', title: '🗑️ Delete' }
    ]);
}

async function handleReconcileAction(user, buttonId) {
    const { transaction } = user.stateContext;
    if (buttonId === 'action_delete') {
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_DELETE_CONFIRMATION, { transactionId: transaction._id });
        await sendInteractiveButtons(user.whatsappId, "Confirm deletion? This reverses balances.", [
            { id: 'confirm_delete', title: 'Yes, Delete' },
            { id: 'cancel_delete', title: 'Cancel' }
        ]);
    } else if (buttonId === 'action_edit') {
        let buttons = [];
        if (transaction.type === 'SALE') buttons = [{ id: 'edit_field:unitsSold', title: 'Edit Quantity' }, { id: 'edit_field:amountPerUnit', title: 'Edit Price' }];
        else buttons = [{ id: 'edit_field:amount', title: 'Edit Amount' }];
        
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_EDIT_FIELD_SELECTION, { transaction });
        await sendInteractiveButtons(user.whatsappId, "What to edit?", buttons);
    }
}

async function handleEditFieldSelection(user, buttonId) {
    const { transaction } = user.stateContext;
    const [action, fieldToEdit] = buttonId.split(':');
    if (action !== 'edit_field') return;

    await updateUserState(user.whatsappId, USER_STATES.AWAITING_EDIT_VALUE, { transaction, fieldToEdit });
    await sendTextMessage(user.whatsappId, `Please type the new value for ${fieldToEdit}:`);
}

async function handleDeleteConfirmation(user, buttonId) {
    if (buttonId === 'confirm_delete') {
        const { transactionId } = user.stateContext;
        await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId, action: 'delete' });
    } else {
        await sendTextMessage(user.whatsappId, "Deletion cancelled.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendMainMenu(user.whatsappId);
    }
}
