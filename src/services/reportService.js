import { ReportGenerators } from '../utils/reportGenerator.js';

/**
 * Generates and sends a PDF report of all transactions for the current month.
 */
export async function generateTransactionReport(args, collections, senderId, sock) {
    const { transactionsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const transactions = await transactionsCollection.find({ 
            userId: senderId, 
            createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
        }).sort({ createdAt: 1 }).toArray();
        
        if (transactions.length === 0) {
            return { success: false, message: "No transactions found for this month." };
        }
        
        const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
        const pdfBuffer = await ReportGenerators.createMonthlyReportPDF(transactions, monthName, user);
        
        await sock.sendMessage(senderId, { 
            document: pdfBuffer, 
            mimetype: 'application/pdf', 
            fileName: `Financial_Report_${monthName.replace(/ /g, '_')}.pdf`, 
            caption: `Here is your financial report for ${monthName}.` 
        });
        
        return { success: true, message: "Transaction report has been sent." };
    } catch (error) {
        console.error('Error generating transaction report:', error);
        return { success: false, message: 'Failed to generate transaction report' };
    }
}

/**
 * Generates and sends a PDF report for inventory and profit.
 */
export async function generateInventoryReport(args, collections, senderId, sock) {
    const { productsCollection, inventoryLogsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const products = await productsCollection.find({ userId: senderId }).toArray();
        const logs = await inventoryLogsCollection.find({ 
            userId: senderId, 
            createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
        }).sort({ createdAt: 1 }).toArray();
        
        if (products.length === 0) {
            return { success: false, message: "No products to report on." };
        }
        
        const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
        const pdfBuffer = await ReportGenerators.createInventoryReportPDF(products, logs, monthName, user);
        
        await sock.sendMessage(senderId, { 
            document: pdfBuffer, 
            mimetype: 'application/pdf', 
            fileName: `Inventory_Report_${monthName.replace(/ /g, '_')}.pdf`, 
            caption: `Here is your inventory and profit report.` 
        });
        
        return { success: true, message: "Inventory report has been sent." };
    } catch (error)
 {
        console.error('Error generating inventory report:', error);
        return { success: false, message: 'Failed to generate inventory report' };
    }
}

/**
 * Generates and sends a PDF Profit & Loss statement.
 */
export async function generatePnLReport(args, collections, senderId, sock) {
    const { transactionsCollection, inventoryLogsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        
        const income = await transactionsCollection.aggregate([
            { $match: { userId: senderId, type: 'income', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, 
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]).toArray();
        
        const totalRevenue = income[0]?.total || 0;
        
        const expensesResult = await transactionsCollection.find({ 
            userId: senderId, 
            type: 'expense', 
            category: { $ne: 'Cost of Goods Sold' }, 
            createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
        }).toArray();
        
        if (totalRevenue === 0 && expensesResult.length === 0) {
            return { success: false, message: "No financial activity found for this month." };
        }
        
        const cogsLogs = await inventoryLogsCollection.aggregate([
            { $match: { userId: senderId, type: 'sale', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, 
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
        const pdfBuffer = await ReportGenerators.createPnLReportPDF({ totalRevenue, cogs, expensesByCategory }, monthName, user);
        
        await sock.sendMessage(senderId, { 
            document: pdfBuffer, 
            mimetype: 'application/pdf', 
            fileName: `P&L_Report_${monthName.replace(/ /g, '_')}.pdf`, 
            caption: `Here is your Profit & Loss Statement.` 
        });
        
        return { success: true, message: "P&L report has been sent." };
    } catch (error) {
        console.error('Error generating P&L report:', error);
        return { success: false, message: 'Failed to generate P&L report' };
    }
}
