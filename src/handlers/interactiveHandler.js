import { findOrCreateUser, updateUserState } from '../db/userService.js';
import { findTransactionById } from '../db/transactionService.js';
import { findCustomerById } from '../db/customerService.js';
import { generateInvoice } from '../services/pdfService.js';
import { uploadMedia, sendDocument, sendTextMessage } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';

export async function handleInteractiveMessage(message) {
    const whatsappId = message.from;
    const interactiveData = message.interactive;

    try {
        const user = await findOrCreateUser(whatsappId);

        if (interactiveData.type !== 'button_reply') return;
        
        const buttonId = interactiveData.button_reply.id;

        switch (user.state) {
            case USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION:
                await handleBulkProductConfirmation(user, buttonId);
                break;
            case USER_STATES.AWAITING_INVOICE_CONFIRMATION:
                await handleInvoiceConfirmation(user, buttonId);
                break;
            default:
                logger.warn(`Received a button click in an unhandled state: ${user.state} for user ${whatsappId}`);
                await sendTextMessage(whatsappId, "Sorry, I wasn't expecting that response right now.");
                break;
        }

    } catch (error) {
        logger.error(`Error in interactive handler for ${whatsappId}:`, error);
        await sendTextMessage(whatsappId, "Something went wrong while processing your selection. Please try again.");
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
        // Always reset the state to IDLE after handling the confirmation
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}
