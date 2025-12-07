import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const transactionsCollection = () => getDB().collection('transactions');

// Helper to validate Data
function validateTransactionData(data, type) {
    const errors = [];
    if (!data.userId) errors.push("Missing User ID");
    
    if (type === 'SALE') {
        if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
            errors.push("Sale must have items");
        }
        if (typeof data.amount !== 'number' || data.amount < 0) errors.push("Invalid total amount");
    }

    if (type === 'EXPENSE') {
        if (!data.amount || typeof data.amount !== 'number') errors.push("Expense amount invalid");
        if (!data.description) errors.push("Expense description missing");
        if (!data.category) errors.push("Expense category missing");
    }

    if (errors.length > 0) throw new Error(`Validation Failed: ${errors.join(', ')}`);
}

export async function createSaleTransaction(saleData) {
    try {
        const sanitizedItems = saleData.items.map(item => ({
            productId: item.productId ? new ObjectId(item.productId) : null,
            productName: item.productName || 'Unknown',
            quantity: Number(item.quantity) || 0,
            pricePerUnit: Number(item.pricePerUnit) || 0,
            costPrice: Number(item.costPrice) || 0,
            isService: item.isService || false
        }));

        const transactionDoc = {
            userId: new ObjectId(saleData.userId), // [FIX]
            type: 'SALE',
            amount: Number(saleData.totalAmount) || 0,
            date: saleData.date || new Date(),
            description: saleData.description || 'Sale',
            items: sanitizedItems,
            linkedCustomerId: saleData.linkedCustomerId ? new ObjectId(saleData.linkedCustomerId) : null, // [FIX]
            linkedBankId: saleData.linkedBankId ? new ObjectId(saleData.linkedBankId) : null, // [FIX]
            paymentMethod: saleData.paymentMethod ? saleData.paymentMethod.toUpperCase() : 'CASH',
            dueDate: saleData.dueDate ? new Date(saleData.dueDate) : null,
            loggedBy: saleData.loggedBy || 'Owner',
            createdAt: new Date()
        };

        validateTransactionData(transactionDoc, 'SALE');

        const result = await transactionsCollection().insertOne(transactionDoc);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating sale transaction:', error);
        throw error;
    }
}

export async function createExpenseTransaction(expenseData) {
    try {
        const doc = {
            userId: new ObjectId(expenseData.userId),
            type: 'EXPENSE',
            amount: Number(expenseData.amount),
            date: expenseData.date || new Date(),
            description: expenseData.description,
            category: expenseData.category,
            linkedBankId: expenseData.linkedBankId ? new ObjectId(expenseData.linkedBankId) : null,
            loggedBy: expenseData.loggedBy || 'Owner',
            createdAt: new Date()
        };

        validateTransactionData(doc, 'EXPENSE');

        const result = await transactionsCollection().insertOne(doc);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating expense transaction:', error);
        throw error;
    }
}

export async function createCustomerPaymentTransaction(paymentData) {
    try {
        if (!paymentData.amount || isNaN(paymentData.amount)) throw new Error("Invalid Payment Amount");

        const doc = {
            userId: new ObjectId(paymentData.userId),
            type: 'CUSTOMER_PAYMENT',
            amount: Number(paymentData.amount),
            date: paymentData.date || new Date(),
            description: paymentData.description,
            linkedCustomerId: paymentData.linkedCustomerId ? new ObjectId(paymentData.linkedCustomerId) : null,
            linkedBankId: paymentData.linkedBankId ? new ObjectId(paymentData.linkedBankId) : null,
            loggedBy: paymentData.loggedBy || 'Owner',
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(doc);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating customer payment transaction:', error);
        throw error;
    }
}

// --- READ / QUERY FUNCTIONS ---

export async function getSummaryByDateRange(userId, type, startDate, endDate) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        const pipeline = [
            { $match: { userId: validUserId, type, date: { $gte: startDate, $lte: endDate } } },
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
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        return await transactionsCollection()
            .find({ userId: validUserId })
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
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        return await transactionsCollection().find({
            userId: validUserId,
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
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        return await transactionsCollection().find({
            userId: validUserId,
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
        // [FIX] Handle string IDs from Buttons
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
