import { ObjectId } from 'mongodb'; // [FIX] Import ObjectId
import { getTransactionsByDateRange } from '../db/transactionService.js';
import { getAllProducts, findProductByName } from '../db/productService.js';
import { 
    generatePnLReport, 
    generateSalesReport, 
    generateExpenseReport, 
    generateInventoryReport, 
    generateCOGSReport 
} from './pdfService.js';
import { findOrCreateUser } from '../db/userService.js';

/**
 * Aggregates data for the Dashboard Charts (Last 12 Months)
 */
export async function getDashboardStats(userId) {
    // [FIX] Convert String ID to ObjectId for Database Query
    const validUserId = new ObjectId(userId);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 11); // Go back 12 months
    startDate.setDate(1); // Start from 1st of that month

    // Fetch all transactions for the year
    const transactions = await getTransactionsByDateRange(validUserId, null, startDate, endDate);

    // Initialize map for 12 months (Robust Date Logic)
    const monthlyData = {};
    let tempDate = new Date(startDate);
    while (tempDate <= endDate) {
        const key = tempDate.toLocaleString('default', { month: 'short', year: '2-digit' });
        monthlyData[key] = { name: key, sales: 0, expenses: 0 };
        tempDate.setMonth(tempDate.getMonth() + 1);
    }

    // Aggregate Data
    let totalRevenue = 0;
    let totalExpenses = 0;
    let recentTransactions = [];

    transactions.forEach(tx => {
        const dateKey = new Date(tx.date).toLocaleString('default', { month: 'short', year: '2-digit' });
        
        // Only aggregate if it falls within our chart buckets
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
 * Generates a Long-Term Report (1 to 10 Years)
 */
export async function generateWebReport(userId, type, startDateStr, endDateStr) {
    // [FIX] Convert ID here too
    const validUserId = new ObjectId(userId);
    
    // We pass the RAW phone/string to findOrCreateUser because that function expects a phone string, NOT an ObjectId
    // But for transactions, we need the ObjectId.
    // Let's re-fetch the user to get the clean object.
    const user = await findOrCreateUser(userId.toString()); // Ensure string for user lookup if that's how your DB works
    
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    
    // Set End Date to end of day
    endDate.setHours(23, 59, 59, 999);

    // If it's NOT Inventory, fetch transactions first using the VALID ObjectId
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
        // Inventory uses validUserId
        const products = await getAllProducts(validUserId);
        pdfBuffer = await generateInventoryReport(user, products);

    } else if (type === 'cogs') {
        // Cost of Sales Logic
        const sales = transactions.filter(t => t.type === 'SALE');
        const cogsItems = [];
        
        for (const sale of sales) {
            if (sale.items && sale.items.length > 0) {
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
