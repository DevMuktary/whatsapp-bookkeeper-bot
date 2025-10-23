import { findOrCreateUser, updateUserState } from '../db/userService.js';
import { findTransactionById } from '../db/transactionService.js';
import { findCustomerById } from '../db/customerService.js';
import { generateInvoice } from '../services/pdfService.js';
import { uploadMedia, sendDocument, sendTextMessage, sendInteractiveButtons, sendMainMenu } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';
import { handleMessage } from './messageHandler.js';
import { ObjectId } from 'mongodb';

export async function handleInteractiveMessage(message) {
    const whatsappId = message.from;
    const interactive = message.interactive;
    const user = await findOrCreateUser(whatsappId);

    try {
        if (interactive.type === 'button_reply') {
            await handleButtonReply(user, interactive.button_reply.id, message);
        } else if (interactive.type === 'list_reply') {
            await handleListReply(user, interactive.list_reply.id, message);
        }
    } catch (error) {
        logger.error(`Error in interactive handler for ${whatsappId}:`, error);
        await sendTextMessage(whatsappId, "Something went wrong while processing your selection. Please try again.");
    }
}

async function handleButtonReply(user, buttonId, originalMessage) {
    switch (user.state) {
        case USER_STATES.IDLE:
            logger.info(`Handling quick start button click from IDLE state for user ${user.whatsappId}`);
            // Treat button click as if user typed the text
            const mockTextMessage = {
                from: originalMessage.from,
                text: { body: buttonId },
                type: 'text'
            };
            await handleMessage(mockTextMessage);
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
            logger.warn(`Received a button click in an unhandled state: ${user.state}`);
            await sendTextMessage(user.whatsappId, "Sorry, I wasn't expecting that response right now.");
            break;
    }
}

async function handleListReply(user, listId, originalMessage) {
    switch (user.state) {
        case USER_STATES.IDLE:
        case USER_STATES.AWAITING_REPORT_TYPE_SELECTION:
            logger.info(`Handling list click from ${user.state} for user ${user.whatsappId}`);
            // Treat list selection as if user typed the text
            const mockTextMessage = {
                from: originalMessage.from,
                text: { body: listId },
                type: 'text'
            };
            // Reset state first ONLY if coming from report selection
            if (user.state === USER_STATES.AWAITING_REPORT_TYPE_SELECTION) {
                 await updateUserState(user.whatsappId, USER_STATES.IDLE);
            }
            await handleMessage(mockTextMessage);
            break;

        case USER_STATES.AWAITING_TRANSACTION_SELECTION:
            await handleTransactionSelection(user, listId);
            break;
        default:
            logger.warn(`Received a list reply in an unhandled state: ${user.state}`);
            await sendTextMessage(user.whatsappId, "Sorry, I wasn't expecting that response right now.");
            break;
    }
}

