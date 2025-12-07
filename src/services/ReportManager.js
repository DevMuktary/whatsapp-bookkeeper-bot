import { getDB } from '../db/connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb'; // [FIX] Import ObjectId

const transactionsCollection = () => getDB().collection('transactions');

export async function getPnLData(userId, startDate, endDate) {
    try {
        // [FIX] Ensure userId is ObjectId (Critical for Aggregations)
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;

        const pipeline = [
            { 
                $match: { 
                    userId: validUserId, 
                    date: { $gte: startDate, $lte: endDate } 
                } 
            },
            {
                $facet: {
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

export async function getReportTransactions(userId, type, startDate, endDate) {
    // [FIX] Ensure userId is ObjectId
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;

    const query = {
        userId: validUserId,
        type,
        date: { $gte: startDate, $lte: endDate }
    };
    
    return await transactionsCollection().aggregate([
        { $match: query },
        { 
            $lookup: {
                from: 'customers',
                localField: 'linkedCustomerId',
                foreignField: '_id',
                as: 'customerDetails'
            }
        },
        { $unwind: { path: '$customerDetails', preserveNullAndEmptyArrays: true } },
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
