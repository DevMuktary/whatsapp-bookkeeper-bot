import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const transactionsCollection = () => getDB().collection('transactions');

/**
 * Creates a new sale transaction in the database.
 * Supports single item/service sales and multi-item sales.
 * @param {object} saleData - The data for the sale.
 * @param {ObjectId} saleData.userId
 * @param {Array<object>} saleData.items - Array of items sold [{productId?, productName, quantity, pricePerUnit}]
 * @param {string} saleData.customerName - Name of the customer.
 * @param {number} saleData.totalAmount - The final calculated total amount.
 * @param {Date} saleData.date
 * @param {string} saleData.description - General description (can be auto-generated).
 * @param {ObjectId} saleData.linkedCustomerId
 * @param {ObjectId} saleData.linkedBankId
 * @param {string} saleData.paymentMethod - 'CASH', 'CREDIT', 'BANK'
 * @returns {Promise<object>} The newly created transaction document.
 */
export async function createSaleTransaction(saleData) {
    try {
        const transactionDoc = {
            userId: saleData.userId,
            type: 'SALE',
            amount: saleData.totalAmount, // Store the final total
            date: saleData.date,
            description: saleData.description,
            items: saleData.items, // Store the array of items/services
            linkedCustomerId: saleData.linkedCustomerId,
            linkedBankId: saleData.linkedBankId || null,
            paymentMethod: saleData.paymentMethod.toUpperCase(),
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(transactionDoc);
        logger.info(`Sale transaction created successfully with ID: ${result.insertedId}`);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating sale transaction:', error);
        throw new Error('Could not create sale transaction.');
    }
}

export async function createExpenseTransaction(expenseData) {
    try {
        const transactionDoc = {
            userId: expenseData.userId,
            type: 'EXPENSE',
            amount: expenseData.amount,
            date: expenseData.date,
            description: expenseData.description,
            category: expenseData.category,
            linkedBankId: expenseData.linkedBankId || null,
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(transactionDoc);
        logger.info(`Expense transaction created successfully with ID: ${result.insertedId}`);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating expense transaction:', error);
        throw new Error('Could not create expense transaction.');
    }
}

export async function createCustomerPaymentTransaction(paymentData) {
    try {
        const transactionDoc = {
            userId: paymentData.userId,
            type: 'CUSTOMER_PAYMENT',
            amount: paymentData.amount,
            date: paymentData.date,
            description: paymentData.description,
            linkedCustomerId: paymentData.linkedCustomerId,
            linkedBankId: paymentData.linkedBankId || null, // Added bank link
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(transactionDoc);
        logger.info(`Customer payment transaction created with ID: ${result.insertedId}`);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating customer payment transaction:', error);
        throw new Error('Could not create customer payment transaction.');
    }
}


export async function getSummaryByDateRange(userId, type, startDate, endDate) {
    try {
        const pipeline = [
            { $match: { userId: userId, type: type, date: { $gte: startDate, $lte: endDate } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ];
        const result = await transactionsCollection().aggregate(pipeline).toArray();
        return result.length > 0 ? result[0].total : 0;
    } catch (error) {
        logger.error(`Error getting summary for user ${userId}:`, error);
        throw new Error('Could not retrieve financial summary.');
    }
}

export async function getTransactionsByDateRange(userId, type, startDate, endDate) {
    try {
        const transactions = await transactionsCollection().find({
            userId,
            type,
            date: { $gte: startDate, $lte: endDate }
        }).sort({ date: 1 }).toArray();
        return transactions;
    } catch (error) {
        logger.error(`Error getting transactions for user ${userId}:`, error);
        throw new Error('Could not retrieve transactions.');
    }
}

export async function getRecentTransactions(userId, limit = 5) {
    try {
        const transactions = await transactionsCollection()
            .find({ userId })
            .sort({ date: -1 }) // Sort by date descending
            .limit(limit)
            .toArray();
        return transactions;
    } catch (error) {
        logger.error(`Error fetching recent transactions for user ${userId}:`, error);
        throw new Error('Could not retrieve recent transactions.');
    }
}


export async function findTransactionById(transactionId) {
    try {
        const transaction = await transactionsCollection().findOne({ _id: transactionId });
        return transaction;
    } catch (error) {
        logger.error(`Error finding transaction by ID ${transactionId}:`, error);
        throw new Error('Could not find transaction.');
    }
}

export async function updateTransactionById(transactionId, updateData) {
    try {
        const result = await transactionsCollection().findOneAndUpdate(
            { _id: transactionId },
            { $set: updateData },
            { returnDocument: 'after' }
        );
        return result;
    } catch (error) {
        logger.error(`Error updating transaction ${transactionId}:`, error);
        throw new Error('Could not update transaction.');
    }
}

export async function deleteTransactionById(transactionId) {
    try {
        const result = await transactionsCollection().deleteOne({ _id: transactionId });
        if (result.deletedCount === 1) {
            logger.info(`Successfully deleted transaction with ID: ${transactionId}`);
            return true;
        }
        logger.warn(`Transaction with ID: ${transactionId} not found for deletion.`);
        return false;
    } catch (error) {
        logger.error(`Error deleting transaction by ID ${transactionId}:`, error);
        throw new Error('Could not delete transaction.');
    }
}