async function handleBulkProductConfirmation(user, buttonId) {
    if (buttonId === 'confirm_bulk_add') {
        const productsToAdd = user.stateContext.products;
        if (productsToAdd && productsToAdd.length > 0) {
            await sendTextMessage(user.whatsappId, "Great! Adding them to your inventory now... ⏳");
            // Note: Bank selection for bulk purchase cost is complex and not implemented here.
            await sendTextMessage(user.whatsappId, "(Note: Bank balance deduction for bulk purchases isn't implemented yet.)");
            await executeTask(INTENTS.ADD_MULTIPLE_PRODUCTS, user, { products: productsToAdd });
        } else {
            await sendTextMessage(user.whatsappId, "Something went wrong, I seem to have lost the list of products. Please send it again.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        }
    } else if (buttonId === 'cancel_bulk_add') {
        await sendTextMessage(user.whatsappId, "Okay, I've cancelled that request. You can try again or add products one by one.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        await sendMainMenu(user.whatsappId);
    }
}

async function handleInvoiceConfirmation(user, buttonId) {
    let shouldSendMenu = true; // Assume we send menu unless invoice generation starts
    try {
        if (buttonId === 'invoice_yes') {
            shouldSendMenu = false; // Don't send menu immediately, wait for PDF generation/sending
            const { transaction } = user.stateContext; // Get full transaction
            if (!transaction || !transaction._id) {
                await sendTextMessage(user.whatsappId, "I seem to have lost the details of that sale. Please try logging it again.");
                await updateUserState(user.whatsappId, USER_STATES.IDLE, {}); // Reset state on error
                await sendMainMenu(user.whatsappId); // Send menu after error
                return;
            }
            await sendTextMessage(user.whatsappId, "Perfect! Generating your invoice now... 🧾");

            const customer = await findCustomerById(transaction.linkedCustomerId);
            if (!customer) {
                await sendTextMessage(user.whatsappId, "I couldn't find the customer details for this invoice.");
                 await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
                 await sendMainMenu(user.whatsappId);
                return;
            }
            const pdfBuffer = await generateInvoice(user, transaction, customer);
            const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
            if (mediaId) {
                const filename = `Invoice_${transaction._id.toString().slice(-8).toUpperCase()}.pdf`;
                await sendDocument(user.whatsappId, mediaId, filename, `Here is the invoice for your recent sale to ${customer.customerName}.`);
                shouldSendMenu = true; // Send menu after successful PDF send
            } else {
                await sendTextMessage(user.whatsappId, "I created the invoice, but I had trouble uploading it. Please try asking for it again later.");
                shouldSendMenu = true; // Send menu even if upload failed
            }
        } else if (buttonId === 'invoice_no') {
            await sendTextMessage(user.whatsappId, "No problem! Let me know if you need anything else.");
            shouldSendMenu = true;
        }
    } catch (error) {
        logger.error(`Error handling invoice confirmation for user ${user.whatsappId}:`, error);
        await sendTextMessage(user.whatsappId, "I ran into a problem while creating the invoice. Please try again.");
        shouldSendMenu = true; // Send menu after error
    } finally {
        // Only reset state and send menu when appropriate
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        if (shouldSendMenu) {
            await sendMainMenu(user.whatsappId);
        }
    }
}

async function handleBankSelection(user, buttonId, originalIntent) {
    const [action, bankIdStr] = buttonId.split(':');
    if (action === 'select_bank') {
        const transactionData = user.stateContext.transactionData;
        
        if (bankIdStr !== 'none') {
             transactionData.linkedBankId = new ObjectId(bankIdStr);
        } else {
            transactionData.linkedBankId = null; 
        }

        await sendTextMessage(user.whatsappId, "Great, noting that down...");
        await executeTask(originalIntent, user, transactionData);
    } else {
        logger.warn(`Unknown action in handleBankSelection: ${action}`);
    }
}

async function handleSaleTypeConfirmation(user, buttonId) {
    const { memory, saleData, productName } = user.stateContext;
    const [action, type] = buttonId.split(':');

    if (action !== 'sale_type') return;

    if (type === 'product') {
        await sendTextMessage(user.whatsappId, `Okay, let's add "${productName}" to your inventory first.`);
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, {
            memory: [],
            existingProduct: null,
            // pendingSale: { memory: memory, saleData: saleData } // Consider resuming later
        });
        await sendTextMessage(user.whatsappId, `How many units of "${productName}" are you adding?`);

    } else if (type === 'service') {
        // Mark the first item as a service
        const updatedSaleData = { ...saleData };
        if (updatedSaleData.items && updatedSaleData.items[0]) {
            updatedSaleData.items[0].isService = true;
            // Crucially, remove productId if it was incorrectly assumed
            delete updatedSaleData.items[0].productId;
        }
        await sendTextMessage(user.whatsappId, "Okay, noted as a service. Let's continue logging the sale.");
        // Continue the sale flow, passing isService=true
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory, saleData: updatedSaleData, isService: true });
        // Use the last user message to re-trigger the AI
        await handleMessage({ from: user.whatsappId, text: { body: memory[memory.length -1]?.content || "" }, type: 'text'});
    }
}


