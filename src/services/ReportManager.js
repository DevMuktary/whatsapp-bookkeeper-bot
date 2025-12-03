import { getDB } from '../db/connection.js';
import logger from '../utils/logger.js';

const transactionsCollection = () => getDB().collection('transactions');

/**
 * Calculates Profit & Loss using Aggregation Framework.
 * Extremely fast compared to JS looping.
 */
export async function getPnLData(userId, startDate, endDate) {
    try {
        const pipeline = [
            { 
                $match: { 
                    userId: userId, 
                    date: { $gte: startDate, $lte: endDate } 
                } 
            },
            {
                $facet: {
                    // 1. Calculate Total Sales & Gross COGS
                    salesStats: [
                        { $match: { type: 'SALE' } },
                        { $unwind: "$items" },
                        {
                            $group: {
                                _id: null,
                                totalRevenue: { $sum: { $multiply: ["$items.quantity", "$items.pricePerUnit"] } },
                                totalCOGS: { $sum: { $multiply: ["$items.quantity", "$items.costPrice"] } } // Uses the snapshot!
                            }
                        }
                    ],
                    // 2. Calculate Expenses by Category
                    expensesStats: [
                        { $match: { type: 'EXPENSE' } },
                        {
                            $group: {
                                _id: "$category",
                                total: { $sum: "$amount" }
                            }
                        },
                        { $sort: { total: -1 } }
                    ],
                    // 3. Total Expense Sum
                    totalExpenseSum: [
                        { $match: { type: 'EXPENSE' } },
                        { $group: { _id: null, total: { $sum: "$amount" } } }
                    ]
                }
            }
        ];

        const results = await transactionsCollection().aggregate(pipeline).toArray();
        const data = results[0];

        const totalSales = data.salesStats[0]?.totalRevenue || 0;
        const totalCogs = data.salesStats[0]?.totalCOGS || 0;
        const totalExpenses = data.totalExpenseSum[0]?.total || 0;
        const topExpenses = data.expensesStats.map(e => ({ category: e._id, amount: e.total }));

        const grossProfit = totalSales - totalCogs;
        const netProfit = grossProfit - totalExpenses;

        return {
            totalSales,
            totalCogs,
            totalExpenses,
            grossProfit,
            netProfit,
            topExpenses
        };

    } catch (error) {
        logger.error(`Error calculating PnL for user ${userId}:`, error);
        throw new Error('Could not calculate Profit and Loss data.');
    }
}

/**
 * Fetches raw transaction list for detailed PDF reports (Sales/Expenses).
 */
export async function getReportTransactions(userId, type, startDate, endDate) {
    const query = {
        userId,
        type,
        date: { $gte: startDate, $lte: endDate }
    };
    
    // If it's a sales report, we might want to lookup customer names efficiently
    // But for simplicity, we'll assume customerName is snapshot/cached or we fetch normally.
    // Ideally, perform a $lookup here if linkedCustomerId exists.
    
    return await transactionsCollection()
        .find(query)
        .sort({ date: 1 })
        .toArray();
}
