import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const transactionsCollection = () => getDB().collection('transactions');

export async function createSaleTransaction(saleData) {
    try {
        const transactionDoc = {
            userId: saleData.userId,
            type: 'SALE',
            amount: saleData.totalAmount,
            date: saleData.date,
            description: saleData.description,
            linkedProductId: saleData.linkedProductId,
            linkedCustomerId: saleData.linkedCustomerId,
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

/**
 * Fetches all transactions for a given type and date range.
 * @param {ObjectId} userId The user's _id.
 * @param {string} type 'SALE' or 'EXPENSE'.
 * @param {Date} startDate The start of the date range.
 * @param {Date} endDate The end of the date range.
 * @returns {Promise<Array<object>>} An array of transaction documents.
 */
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
