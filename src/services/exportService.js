import * as XLSX from 'xlsx';
import { getTransactionsByDateRange } from '../db/transactionService.js';
import { getAllProducts } from '../db/productService.js';
import { getCustomersWithBalance } from '../db/customerService.js';
import logger from '../utils/logger.js';

/**
 * Generates a comprehensive Excel export for the user.
 * Includes Sheets: Transactions, Inventory, Debtors.
 */
export async function generateDataExport(userId, startDate, endDate) {
    try {
        const workbook = XLSX.utils.book_new();

        // --- SHEET 1: TRANSACTIONS ---
        // Fetch all types
        const sales = await getTransactionsByDateRange(userId, 'SALE', startDate, endDate);
        const expenses = await getTransactionsByDateRange(userId, 'EXPENSE', startDate, endDate);
        const payments = await getTransactionsByDateRange(userId, 'CUSTOMER_PAYMENT', startDate, endDate);

        // Combine and Sort by Date
        const allTx = [...sales, ...expenses, ...payments].sort((a, b) => new Date(a.date) - new Date(b.date));

        const txData = allTx.map(tx => ({
            Date: new Date(tx.date).toLocaleDateString('en-GB'), // DD/MM/YYYY
            Type: tx.type,
            Amount: tx.amount,
            Description: tx.description,
            Category: tx.category || '-',
            PaymentMethod: tx.paymentMethod || '-',
            LoggedBy: tx.loggedBy || 'Owner'
        }));

        const txSheet = XLSX.utils.json_to_sheet(txData);
        XLSX.utils.book_append_sheet(workbook, txSheet, 'Transactions');

        // --- SHEET 2: INVENTORY ---
        const products = await getAllProducts(userId);
        const prodData = products.map(p => ({
            Product: p.productName,
            Quantity: p.quantity,
            CostPrice: p.costPrice,
            SellingPrice: p.sellingPrice,
            Value: p.quantity * p.costPrice,
            ReorderLevel: p.reorderLevel || 5
        }));

        const prodSheet = XLSX.utils.json_to_sheet(prodData);
        XLSX.utils.book_append_sheet(workbook, prodSheet, 'Inventory');

        // --- SHEET 3: DEBTORS (Customers owing money) ---
        const debtors = await getCustomersWithBalance(userId);
        const debtData = debtors.map(c => ({
            Customer: c.customerName,
            BalanceOwed: c.balanceOwed,
            LastActivity: new Date(c.updatedAt).toLocaleDateString('en-GB')
        }));

        const debtSheet = XLSX.utils.json_to_sheet(debtData);
        XLSX.utils.book_append_sheet(workbook, debtSheet, 'Debtors List');

        // Generate Buffer
        return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    } catch (error) {
        logger.error(`Error generating export for user ${userId}:`, error);
        throw new Error('Could not generate Excel file.');
    }
}
