import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js'; // Direct DB access to bypass strict helpers
import { getAllProducts, findProductByName } from '../db/productService.js';
import { 
    generatePnLReport, 
    generateSalesReport, 
    generateExpenseReport, 
    generateInventoryReport, 
    generateCOGSReport 
} from './pdfService.js';
import { findUserById } from '../db/userService.js';

// Internal helper to get the collection
const getTransactionsCollection = () => getDB().collection('transactions');

// [NEW] Flexible Fetcher: Checks for userId as String AND ObjectId
// This ensures we find data regardless of how the bot saved it.
async function fetchTransactionsFlexible(userId, startDate, endDate) {
    let validObjectId;
    try { validObjectId = new ObjectId(userId); } catch (e) { validObjectId = null; }

    const query = {
        $or: [
            { userId: userId.toString() }, // Case 1: Saved as String
            ...(validObjectId ? [{ userId: validObjectId }] : []) // Case 2: Saved as ObjectId
        ],
        date: { 
            $gte: startDate, 
            $lte: endDate 
        }
    };

    return await getTransactionsCollection().find(query).toArray();
}

/**
 * Aggregates data for the Dashboard Charts (Last 12 Months)
 */
export async function getDashboardStats(userId) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 11); 
    startDate.setDate(1); 

    // Use flexible fetcher
    const transactions = await fetchTransactionsFlexible(userId, startDate, endDate);

    // Initialize map
    const monthlyData = {};
    let tempDate = new Date(startDate);
    while (tempDate <= endDate) {
        const key = tempDate.toLocaleString('default', { month: 'short', year: '2-digit' });
        monthlyData[key] = { name: key, sales: 0, expenses: 0 };
        tempDate.setMonth(tempDate.getMonth() + 1);
    }

    let totalRevenue = 0;
    let totalExpenses = 0;

    transactions.forEach(tx => {
        const dateKey = new Date(tx.date).toLocaleString('default', { month: 'short', year: '2-digit' });
        
        if (monthlyData[dateKey]) {
            if (tx.type === 'SALE') {
                monthlyData[dateKey].sales += tx.amount;
                totalRevenue += tx.amount;
            } else if (tx.type === 'EXPENSE') {
                monthlyData[dateKey].expenses += tx.amount;
                totalExpenses += tx.amount;
            }
        }
    });

    const recentTransactions = transactions
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    return {
        chartData: Object.values(monthlyData), 
        summary: {
            totalRevenue,
            totalExpenses,
            netProfit: totalRevenue - totalExpenses
        },
        recentTransactions
    };
}

/**
 * Generates a Long-Term Report
 */
export async function generateWebReport(userTokenData, type, startDateStr, endDateStr) {
    // Fetch full user details
    const user = await findUserById(userTokenData.userId);
    if (!user) throw new Error("User record not found.");
    if (!user.currency) user.currency = 'NGN'; 

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);

    let transactions = [];
    if (type !== 'inventory') {
        // Use flexible fetcher here too
        transactions = await fetchTransactionsFlexible(userTokenData.userId, startDate, endDate);
    }
    
    const periodTitle = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
    let pdfBuffer;

    if (type === 'sales') {
        const sales = transactions.filter(t => t.type === 'SALE');
        pdfBuffer = await generateSalesReport(user, sales, periodTitle);

    } else if (type === 'expenses') {
        const expenses = transactions.filter(t => t.type === 'EXPENSE');
        pdfBuffer = await generateExpenseReport(user, expenses, periodTitle);

    } else if (type === 'inventory') {
        let validObjectId;
        try { validObjectId = new ObjectId(userTokenData.userId); } catch (e) { validObjectId = null; }
        
        // Use either ID format for inventory lookup
        const lookupId = validObjectId || userTokenData.userId;
        const products = await getAllProducts(lookupId);
        pdfBuffer = await generateInventoryReport(user, products);

    } else if (type === 'cogs') {
        const sales = transactions.filter(t => t.type === 'SALE');
        const cogsItems = [];
        
        let validObjectId;
        try { validObjectId = new ObjectId(userTokenData.userId); } catch (e) { validObjectId = null; }
        const lookupId = validObjectId || userTokenData.userId;

        for (const sale of sales) {
            if (sale.items) {
                for (const item of sale.items) {
                    if (item.productId && !item.isService) { 
                        const product = await findProductByName(lookupId, item.productName); 
                        const costPrice = (product && product.costPrice != null) ? product.costPrice : 0;
                        
                        cogsItems.push({
                            date: sale.date,
                            productName: item.productName,
                            quantity: item.quantity,
                            costPrice: costPrice,
                            totalCost: costPrice * item.quantity
                        });
                    }
                }
            }
        }
        pdfBuffer = await generateCOGSReport(user, cogsItems, periodTitle);

    } else if (type === 'pnl') {
        const salesTotal = transactions.filter(t => t.type === 'SALE').reduce((sum, t) => sum + t.amount, 0);
        const expensesTotal = transactions.filter(t => t.type === 'EXPENSE').reduce((sum, t) => sum + t.amount, 0);
        
        let cogsTotal = 0;
        let validObjectId;
        try { validObjectId = new ObjectId(userTokenData.userId); } catch (e) { validObjectId = null; }
        const lookupId = validObjectId || userTokenData.userId;

        const sales = transactions.filter(t => t.type === 'SALE');
        for (const sale of sales) {
            if (sale.items) {
                for (const item of sale.items) {
                    if (item.productId && !item.isService) {
                        const product = await findProductByName(lookupId, item.productName);
                        if (product) cogsTotal += (product.costPrice * item.quantity);
                    }
                }
            }
        }
        
        const expenseMap = {};
        transactions.filter(t => t.type === 'EXPENSE').forEach(t => {
            expenseMap[t.category] = (expenseMap[t.category] || 0) + t.amount;
        });
        const topExpenses = Object.entries(expenseMap)
            .sort(([, a], [, b]) => b - a)
            .map(([category, total]) => ({ _id: category, total }));

        const pnlData = {
            totalSales: salesTotal,
            totalCogs: cogsTotal,
            grossProfit: salesTotal - cogsTotal,
            totalExpenses: expensesTotal,
            netProfit: (salesTotal - cogsTotal) - expensesTotal,
            topExpenses
        };

        pdfBuffer = await generatePnLReport(user, pnlData, periodTitle);
    }

    return pdfBuffer;
}


