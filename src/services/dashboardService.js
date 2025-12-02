import { getTransactionsByDateRange } from '../db/transactionService.js';
import { getDateRange } from '../utils/dateUtils.js';
import { generatePnLReport, generateSalesReport } from './pdfService.js';
import { findOrCreateUser } from '../db/userService.js';

/**
 * Aggregates data for the Dashboard Charts (Last 12 Months)
 */
export async function getDashboardStats(userId) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 11); // Go back 12 months
    startDate.setDate(1); // Start from 1st of that month

    // Fetch all transactions for the year
    const transactions = await getTransactionsByDateRange(userId, null, startDate, endDate);

    // Initialize map for 12 months
    const monthlyData = {};
    for (let d = new Date(startDate); d <= endDate; d.setMonth(d.getMonth() + 1)) {
        const key = d.toLocaleString('default', { month: 'short', year: '2-digit' }); // e.g. "Jan 24"
        monthlyData[key] = { name: key, sales: 0, expenses: 0 };
    }

    // Aggregate Data
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

    // Get Recent 5 Transactions for display
    recentTransactions = transactions
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    return {
        chartData: Object.values(monthlyData), // Array for Recharts/Chart.js
        summary: {
            totalRevenue,
            totalExpenses,
            netProfit: totalRevenue - totalExpenses
        },
        recentTransactions
    };
}

/**
 * Generates a Long-Term Report (1 to 10 Years)
 */
export async function generateWebReport(userId, type, startDateStr, endDateStr) {
    const user = await findOrCreateUser(userId); // Need user details for PDF header
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    
    // Set End Date to end of day
    endDate.setHours(23, 59, 59, 999);

    const transactions = await getTransactionsByDateRange(userId, null, startDate, endDate);
    const periodTitle = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;

    let pdfBuffer;

    if (type === 'sales') {
        const sales = transactions.filter(t => t.type === 'SALE');
        pdfBuffer = await generateSalesReport(user, sales, periodTitle);
    } else if (type === 'expenses') {
        const expenses = transactions.filter(t => t.type === 'EXPENSE');
        pdfBuffer = await generateExpenseReport(user, expenses, periodTitle);
    } else if (type === 'pnl') {
        // Reuse PnL Logic manually here to avoid circular dependencies
        const salesTotal = transactions.filter(t => t.type === 'SALE').reduce((sum, t) => sum + t.amount, 0);
        const expensesTotal = transactions.filter(t => t.type === 'EXPENSE').reduce((sum, t) => sum + t.amount, 0);
        
        // Simple Cost of Sales (COGS) approximation for PnL
        // (In a real app, you'd calculate this strictly item by item like in taskHandler)
        let cogsTotal = 0; 
        
        // Build Expense Categories
        const expenseMap = {};
        transactions.filter(t => t.type === 'EXPENSE').forEach(t => {
            expenseMap[t.category] = (expenseMap[t.category] || 0) + t.amount;
        });
        const topExpenses = Object.entries(expenseMap)
            .sort(([, a], [, b]) => b - a)
            .map(([category, total]) => ({ _id: category, total }));

        const pnlData = {
            totalSales: salesTotal,
            totalCogs: cogsTotal, // You can refine this by fetching items if needed
            grossProfit: salesTotal - cogsTotal,
            totalExpenses: expensesTotal,
            netProfit: (salesTotal - cogsTotal) - expensesTotal,
            topExpenses
        };

        pdfBuffer = await generatePnLReport(user, pnlData, periodTitle);
    }

    return pdfBuffer;
}

