import { getDB } from '../db/connection.js';
import logger from '../utils/logger.js';

const transactionsCollection = () => getDB().collection('transactions');

/**
 * Calculates Profit & Loss using Aggregation Framework.
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
                                totalCOGS: { $sum: { $multiply: ["$items.quantity", "$items.costPrice"] } } 
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
 * [UPDATED] Now joins with Customers collection to get real names.
 */
export async function getReportTransactions(userId, type, startDate, endDate) {
    const query = {
        userId,
        type,
        date: { $gte: startDate, $lte: endDate }
    };
    
    return await transactionsCollection().aggregate([
        { $match: query },
        // Join with customers table
        { 
            $lookup: {
                from: 'customers',
                localField: 'linkedCustomerId',
                foreignField: '_id',
                as: 'customerDetails'
            }
        },
        // Unwind the array (preserve if no customer found)
        { $unwind: { path: '$customerDetails', preserveNullAndEmptyArrays: true } },
        // Project final shape
        {
            $project: {
                date: 1,
                type: 1,
                amount: 1,
                description: 1,
                category: 1,
                items: 1,
                // Use real name if found, else default to 'Walk-in'
                customerName: { $ifNull: ['$customerDetails.customerName', 'Walk-in'] }
            }
        },
        { $sort: { date: 1 } }
    ]).toArray();
}
