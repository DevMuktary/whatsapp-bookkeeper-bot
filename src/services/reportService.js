import { ReportGenerators } from '../utils/reportGenerator.js';
import { sendDocument } from './whatsappService.js';

// ==================================================================
// --- 1. DATA-FETCHING FUNCTIONS (Internal) ---
// ==================================================================

/**
 * --- Fetches data for a Transaction Report ---
 */
async function getTransactionData(collections, userId) {
    const { transactionsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: userId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const transactions = await transactionsCollection.find({ 
        userId: userId, 
        createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
    }).sort({ createdAt: 1 }).toArray();
    
    if (transactions.length === 0) {
        throw new Error("No transactions found for this month.");
    }
    
    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    return { transactions, monthName, user };
}

/**
 * --- Fetches data for an Inventory Report ---
 */
async function getInventoryData(collections, userId) {
    const { productsCollection, inventoryLogsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: userId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const products = await productsCollection.find({ userId: userId }).toArray();
    const logs = await inventoryLogsCollection.find({ 
        userId: userId, 
        createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
    }).sort({ createdAt: 1 }).toArray();

    if (products.length === 0) {
        throw new Error("No products to report on.");
    }

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    return { products, logs, monthName, user };
}

/**
 * --- Fetches data for a P&L Report ---
 */
async function getPnLData(collections, userId) {
    const { transactionsCollection, inventoryLogsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: userId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    const income = await transactionsCollection.aggregate([
        { $match: { userId: userId, type: 'income', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, 
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    
    const totalRevenue = income[0]?.total || 0;
    
    const expensesResult = await transactionsCollection.find({ 
        userId: userId, 
        type: 'expense', 
        category: { $ne: 'Cost of Goods Sold' }, 
        createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
    }).toArray();
    
    if (totalRevenue === 0 && expensesResult.length === 0) {
        throw new Error("No financial activity found for this month.");
    }
    
    const cogsLogs = await inventoryLogsCollection.aggregate([
        { $match: { userId: userId, type: 'sale', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, 
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'productInfo' } }, 
        { $unwind: '$productInfo' }, 
        { $group: { _id: null, total: { $sum: { $multiply: [{ $abs: '$quantityChange' }, '$productInfo.cost'] } } } }
    ]).toArray();
    
    const cogs = cogsLogs[0]?.total || 0;
    
    const expensesByCategory = {};
    expensesResult.forEach(exp => {
        const category = exp.category || 'Uncategorized';
        if (!expensesByCategory[category]) expensesByCategory[category] = 0;
        expensesByCategory[category] += exp.amount;
    });
    
    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    return { data: { totalRevenue, cogs, expensesByCategory }, monthName, user };
}


// ==================================================================
// --- 2. API-FACING FUNCTIONS ---
// ==================================================================

export async function getTransactionReportAsBuffer(collections, userId) {
    const { transactions, monthName, user } = await getTransactionData(collections, userId);
    const pdfBuffer = await ReportGenerators.createMonthlyReportPDF(transactions, monthName, user);
    return pdfBuffer;
}

export async function getInventoryReportAsBuffer(collections, userId) {
    const { products, logs, monthName, user } = await getInventoryData(collections, userId);
    const pdfBuffer = await ReportGenerators.createInventoryReportPDF(products, logs, monthName, user);
    return pdfBuffer;
}

export async function getPnLReportAsBuffer(collections, userId) {
    const { data, monthName, user } = await getPnLData(collections, userId);
    const pdfBuffer = await ReportGenerators.createPnLReportPDF(data, monthName, user);
    return pdfBuffer;
}


// ==================================================================
// --- 3. BOT-FACING FUNCTIONS (MIGRATED) ---
// ==================================================================

export async function generateTransactionReport(args, collections, senderId) {
    try {
        const { transactions, monthName, user } = await getTransactionData(collections, senderId);
        const pdfBuffer = await ReportGenerators.createMonthlyReportPDF(transactions, monthName, user);
        
        await sendDocument(
            senderId, 
            pdfBuffer, 
            `Financial_Report_${monthName.replace(/ /g, '_')}.pdf`,
            `Here is your financial report for ${monthName}.`
        );
        return { success: true, message: "Transaction report has been sent." };
    } catch (error) {
        console.error('Error generating transaction report:', error);
        return { success: false, message: error.message || 'Failed to generate transaction report' };
    }
}

export async function generateInventoryReport(args, collections, senderId) {
    try {
        const { products, logs, monthName, user } = await getInventoryData(collections, senderId);
        const pdfBuffer = await ReportGenerators.createInventoryReportPDF(products, logs, monthName, user);
        
        await sendDocument(
            senderId,
            pdfBuffer,
            `Inventory_Report_${monthName.replace(/ /g, '_')}.pdf`,
            `Here is your inventory and profit report.`
        );
        return { success: true, message: "Inventory report has been sent." };
    } catch (error) {
        console.error('Error generating inventory report:', error);
        return { success: false, message: error.message || 'Failed to generate inventory report' };
    }
}

export async function generatePnLReport(args, collections, senderId) {
    try {
        const { data, monthName, user } = await getPnLData(collections, senderId);
        const pdfBuffer = await ReportGenerators.createPnLReportPDF(data, monthName, user);
        
        await sendDocument(
            senderId,
            pdfBuffer,
            `P&L_Report_${monthName.replace(/ /g, '_')}.pdf`,
            `Here is your Profit & Loss Statement.`
        );
        return { success: true, message: "P&L report has been sent." };
    } catch (error) {
        console.error('Error generating P&L report:', error);
        return { success: false, message: error.message || 'Failed to generate P&L report' };
    }
}
