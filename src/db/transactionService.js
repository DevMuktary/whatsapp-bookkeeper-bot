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

/**
 * Creates a new customer payment transaction in the database.
 * @param {object} paymentData - The data for the payment.
 * @param {ObjectId} paymentData.userId
 * @param {ObjectId} paymentData.linkedCustomerId
 * @param {number} paymentData.amount
 * @param {Date} paymentData.date
 * @param {string} paymentData.description
 * @returns {Promise<object>} The newly created transaction document.
 */
export async function createCustomerPaymentTransaction(paymentData) {
    try {
        const transactionDoc = {
            userId: paymentData.userId,
            type: 'CUSTOMER_PAYMENT',
            amount: paymentData.amount,
            date: paymentData.date,
            description: paymentData.description,
            linkedCustomerId: paymentData.linkedCustomerId,
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

export async function findTransactionById(transactionId) {
    try {
        const transaction = await transactionsCollection().findOne({ _id: transactionId });
        return transaction;
    } catch (error) {
        logger.error(`Error finding transaction by ID ${transactionId}:`, error);
        throw new Error('Could not find transaction.');
    }
}
