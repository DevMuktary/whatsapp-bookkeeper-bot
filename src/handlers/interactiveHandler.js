import { findOrCreateUser, updateUserState } from '../db/userService.js';
import { findTransactionById } from '../db/transactionService.js';
import { findCustomerById } from '../db/customerService.js';
import { generateInvoice } from '../services/pdfService.js';
import { uploadMedia, sendDocument, sendTextMessage, sendInteractiveButtons } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';
import { ObjectId } from 'mongodb';

export async function handleInteractiveMessage(message) {
    const whatsappId = message.from;
    const interactive = message.interactive;
    const user = await findOrCreateUser(whatsappId);

    try {
        if (interactive.type === 'button_reply') {
            await handleButtonReply(user, interactive.button_reply.id);
        } else if (interactive.type === 'list_reply') {
            await handleListReply(user, interactive.list_reply.id);
        }
    } catch (error) {
        logger.error(`Error in interactive handler for ${whatsappId}:`, error);
        await sendTextMessage(whatsappId, "Something went wrong while processing your selection. Please try again.");
    }
}

async function handleButtonReply(user, buttonId) {
    switch (user.state) {
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
        case USER_STATES.AWAITING_DELETE_CONFIRMATION:
            await handleDeleteConfirmation(user, buttonId);
            break;
        default:
            logger.warn(`Received a button click in an unhandled state: ${user.state}`);
            await sendTextMessage(user.whatsappId, "Sorry, I wasn't expecting that response right now.");
            break;
    }
}

async function handleListReply(user, listId) {
    switch (user.state) {
        case USER_STATES.AWAITING_TRANSACTION_SELECTION_FOR_DELETE:
            await handleTransactionSelectionForDelete(user, listId);
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
            await executeTask(INTENTS.ADD_MULTIPLE_PRODUCTS, user, { products: productsToAdd });
        } else {
            await sendTextMessage(user.whatsappId, "Something went wrong, I seem to have lost the list of products. Please send it again.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        }
    } else if (buttonId === 'cancel_bulk_add') {
        await sendTextMessage(user.whatsappId, "Okay, I've cancelled that request. You can try again or add products one by one.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}

async function handleInvoiceConfirmation(user, buttonId) {
    try {
        if (buttonId === 'invoice_yes') {
            const { transactionId } = user.stateContext;
            if (!transactionId) {
                await sendTextMessage(user.whatsappId, "I seem to have lost the details of that sale. Please try logging it again.");
                return;
            }

            await sendTextMessage(user.whatsappId, "Perfect! Generating your invoice now... 🧾");

            const transaction = await findTransactionById(transactionId);
            if (!transaction) {
                 await sendTextMessage(user.whatsappId, "I couldn't find the original sale record to create an invoice.");
                 return;
            }

            const customer = await findCustomerById(transaction.linkedCustomerId);
            if (!customer) {
                await sendTextMessage(user.whatsappId, "I couldn't find the customer details for this invoice.");
                return;
            }

            const pdfBuffer = await generateInvoice(user, transaction, customer);
            const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');

            if (mediaId) {
                const filename = `Invoice_${transaction._id.toString().slice(-8).toUpperCase()}.pdf`;
                await sendDocument(user.whatsappId, mediaId, filename, `Here is the invoice for your recent sale to ${customer.customerName}.`);
            } else {
                await sendTextMessage(user.whatsappId, "I created the invoice, but I had trouble uploading it. Please try asking for it again later.");
            }

        } else if (buttonId === 'invoice_no') {
            await sendTextMessage(user.whatsappId, "No problem! Let me know if you need anything else.");
        }
    } catch (error) {
        logger.error(`Error handling invoice confirmation for user ${user.whatsappId}:`, error);
        await sendTextMessage(user.whatsappId, "I ran into a problem while creating the invoice. Please try again.");
    } finally {
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}

async function handleBankSelection(user, buttonId, originalIntent) {
    const [action, bankIdStr] = buttonId.split(':');

    if (action === 'select_bank') {
        const transactionData = user.stateContext.transactionData;
        
        transactionData.linkedBankId = new ObjectId(bankIdStr);

        await sendTextMessage(user.whatsappId, "Great, linking this to your bank account...");
        await executeTask(originalIntent, user, transactionData);
    } else {
        logger.warn(`Unknown action in handleBankSelection: ${action}`);
    }
}

async function handleTransactionSelectionForDelete(user, listId) {
    const [action, txIdStr] = listId.split(':');
    if (action !== 'select_tx_del') return;

    const transaction = await findTransactionById(new ObjectId(txIdStr));
    if (!transaction) {
        await sendTextMessage(user.whatsappId, "I couldn't find that transaction. Please try again.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        return;
    }

    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(transaction.amount);
    const summary = `*Transaction Details:*\n\n*Type:* ${transaction.type}\n*Amount:* ${formattedAmount}\n*Description:* ${transaction.description}\n*Date:* ${new Date(transaction.date).toLocaleString()}`;
    
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_DELETE_CONFIRMATION, { transactionId: transaction._id });
    await sendTextMessage(user.whatsappId, summary);
    await sendInteractiveButtons(user.whatsappId, "Are you sure you want to permanently delete this transaction? This action cannot be undone.", [
        { id: 'confirm_delete', title: 'Yes, Delete It' },
        { id: 'cancel_delete', title: 'No, Keep It' }
    ]);
}

async function handleDeleteConfirmation(user, buttonId) {
    if (buttonId === 'confirm_delete') {
        const { transactionId } = user.stateContext;
        if (!transactionId) {
            await sendTextMessage(user.whatsappId, "I've lost track of which transaction to delete. Please start over.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            return;
        }
        await sendTextMessage(user.whatsappId, "Okay, deleting the transaction and reversing its effects... ⏳");
        await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId, action: 'delete' });
    } else if (buttonId === 'cancel_delete') {
        await sendTextMessage(user.whatsappId, "Okay, I've cancelled the deletion. The transaction has not been changed.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
    }
}