async function handleTransactionSelection(user, listId) {
    const [action, txIdStr] = listId.split(':');
    if (action !== 'select_tx') return;

    const transaction = await findTransactionById(new ObjectId(txIdStr));
    if (!transaction) {
        await sendTextMessage(user.whatsappId, "I couldn't find that transaction. Please try again.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        return;
    }
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(transaction.amount);
     let description = transaction.description;
     if (transaction.items && transaction.items.length > 0) {
        description = transaction.items.map(i => `${i.quantity}x ${i.productName}`).join(', ');
     }
    const summary = `*Transaction Details:*\n\n*Type:* ${transaction.type}\n*Amount:* ${formattedAmount}\n*Description:* ${description}\n*Date:* ${new Date(transaction.date).toLocaleString()}`;
    
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_RECONCILE_ACTION, { transaction });
    await sendTextMessage(user.whatsappId, summary);
    await sendInteractiveButtons(user.whatsappId, "What would you like to do with this transaction?", [
        { id: 'action_edit', title: '✏️ Edit' },
        { id: 'action_delete', title: '🗑️ Delete' }
    ]);
}

async function handleReconcileAction(user, buttonId) {
    const { transaction } = user.stateContext;
    if (!transaction) {
        await sendTextMessage(user.whatsappId, "I've lost track of the transaction. Please start over.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        return;
    }

    if (buttonId === 'action_delete') {
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_DELETE_CONFIRMATION, { transactionId: transaction._id });
        await sendInteractiveButtons(user.whatsappId, "Are you sure you want to permanently delete this transaction? This action cannot be undone.", [
            { id: 'confirm_delete', title: 'Yes, Delete It' },
            { id: 'cancel_delete', title: 'No, Keep It' }
        ]);
    } else if (buttonId === 'action_edit') {
        let buttons = [];
        if (transaction.type === 'SALE') {
            if (transaction.items && transaction.items.length === 1 && transaction.items[0].productId) {
                 buttons = [
                    { id: 'edit_field:unitsSold', title: 'Edit Units Sold' },
                    { id: 'edit_field:amountPerUnit', title: 'Edit Unit Price' },
                 ];
            } else if (transaction.items && transaction.items.length === 1 && transaction.items[0].isService) {
                buttons = [ { id: 'edit_field:amount', title: 'Edit Amount' } ]; 
            } else {
                 await sendTextMessage(user.whatsappId, "Editing sales with multiple items isn't supported yet. Please delete and re-enter the transaction.");
                 await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
                 await sendMainMenu(user.whatsappId);
                 return;
            }
        } else if (transaction.type === 'EXPENSE') {
            buttons = [
                { id: 'edit_field:amount', title: 'Edit Amount' },
                { id: 'edit_field:description', title: 'Edit Description' },
            ];
        } else if (transaction.type === 'CUSTOMER_PAYMENT'){ 
            buttons = [{ id: 'edit_field:amount', title: 'Edit Amount' }];
        } else {
             await sendTextMessage(user.whatsappId, "Sorry, editing this type of transaction isn't supported yet.");
             await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
             await sendMainMenu(user.whatsappId);
             return;
        }
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_EDIT_FIELD_SELECTION, { transaction });
        await sendInteractiveButtons(user.whatsappId, "Which part of this transaction would you like to edit?", buttons);
    }
}

async function handleEditFieldSelection(user, buttonId) {
    const { transaction } = user.stateContext;
    const [action, fieldToEdit] = buttonId.split(':');

    if (action !== 'edit_field') return;
    
    const fieldMap = {
        unitsSold: "units sold",
        amountPerUnit: "price per unit",
        amount: "amount",
        description: "description"
    };

    await updateUserState(user.whatsappId, USER_STATES.AWAITING_EDIT_VALUE, { transaction, fieldToEdit });
    await sendTextMessage(user.whatsappId, `Okay, what is the new value for the *${fieldMap[fieldToEdit] || fieldToEdit}*?`);
}

async function handleDeleteConfirmation(user, buttonId) {
    if (buttonId === 'confirm_delete') {
        const { transactionId } = user.stateContext;
        if (!transactionId) {
            await sendTextMessage(user.whatsappId, "I've lost track of which transaction to delete. Please start over.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
            return;
        }
        await sendTextMessage(user.whatsappId, "Okay, deleting the transaction and reversing its effects... ⏳");
        await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId, action: 'delete' });
    } else if (buttonId === 'cancel_delete') {
        await sendTextMessage(user.whatsappId, "Okay, I've cancelled the deletion. The transaction has not been changed.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        await sendMainMenu(user.whatsappId);
    }
}
