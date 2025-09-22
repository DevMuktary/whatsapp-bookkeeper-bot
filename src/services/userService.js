import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js'; // <-- NEW IMPORT

/**
 * --- API Endpoint: Get User's Monthly Summary ---
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
 * --- API Endpoint: Get User's Transactions (Paginated) ---
 */
export async function getUserTransactions(req, res, collections) {
    const { transactionsCollection } = collections;
    const userId = req.user.userId;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const { startDate, endDate } = req.query;
    let dateFilter = {};
    if (startDate && endDate) {
        dateFilter.createdAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }

    try {
        const transactions = await transactionsCollection.find({ 
            userId: userId,
            ...dateFilter
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

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
 * --- API Endpoint: Get User's Inventory ---
 */
export async function getUserInventory(req, res, collections) {
    const userId = req.user.userId;

    try {
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

/**
 * --- NEW API Endpoint: Get a Report for the Logged-in User ---
 */
export async function getUserReport(req, res, collections) {
    const { reportType } = req.params;
    const userId = req.user.userId; // Get user ID from the token
    const storeName = req.user.storeName || "report"; // Get storeName from token

    try {
        let pdfBuffer;
        let fileName = `${reportType}_report.pdf`;

        switch (reportType.toLowerCase()) {
            case 'transactions':
                pdfBuffer = await reportService.getTransactionReportAsBuffer(collections, userId);
                fileName = `Financial_Report_${storeName}.pdf`;
                break;
            case 'inventory':
                pdfBuffer = await reportService.getInventoryReportAsBuffer(collections, userId);
                fileName = `Inventory_Report_${storeName}.pdf`;
                break;
            case 'pnl':
                pdfBuffer = await reportService.getPnLReportAsBuffer(collections, userId);
                fileName = `P&L_Report_${storeName}.pdf`;
                break;
            default:
                return res.status(400).json({ message: "Invalid report type. Use 'transactions', 'inventory', or 'pnl'." });
        }
        
        // --- Send the PDF as a download ---
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error(`Error in getUserReport (${reportType}):`, error);
        res.status(404).json({ message: error.message || "Could not generate report." });
    }
}
