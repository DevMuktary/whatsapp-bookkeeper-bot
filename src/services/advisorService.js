import * as S from './accountingService.js'; // <-- THE FIX IS HERE

/**
 * --- BOT TOOL: Get Financial Data for Analysis ---
 * Gathers a complete financial snapshot for the AI to analyze.
 */
export async function getFinancialDataForAnalysis(args, collections, senderId) {
    const { transactionsCollection } = collections;
    
    try {
        // 1. Get the monthly summary
        const summary = await S.getMonthlySummary(null, collections, senderId);

        // 2. Get inventory status
        const inventory = await S.getInventory(null, collections, senderId);

        // 3. Get top 5 expense categories for the month
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

        const topExpenses = await transactionsCollection.aggregate([
            { $match: { 
                userId: senderId, 
                type: 'expense', 
                createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
            }},
            { $group: { 
                _id: "$category", 
                totalAmount: { $sum: "$amount" } 
            }},
            { $sort: { totalAmount: -1 } },
            { $limit: 5 }
        ]).toArray();

        // 4. Compile all data into a single object for the AI
        const analysisData = {
            summary: summary.success ? summary : { message: "No summary data found." },
            inventory: inventory.success ? inventory.products : { message: "No inventory data found." },
            topExpenses: topExpenses.length > 0 ? topExpenses : { message: "No expense data found." }
        };

        // Return the data as a JSON string (as required by AI tools)
        return { success: true, data: JSON.stringify(analysisData) };

    } catch (error) {
        console.error("Error in getFinancialDataForAnalysis:", error);
        return { success: false, message: "An error occurred while gathering data for analysis." };
    }
}
