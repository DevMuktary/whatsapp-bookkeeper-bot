import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const transactionsCollection = () => getDB().collection('transactions');

/**
 * Creates a new sale transaction in the database.
 * @param {object} saleData - The data for the sale.
 * @param {ObjectId} saleData.userId
 * @param {number} saleData.totalAmount
 * @param {Date} saleData.date
 * @param {string} saleData.description
 * @param {ObjectId} saleData.linkedProductId
 * @param {ObjectId} saleData.linkedCustomerId
 * @param {string} saleData.paymentMethod - 'CASH', 'CREDIT', 'BANK'
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
 * @param {ObjectId} expenseData.userId
 * @param {number} expenseData.amount
 * @param {Date} expenseData.date
 * @param {string} expenseData.description
 * @param {string} expenseData.category - e.g., 'Logistics', 'Utilities'
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
