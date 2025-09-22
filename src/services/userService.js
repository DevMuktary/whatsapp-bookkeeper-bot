import * as accountingService from './accountingService.js';

/**
 * --- API Endpoint: Get User's Monthly Summary ---
 * Fetches the financial summary for the *logged-in* user.
 */
export async function getUserSummary(req, res, collections) {
    try {
        // 'req.user' is added by the authenticateToken middleware.
        // This is how we securely know *who* is asking for the data.
        const senderId = req.user.userId; 

        // We re-use the *exact same* function the bot uses!
        // We pass 'null' for args and collections since getMonthlySummary
        // doesn't use them (it uses senderId and collections).
        // Let's re-check the function signature for getMonthlySummary...
        // Ah, it's (args, collections, senderId).
        const summaryData = await accountingService.getMonthlySummary(null, collections, senderId);

        if (summaryData.success) {
            // Send a clean JSON response for the API
            res.status(200).json({
                month: summaryData.month,
                income: summaryData.income,
                expense: summaryData.expense,
                net: summaryData.net,
                currency: summaryData.currency
            });
        } else {
            // This happens if the service function returned success: false
            res.status(404).json({ message: summaryData.message });
        }
    } catch (error) {
        console.error("Error in getUserSummary:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}
