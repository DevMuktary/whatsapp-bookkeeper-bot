import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const transactionsCollection = () => getDB().collection('transactions');

/**
 * Creates a new sale transaction in the database.
 * @param {object} saleData - The data for the sale.
 * @returns {Promise<object>} The newly created transaction document.
 */
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

/**
 * Creates a new expense transaction in the database.
 * @param {object} expenseData - The data for the expense.
 * @returns {Promise<object>} The newly created transaction document.
 */
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

/**
 * Calculates the sum of transactions for a given type and date range.
 * @param {ObjectId} userId The user's _id.
 * @param {string} type 'SALE' or 'EXPENSE'.
 * @param {Date} startDate The start of the date range.
 * @param {Date} endDate The end of the date range.
 * @returns {Promise<number>} The total sum of the amounts.
 */
export async function getSummaryByDateRange(userId, type, startDate, endDate) {
    try {
        const pipeline = [
            {
                $match: {
                    userId: userId,
                    type: type,
                    date: {
                        $gte: startDate,
                        $lte: endDate
                    }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$amount" }
                }
            }
        ];

        const result = await transactionsCollection().aggregate(pipeline).toArray();
        
        if (result.length > 0) {
            return result[0].total;
        } else {
            return 0; // Return 0 if no transactions are found
        }
    } catch (error) {
        logger.error(`Error getting summary for user ${userId}:`, error);
        throw new Error('Could not retrieve financial summary.');
    }
}
