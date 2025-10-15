import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findOrCreateProduct, updateStock } from '../db/productService.js';
import { createSaleTransaction } from '../db/transactionService.js';
import { updateUserState } from '../db/userService.js';
import { sendTextMessage, sendInteractiveButtons } from '../api/whatsappService.js';
import { INTENTS, USER_STATES } from '../utils/constants.js';
import logger from '../utils/logger.js';

/**
 * Executes a business logic task based on a completed data collection.
 * @param {string} intent The task to execute (e.g., INTENTS.LOG_SALE).
 * @param {object} user The full user document.
 * @param {object} data The data collected by the worker AI.
 */
export async function executeTask(intent, user, data) {
    try {
        switch (intent) {
            case INTENTS.LOG_SALE:
                await executeLogSale(user, data);
                break;
            default:
                logger.warn(`No executor found for intent: ${intent}`);
                await sendTextMessage(user.whatsappId, "I'm not sure how to process that right now, but I'm learning!");
                break;
        }
    } catch (error) {
        logger.error(`Error executing task for intent ${intent} and user ${user.whatsappId}:`, error);
        await sendTextMessage(user.whatsappId, "I ran into an issue trying to complete that task. Please try again. 🛠️");
    } finally {
        // Reset user state to IDLE after any task attempt
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}

async function executeLogSale(user, data) {
    const { productName, unitsSold, amountPerUnit, customerName, saleType } = data;
    const totalAmount = unitsSold * amountPerUnit;

    // 1. Get or create the customer and product
    const customer = await findOrCreateCustomer(user._id, customerName);
    const product = await findOrCreateProduct(user._id, productName);

    // 2. Create the sale transaction
    const description = `${unitsSold} x ${productName} sold to ${customerName}`;
    const transactionData = {
        userId: user._id,
        totalAmount,
        date: new Date(),
        description,
        linkedProductId: product._id,
        linkedCustomerId: customer._id,
        paymentMethod: saleType,
    };
    const transaction = await createSaleTransaction(transactionData);

    // 3. Update product stock (and create inventory log)
    await updateStock(product._id, -unitsSold, 'SALE', transaction._id);

    // 4. Update customer balance if it was a credit sale
    if (saleType.toLowerCase() === 'credit') {
        await updateBalanceOwed(customer._id, totalAmount);
    }

    // 5. Confirm with the user
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(totalAmount);
    await sendTextMessage(user.whatsappId, `✅ Sale logged successfully! ${description} for ${formattedAmount}.`);
    
    // TODO: Ask about generating an invoice
    // We will handle the response to this in the interactiveHandler later.
    // await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transactionId: transaction._id });
    // await sendInteractiveButtons(
    //     user.whatsappId,
    //     'Would you like me to generate a PDF invoice for this sale?',
    //     [{ id: `invoice_yes_${transaction._id}`, title: 'Yes, Please' }, { id: 'invoice_no', title: 'No, Thanks' }]
    // );
}
