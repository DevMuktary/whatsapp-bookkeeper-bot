import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const transactionsCollection = () => getDB().collection('transactions');

export async function createSaleTransaction(saleData) {
    try {
        // Ensure costPrice is preserved in the items array
        const sanitizedItems = saleData.items.map(item => ({
            productId: item.productId ? new ObjectId(item.productId) : null,
            productName: item.productName,
            quantity: item.quantity,
            pricePerUnit: item.pricePerUnit,
            costPrice: item.costPrice || 0, // <--- CRITICAL: Store the snapshot
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
            createdAt: new Date()
        };
        const result = await transactionsCollection().insertOne(transactionDoc);
        return await transactionsCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error('Error creating sale transaction:', error);
        throw new Error('Could not create sale transaction.');
    }
}

// ... createExpenseTransaction, createCustomerPaymentTransaction, getSummaryByDateRange ... 
// (These functions remain largely the same, but ensure they handle ObjectId correctly)

export async function createExpenseTransaction(expenseData) {
    const doc = {
        userId: expenseData.userId,
        type: 'EXPENSE',
        amount: expenseData.amount,
        date: expenseData.date,
        description: expenseData.description,
        category: expenseData.category,
        linkedBankId: expenseData.linkedBankId || null,
        createdAt: new Date()
    };
    const result = await transactionsCollection().insertOne(doc);
    return await transactionsCollection().findOne({ _id: result.insertedId });
}

export async function createCustomerPaymentTransaction(paymentData) {
    const doc = {
        userId: paymentData.userId,
        type: 'CUSTOMER_PAYMENT',
        amount: paymentData.amount,
        date: paymentData.date,
        description: paymentData.description,
        linkedCustomerId: paymentData.linkedCustomerId,
        linkedBankId: paymentData.linkedBankId || null,
        createdAt: new Date()
    };
    const result = await transactionsCollection().insertOne(doc);
    return await transactionsCollection().findOne({ _id: result.insertedId });
}

export async function getSummaryByDateRange(userId, type, startDate, endDate) {
    const pipeline = [
        { $match: { userId, type, date: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
    ];
    const result = await transactionsCollection().aggregate(pipeline).toArray();
    return result.length > 0 ? result[0].total : 0;
}

export async function getRecentTransactions(userId, limit) {
    return await transactionsCollection().find({ userId }).sort({ date: -1 }).limit(limit).toArray();
}
