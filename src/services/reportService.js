import { ReportGenerators } from '../utils/reportGenerator.js';
import { sendDocument } from './whatsappService.js';

// --- NEW: Time Frame Parsing Utility ---
// This powerful helper function understands natural language time frames.
function parseTimeFrame(timeFrame) {
    const now = new Date();
    // Set time to the beginning of the day for consistent calculations
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let startDate, endDate;
    let description = "Custom";

    switch (timeFrame.toLowerCase().replace(/\s+/g, '')) {
        case 'today':
            startDate = new Date(today);
            endDate = new Date(today);
            endDate.setHours(23, 59, 59, 999);
            description = "Today";
            break;
        case 'yesterday':
            startDate = new Date(today);
            startDate.setDate(today.getDate() - 1);
            endDate = new Date(startDate);
            endDate.setHours(23, 59, 59, 999);
            description = "Yesterday";
            break;
        case 'thisweek':
            // Assuming week starts on Sunday (day 0)
            startDate = new Date(today);
            startDate.setDate(today.getDate() - today.getDay());
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
            endDate.setHours(23, 59, 59, 999);
            description = "This Week";
            break;
        case 'lastweek':
            startDate = new Date(today);
            startDate.setDate(today.getDate() - today.getDay() - 7);
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
            endDate.setHours(23, 59, 59, 999);
            description = "Last Week";
            break;
        case 'thismonth':
        default: // Default to this month if timeframe is unknown
            startDate = new Date(today.getFullYear(), today.getMonth(), 1);
            endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);
            description = startDate.toLocaleString('default', { month: 'long', year: 'numeric' });
            break;
    }
    return { startDate, endDate, description };
}


// ==================================================================
// --- 1. DATA-FETCHING FUNCTIONS ---
// ==================================================================

// --- NEW: Fetches data for a Sales Report with dynamic dates ---
async function getSalesData(collections, userId, startDate, endDate) {
    const { transactionsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: userId });

    const sales = await transactionsCollection.find({ 
        userId: userId,
        type: 'income', // Only fetch sales transactions
        createdAt: { $gte: startDate, $lte: endDate } 
    }).sort({ createdAt: 1 }).toArray();
    
    if (sales.length === 0) {
        throw new Error(`No sales found for the specified period.`);
    }
    
    return { sales, user };
}

// (Existing data-fetching functions remain unchanged)
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
    
    if (transactions.length === 0) throw new Error("No transactions found for this month.");
    
    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    return { transactions, monthName, user };
}

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

    if (products.length === 0) throw new Error("No products to report on.");

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    return { products, logs, monthName, user };
}

async function getPnLData(collections, userId) {
    const { transactionsCollection, inventoryLogsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: userId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    const income = await transactionsCollection.aggregate([ { $match: { userId: userId, type: 'income', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).toArray();
    const totalRevenue = income[0]?.total || 0;
    const expensesResult = await transactionsCollection.find({ userId: userId, type: 'expense', category: { $ne: 'Cost of Goods Sold' }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).toArray();
    if (totalRevenue === 0 && expensesResult.length === 0) throw new Error("No financial activity found for this month.");
    const cogsLogs = await inventoryLogsCollection.aggregate([{ $match: { userId: userId, type: 'sale', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'productInfo' } }, { $unwind: '$productInfo' }, { $group: { _id: null, total: { $sum: { $multiply: [{ $abs: '$quantityChange' }, '$productInfo.cost'] } } } }]).toArray();
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
// --- 2. BOT-FACING FUNCTIONS ---
// ==================================================================

// --- NEW BOT TOOL: GENERATE SALES REPORT ---
export async function generateSalesReport(args, collections, senderId) {
    const { timeFrame } = args;
    try {
        const { startDate, endDate, description } = parseTimeFrame(timeFrame || 'thismonth');
        
        const { sales, user } = await getSalesData(collections, senderId, startDate, endDate);
        
        // Create a user-friendly date range string for the PDF title
        const dateRangeString = `${description} (${startDate.toLocaleDateString('en-GB')} - ${endDate.toLocaleDateString('en-GB')})`;

        const pdfBuffer = await ReportGenerators.createSalesReportPDF(sales, dateRangeString, user);
        
        await sendDocument(
            senderId, 
            pdfBuffer, 
            `Sales_Report_${description.replace(/ /g, '_')}.pdf`,
            `Here is your sales report for ${description}.`
        );
        return { success: true, message: "Sales report has been sent." };
    } catch (error) {
        console.error('Error generating sales report:', error);
        return { success: false, message: error.message || 'Failed to generate sales report.' };
    }
}


// (Existing bot functions remain unchanged)
export async function generateTransactionReport(args, collections, senderId) {
    try {
        const { transactions, monthName, user } = await getTransactionData(collections, senderId);
        const pdfBuffer = await ReportGenerators.createMonthlyReportPDF(transactions, monthName, user);
        
        await sendDocument(senderId, pdfBuffer, `Financial_Report_${monthName.replace(/ /g, '_')}.pdf`, `Here is your financial report for ${monthName}.`);
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
        
        await sendDocument(senderId, pdfBuffer, `Inventory_Report_${monthName.replace(/ /g, '_')}.pdf`, `Here is your inventory and profit report.`);
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
        
        await sendDocument(senderId, pdfBuffer, `P&L_Report_${monthName.replace(/ /g, '_')}.pdf`, `Here is your Profit & Loss Statement.`);
        return { success: true, message: "P&L report has been sent." };
    } catch (error) {
        console.error('Error generating P&L report:', error);
        return { success: false, message: error.message || 'Failed to generate P&L report' };
    }
}
