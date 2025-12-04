import { findOrCreateUser, updateUserState } from '../db/userService.js';
import { findTransactionById } from '../db/transactionService.js';
import { findCustomerById } from '../db/customerService.js';
import { generateInvoice } from '../services/pdfService.js';
import { uploadMedia, sendDocument, sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, setTypingIndicator, sendAddBankFlow } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { handleMessage } from './messageHandler.js';
import { getAllBankAccounts } from '../db/bankService.js'; // [NEW]
import { ObjectId } from 'mongodb';

// Import Managers
import * as TransactionManager from '../services/TransactionManager.js';
import * as InventoryManager from '../services/InventoryManager.js';
import { executeTask } from './taskHandler.js'; 

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
    switch (user.state) {
        // [NEW] BANK MENU HANDLER
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
    // [NEW] VIEW BALANCE HANDLER
    if (listId.startsWith('view_balance:')) {
        const bankId = listId.split(':')[1];
        const banks = await getAllBankAccounts(user._id);
        const bank = banks.find(b => b._id.toString() === bankId);
        
        if (bank) {
            await sendTextMessage(user.whatsappId, `🏦 **${bank.bankName}**\n\nBalance: **${user.currency} ${bank.balance.toLocaleString()}**`);
        } else {
            await sendTextMessage(user.whatsappId, "Bank not found.");
        }
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendMainMenu(user.whatsappId);
        return;
    }

    // CHECK FOR TRANSACTION BANK SELECTION
    if (listId.startsWith('select_bank:')) {
        let intent;
        if (user.state === USER_STATES.AWAITING_BANK_SELECTION_SALE) intent = INTENTS.LOG_SALE;
        else if (user.state === USER_STATES.AWAITING_BANK_SELECTION_EXPENSE) intent = INTENTS.LOG_EXPENSE;
        else if (user.state === USER_STATES.AWAITING_BANK_SELECTION_PURCHASE) intent = INTENTS.ADD_PRODUCT;
        else if (user.state === USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT) intent = INTENTS.LOG_CUSTOMER_PAYMENT;

        if (intent) {
            await handleBankSelection(user, listId, intent);
            return;
        }
    }

    if (user.state === USER_STATES.AWAITING_TRANSACTION_SELECTION) {
        await handleTransactionSelection(user, listId);
    } else {
        if (user.state === USER_STATES.AWAITING_REPORT_TYPE_SELECTION) {
             await updateUserState(user.whatsappId, USER_STATES.IDLE);
        }
        await handleMessage({
            from: originalMessage.from,
            id: originalMessage.id,
            text: { body: listId },
            type: 'text'
        });
    }
}

// --- HANDLERS ---

async function handleBankSelection(user, buttonId, intent) {
    const [action, bankIdStr] = buttonId.split(':');
    if (action !== 'select_bank') return;

    const transactionData = user.stateContext.transactionData;
    
    if (bankIdStr !== 'none') {
         transactionData.linkedBankId = new ObjectId(bankIdStr);
    } else {
        transactionData.linkedBankId = null; 
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
            await TransactionManager.logExpense(user, transactionData);
            await sendTextMessage(user.whatsappId, "✅ Expense logged successfully.");

        } else if (intent === INTENTS.LOG_CUSTOMER_PAYMENT) {
            await TransactionManager.logCustomerPayment(user, transactionData);
            await sendTextMessage(user.whatsappId, "✅ Payment recorded.");

        } else if (intent === INTENTS.ADD_PRODUCT) {
            const product = await InventoryManager.addProduct(user, transactionData);
            await sendTextMessage(user.whatsappId, `✅ Stock updated for "${product.productName}".`);
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
                const customer = await findCustomerById(transaction.linkedCustomerId);
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

// --- RECONCILIATION & EDITS ---

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
