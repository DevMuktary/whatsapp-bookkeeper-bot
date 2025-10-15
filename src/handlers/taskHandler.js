import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findOrCreateProduct, updateStock, upsertProduct } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction } from '../db/transactionService.js';
import { updateUserState } from '../db/userService.js';
import { sendTextMessage, sendInteractiveButtons } from '../api/whatsappService.js';
import { INTENTS, USER_STATES } from '../utils/constants.js';
import logger from '../utils/logger.js';

export async function executeTask(intent, user, data) {
    try {
        switch (intent) {
            case INTENTS.LOG_SALE:
                await executeLogSale(user, data);
                break;
            case INTENTS.LOG_EXPENSE:
                await executeLogExpense(user, data);
                break;
            case INTENTS.ADD_PRODUCT:
                await executeAddProduct(user, data);
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
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}

async function executeLogSale(user, data) {
    const { productName, unitsSold, amountPerUnit, customerName, saleType } = data;
    const totalAmount = unitsSold * amountPerUnit;

    const customer = await findOrCreateCustomer(user._id, customerName);
    const product = await findOrCreateProduct(user._id, productName);

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

    await updateStock(product._id, -unitsSold, 'SALE', transaction._id);

    if (saleType.toLowerCase() === 'credit') {
        await updateBalanceOwed(customer._id, totalAmount);
    }

    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(totalAmount);
    await sendTextMessage(user.whatsappId, `✅ Sale logged successfully! ${description} for ${formattedAmount}.`);
}

async function executeLogExpense(user, data) {
    const { category, amount, description } = data;

    const transactionData = {
        userId: user._id,
        amount: Number(amount),
        date: new Date(),
        description,
        category,
    };
    await createExpenseTransaction(transactionData);
    
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(amount);
    await sendTextMessage(user.whatsappId, `✅ Expense logged: ${formattedAmount} for "${description}".`);
}

async function executeAddProduct(user, data) {
    const { productName, quantityAdded, costPrice, sellingPrice } = data;

    const product = await upsertProduct(
        user._id,
        productName,
        Number(quantityAdded),
        Number(costPrice),
        Number(sellingPrice)
    );

    await sendTextMessage(user.whatsappId, `📦 Done! "${product.productName}" has been updated. You now have ${product.quantity} units in stock.`);
}
