import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const transactionsCollection = () => getDB().collection('transactions');

export async function createSaleTransaction(saleData) {
    try {
        const sanitizedItems = saleData.items.map(item => ({
            productId: item.productId ? new ObjectId(item.productId) : null,
            productName: item.productName,
            quantity: item.quantity,
            pricePerUnit: item.pricePerUnit,
            costPrice: item.costPrice || 0,
            isService: item.isService || false
        }));

        const transactionDoc = {
            userId: saleData.userId,
            type: 'SALE',
            amount: saleData.totalAmount,
            date: saleData.date,
            description: saleData.description,
            items: sanitizedItems,
            linkedCustomerId: saleData.linkedCustomerId,
            linkedBankId: saleData.linkedBankId || null,
            paymentMethod: saleData.paymentMethod.toUpperCase(),
            dueDate: saleData.dueDate ? new Date(saleData.dueDate) : null,
            // [NEW] Audit Field
            loggedBy: saleData.loggedBy || 'Owner',
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(transactionDoc);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating sale transaction:', error);
        throw new Error('Could not create sale transaction.');
    }
}

export async function createExpenseTransaction(expenseData) {
    try {
        const doc = {
            userId: expenseData.userId,
            type: 'EXPENSE',
            amount: expenseData.amount,
            date: expenseData.date,
            description: expenseData.description,
            category: expenseData.category,
            linkedBankId: expenseData.linkedBankId || null,
            // [NEW] Audit Field
            loggedBy: expenseData.loggedBy || 'Owner',
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(doc);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating expense transaction:', error);
        throw new Error('Could not create expense transaction.');
    }
}

export async function createCustomerPaymentTransaction(paymentData) {
    try {
        const doc = {
            userId: paymentData.userId,
            type: 'CUSTOMER_PAYMENT',
            amount: paymentData.amount,
            date: paymentData.date,
            description: paymentData.description,
            linkedCustomerId: paymentData.linkedCustomerId,
            linkedBankId: paymentData.linkedBankId || null,
            loggedBy: paymentData.loggedBy || 'Owner', // [NEW]
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(doc);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating customer payment transaction:', error);
        throw new Error('Could not create customer payment transaction.');
    }
}

// ... (Rest of the file remains the same: getSummary, getRecent, getDue, update, delete) ...
// You can copy the rest of the functions from the previous version of this file.
// IMPORTANT: Ensure getDueTransactions, updateTransactionById etc. are kept.

// --- READ / QUERY FUNCTIONS ---

export async function getSummaryByDateRange(userId, type, startDate, endDate) {
    try {
        const pipeline = [
            { $match: { userId, type, date: { $gte: startDate, $lte: endDate } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ];
        const result = await transactionsCollection().aggregate(pipeline).toArray();
        return result.length > 0 ? result[0].total : 0;
    } catch (error) {
        logger.error(`Error getting summary for user ${userId}:`, error);
        throw new Error('Could not retrieve financial summary.');
    }
}

export async function getRecentTransactions(userId, limit = 5) {
    try {
        return await transactionsCollection()
            .find({ userId })
            .sort({ date: -1 })
            .limit(limit)
            .toArray();
    } catch (error) {
        logger.error(`Error fetching recent transactions for user ${userId}:`, error);
        throw new Error('Could not retrieve recent transactions.');
    }
}

export async function getTransactionsByDateRange(userId, type, startDate, endDate) {
    try {
        return await transactionsCollection().find({
            userId,
            type,
            date: { $gte: startDate, $lte: endDate }
        }).sort({ date: 1 }).toArray();
    } catch (error) {
        logger.error(`Error getting transactions for user ${userId}:`, error);
        throw new Error('Could not retrieve transactions.');
    }
}

export async function getDueTransactions(userId, startDate, endDate) {
    try {
        return await transactionsCollection().find({
            userId,
            type: 'SALE',
            paymentMethod: 'CREDIT',
            dueDate: { $gte: startDate, $lte: endDate }
        }).toArray();
    } catch (error) {
        logger.error(`Error getting due transactions for ${userId}:`, error);
        return [];
    }
}

export async function findTransactionById(transactionId) {
    try {
        const id = typeof transactionId === 'string' ? new ObjectId(transactionId) : transactionId;
        return await transactionsCollection().findOne({ _id: id });
    } catch (error) {
        logger.error(`Error finding transaction by ID ${transactionId}:`, error);
        throw new Error('Could not find transaction.');
    }
}

export async function updateTransactionById(transactionId, updateData) {
    try {
        const id = typeof transactionId === 'string' ? new ObjectId(transactionId) : transactionId;
        return await transactionsCollection().findOneAndUpdate(
            { _id: id },
            { $set: updateData },
            { returnDocument: 'after' }
        );
    } catch (error) {
        logger.error(`Error updating transaction ${transactionId}:`, error);
        throw new Error('Could not update transaction.');
    }
}

export async function deleteTransactionById(transactionId) {
    try {
        const id = typeof transactionId === 'string' ? new ObjectId(transactionId) : transactionId;
        const result = await transactionsCollection().deleteOne({ _id: id });
        return result.deletedCount === 1;
    } catch (error) {
        logger.error(`Error deleting transaction by ID ${transactionId}:`, error);
        throw new Error('Could not delete transaction.');
    }
}
