import { ObjectId } from 'mongodb';
import { getTransactionsByDateRange } from '../db/transactionService.js';
import { getAllProducts, findProductByName } from '../db/productService.js';
import { 
    generatePnLReport, 
    generateSalesReport, 
    generateExpenseReport, 
    generateInventoryReport, 
    generateCOGSReport 
} from './pdfService.js';
import { findUserById } from '../db/userService.js'; // [FIX] Use ID lookup

/**
 * Aggregates data for the Dashboard Charts
 */
export async function getDashboardStats(userIdString) {
    // Convert String ID to ObjectId
    let validUserId;
    try {
        validUserId = new ObjectId(userIdString);
    } catch (e) {
        throw new Error("Invalid User ID format");
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 11); 
    startDate.setDate(1); 

    const transactions = await getTransactionsByDateRange(validUserId, null, startDate, endDate);

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
    let recentTransactions = [];

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

    recentTransactions = transactions
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
    const validUserId = new ObjectId(userTokenData.userId);
    
    // [FIX] Use findUserById instead of phone lookup. 
    // This ensures we get the EXACT user record associated with the token.
    const user = await findUserById(userTokenData.userId);
    
    if (!user) {
        throw new Error("User record not found for report generation.");
    }

    // Fallback if currency is missing in DB
    if (!user.currency) user.currency = 'NGN'; 

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);

    let transactions = [];
    if (type !== 'inventory') {
        transactions = await getTransactionsByDateRange(validUserId, null, startDate, endDate);
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
        const products = await getAllProducts(validUserId);
        pdfBuffer = await generateInventoryReport(user, products);

    } else if (type === 'cogs') {
        const sales = transactions.filter(t => t.type === 'SALE');
        const cogsItems = [];
        
        for (const sale of sales) {
            if (sale.items) {
                for (const item of sale.items) {
                    if (item.productId && !item.isService) { 
                        const product = await findProductByName(validUserId, item.productName); 
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
        const sales = transactions.filter(t => t.type === 'SALE');
        for (const sale of sales) {
            if (sale.items) {
                for (const item of sale.items) {
                    if (item.productId && !item.isService) {
                        const product = await findProductByName(validUserId, item.productName);
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


