import * as accountingService from './accountingService.js';

/**
 * --- API Endpoint: Get User's Monthly Summary ---
 * Fetches the financial summary for the *logged-in* user.
 */
export async function getUserSummary(req, res, collections) {
    try {
        const senderId = req.user.userId; 

        const summaryData = await accountingService.getMonthlySummary(null, collections, senderId);

        if (summaryData.success) {
            res.status(200).json({
                month: summaryData.month,
                income: summaryData.income,
                expense: summaryData.expense,
                net: summaryData.net,
                currency: summaryData.currency
            });
        } else {
            res.status(404).json({ message: summaryData.message });
        }
    } catch (error) {
        console.error("Error in getUserSummary:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}

/**
 * --- NEW API Endpoint: Get User's Transactions (Paginated) ---
 * Fetches a paginated list of transactions for the logged-in user.
 */
export async function getUserTransactions(req, res, collections) {
    const { transactionsCollection } = collections;
    const userId = req.user.userId;

    // --- Pagination Logic ---
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // --- Date Filtering Logic (Optional but good for reports) ---
    const { startDate, endDate } = req.query;
    let dateFilter = {};
    if (startDate && endDate) {
        dateFilter.createdAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }
    // --- End Filtering ---

    try {
        // Get the requested page of transactions
        const transactions = await transactionsCollection.find({ 
            userId: userId,
            ...dateFilter // Add the date filter if it exists
        })
        .sort({ createdAt: -1 }) // Show newest first
        .skip(skip)
        .limit(limit)
        .toArray();

        // Get the total number of transactions to calculate total pages
        const totalTransactions = await transactionsCollection.countDocuments({ 
            userId: userId,
            ...dateFilter 
        });

        res.status(200).json({
            currentPage: page,
            totalPages: Math.ceil(totalTransactions / limit),
            totalTransactions: totalTransactions,
            transactions: transactions
        });
    } catch (error) {
        console.error("Error in getUserTransactions:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}

/**
 * --- NEW API Endpoint: Get User's Inventory ---
 * Fetches the current inventory for the logged-in user.
 */
export async function getUserInventory(req, res, collections) {
    const userId = req.user.userId;

    try {
        // We re-use the bot's function again!
        const inventoryData = await accountingService.getInventory(null, collections, userId);

        if (inventoryData.success) {
            res.status(200).json({
                currency: inventoryData.currency,
                products: inventoryData.products
            });
        } else {
            res.status(404).json({ message: inventoryData.message });
        }
    } catch (error) {
        console.error("Error in getUserInventory:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}
