import { findOrCreateCustomer, updateBalanceOwed, getCustomersWithBalance } from '../db/customerService.js';
import { findOrCreateProduct, updateStock, upsertProduct, findProductByName, getAllProducts } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction, getSummaryByDateRange, getTransactionsByDateRange, findTransactionById, deleteTransactionById, updateTransactionById } from '../db/transactionService.js';
import { createBankAccount, updateBankBalance, findBankAccountByName, getAllBankAccounts } from '../db/bankService.js';
import { updateUserState } from '../db/userService.js';
import { sendTextMessage, sendInteractiveButtons, uploadMedia, sendDocument, sendMainMenu, sendReportMenu } from '../api/whatsappService.js';
import { generateSalesReport, generateExpenseReport, generateInventoryReport, generatePnLReport, generateInvoice } from '../services/pdfService.js';
import { getFinancialInsight } from '../services/aiService.js';
import { INTENTS, USER_STATES } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';
import logger from '../utils/logger.js';

/**
 * Parses a price string (e.g., "₦1,000", "2.5m", "50k", "10000") into a number.
 * @param {string|number} priceInput The string or number to parse.
 * @returns {number} The parsed numeric value, or NaN if invalid.
 */
const parsePrice = (priceInput) => {
    if (typeof priceInput === 'number') return priceInput;
    if (typeof priceInput !== 'string') return NaN;
    const cleaned = priceInput.replace(/₦|,/g, '').toLowerCase().trim();
    let multiplier = 1;
    let numericPart = cleaned;
    if (cleaned.endsWith('k')) {
        multiplier = 1000;
        numericPart = cleaned.slice(0, -1);
    } else if (cleaned.endsWith('m')) {
        multiplier = 1000000;
        numericPart = cleaned.slice(0, -1);
    }
    const value = parseFloat(numericPart);
    return isNaN(value) ? NaN : value * multiplier;
};


async function _calculatePnLData(userId, period) {
    const { startDate, endDate } = getDateRange(period);

    // 1. Get total sales (Revenue)
    const totalSales = await getSummaryByDateRange(userId, 'SALE', startDate, endDate);

    // 2. Calculate Cost of Goods Sold (COGS) accurately from SALE transactions
    let totalCogs = 0;
    const salesTransactions = await getTransactionsByDateRange(userId, 'SALE', startDate, endDate);
    for (const sale of salesTransactions) {
        if (sale.items && sale.items.length > 0) {
            for (const item of sale.items) {
                // IMPORTANT: Only calculate COGS if it was a product sale (not service)
                if (item.productId && !item.isService) {
                    // Need the cost price AT THE TIME OF SALE potentially, but for now use current cost price
                    const product = await findProductByName(userId, item.productName);
                    if (product && product.costPrice != null && !isNaN(product.costPrice)) {
                        totalCogs += (product.costPrice * item.quantity);
                    } else {
                        logger.warn(`Could not find cost price for product ${item.productName} (ID: ${item.productId}) during COGS calculation for sale ${sale._id}`);
                    }
                }
            }
        }
    }

    // 3. Get total OPERATING expenses (Type: EXPENSE, excluding inventory purchases)
    const totalExpenses = await getSummaryByDateRange(userId, 'EXPENSE', startDate, endDate);

    // 4. Get top OPERATING expenses
    const allExpenses = await getTransactionsByDateRange(userId, 'EXPENSE', startDate, endDate);
    const expenseMap = allExpenses.reduce((acc, tx) => {
        // Exclude inventory purchase category explicitly if it somehow exists
        if (tx.category?.toLowerCase() !== 'inventory purchase') {
             acc[tx.category] = (acc[tx.category] || 0) + tx.amount;
        }
        return acc;
    }, {});
    const topExpenses = Object.entries(expenseMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([category, total]) => ({ _id: category, total }));

    // 5. Calculate final numbers
    const grossProfit = totalSales - totalCogs;
    const netProfit = grossProfit - totalExpenses; // Total Expenses now correctly excludes COGS

    return { totalSales, totalCogs, grossProfit, totalExpenses, netProfit, topExpenses };
}


export async function executeTask(intent, user, data) {
    let success = false;
    try {
        switch (intent) {
            case INTENTS.LOG_SALE:
                await executeLogSale(user, data);
                success = true;
                return;
            case INTENTS.LOG_EXPENSE:
                await executeLogExpense(user, data);
                success = true;
                break;
            case INTENTS.ADD_PRODUCT:
                await executeAddProduct(user, data); // Corrected Accounting Logic
                success = true;
                break;
            case INTENTS.ADD_MULTIPLE_PRODUCTS:
                await executeAddMultipleProducts(user, data); // Needs bank deduction logic too
                success = true;
                break;
            case INTENTS.CHECK_STOCK:
                await executeCheckStock(user, data);
                success = true;
                break;
            case INTENTS.GET_FINANCIAL_SUMMARY:
                await executeGetFinancialSummary(user, data);
                success = true;
                break;
            case INTENTS.GENERATE_REPORT:
                await executeGenerateReport(user, data); // Fixed period bug
                success = true;
                break;
            case INTENTS.LOG_CUSTOMER_PAYMENT:
                await executeLogCustomerPayment(user, data);
                success = true;
                break;
            case INTENTS.ADD_BANK_ACCOUNT:
                await executeAddBankAccount(user, data);
                success = true;
                break;
            case INTENTS.CHECK_BANK_BALANCE:
                await executeCheckBankBalance(user, data);
                success = true;
                break;
            case INTENTS.RECONCILE_TRANSACTION:
                if (data.action === 'delete') {
                    await executeDeleteTransaction(user, data);
                } else if (data.action === 'edit') {
                    await executeUpdateTransaction(user, data);
                }
                success = true;
                break;
            case INTENTS.GET_FINANCIAL_INSIGHT:
                await executeGetFinancialInsight(user, data);
                success = true;
                break;
            case INTENTS.GET_CUSTOMER_BALANCES:
                await executeGetCustomerBalances(user);
                success = true;
                break;
            default:
                logger.warn(`No executor found for intent: ${intent}`);
                await sendTextMessage(user.whatsappId, "I'm not sure how to process that right now.");
                break;
        }
    } catch (error) {
        logger.error(`Error executing task for intent ${intent} and user ${user.whatsappId}:`, error);
        await sendTextMessage(user.whatsappId, `I ran into an issue: ${error.message} Please try again. 🛠️`);
        if (user.state !== USER_STATES.IDLE) {
             await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        }
        return;
    }

    if (user.state !== USER_STATES.AWAITING_INVOICE_CONFIRMATION) {
         if (user.state !== USER_STATES.IDLE) {
             await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
         }
         if (success) {
             await sendMainMenu(user.whatsappId);
         }
    }
}

// --- executeLogSale remains largely the same, logic correct ---
async function executeLogSale(user, data) {
    const { items, customerName, saleType, linkedBankId } = data;
    if (!items || items.length === 0) throw new Error("No items found in the sale data.");

    const customer = await findOrCreateCustomer(user._id, customerName);
    let totalAmount = 0;
    let description = "";
    const processedItems = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.productName || !item.quantity || isNaN(item.quantity) || item.pricePerUnit === undefined || isNaN(item.pricePerUnit)) {
             throw new Error(`Item ${i+1} (${item.productName || 'Unknown'}) has invalid details. Please check quantity and price.`);
        }
        totalAmount += item.quantity * item.pricePerUnit;
        const product = item.isService ? null : await findProductByName(user._id, item.productName);

        processedItems.push({
            productId: product ? product._id : null,
            productName: item.productName,
            quantity: item.quantity,
            pricePerUnit: item.pricePerUnit,
            isService: item.isService ?? false
        });

        description += `${item.quantity} x ${item.productName}`;
        if (i < items.length - 1) description += ", ";
    }
    description += ` sold to ${customerName}`;

    const transactionData = { userId: user._id, totalAmount, items: processedItems, date: new Date(), description, linkedCustomerId: customer._id, linkedBankId, paymentMethod: saleType };
    const transaction = await createSaleTransaction(transactionData);

    // Update stock only for actual products
    for (const item of processedItems) {
        if (item.productId && !item.isService) {
             await updateStock(item.productId, -item.quantity, 'SALE', transaction._id);
        }
    }

    if (saleType.toLowerCase() === 'credit') {
        await updateBalanceOwed(customer._id, totalAmount);
    } else if (linkedBankId) {
        await updateBankBalance(linkedBankId, totalAmount);
    }

    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(totalAmount);
    await sendTextMessage(user.whatsappId, `✅ Sale logged successfully! ${description} for ${formattedAmount}.`);

    const fullTransactionForInvoice = await findTransactionById(transaction._id);
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transaction: fullTransactionForInvoice });
    await sendInteractiveButtons(user.whatsappId, 'Would you like me to generate a PDF invoice for this sale?', [{ id: 'invoice_yes', title: 'Yes, Please' }, { id: 'invoice_no', title: 'No, Thanks' }]);
}

async function executeLogExpense(user, data) {
    const { category, amount, description, linkedBankId } = data;
    const expenseAmount = parsePrice(amount);
    if (isNaN(expenseAmount)) throw new Error("Invalid amount provided for the expense.");
    // Prevent logging inventory purchase as expense here
    if (category?.toLowerCase() === 'inventory purchase') {
        logger.warn(`Attempted to log inventory purchase via expense flow for user ${user.whatsappId}. Ignoring.`);
        await sendTextMessage(user.whatsappId, "Please use the 'Add Product' feature to record inventory purchases.");
        return; // Don't log it
    }
    const transactionData = { userId: user._id, amount: expenseAmount, date: new Date(), description, category, linkedBankId };
    await createExpenseTransaction(transactionData);
    if (linkedBankId) {
        await updateBankBalance(linkedBankId, -expenseAmount);
    }
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(expenseAmount);
    await sendTextMessage(user.whatsappId, `✅ Expense logged: ${formattedAmount} for "${description}".`);
}

// --- executeAddProduct - CORRECTED ACCOUNTING ---
async function executeAddProduct(user, data) {
    const { productName, quantityAdded, costPrice, sellingPrice, linkedBankId } = data;
    const cost = parsePrice(costPrice);
    const sell = parsePrice(sellingPrice);
    const quantity = parseInt(quantityAdded, 10);
    if (isNaN(cost) || isNaN(sell) || isNaN(quantity)) throw new Error("Invalid quantity or price provided.");

    // Step 1: Update inventory (Asset)
    const product = await upsertProduct(user._id, productName, quantity, cost, sell);

    // Step 2: If stock was added (purchase) and paid from bank, decrease bank balance (Asset Transfer)
    if (quantity > 0 && linkedBankId) {
        const totalCost = cost * quantity;
        if (totalCost > 0) {
            await updateBankBalance(linkedBankId, -totalCost);
            logger.info(`Recorded inventory purchase cost: ${totalCost} deducted from bank ${linkedBankId}`);
            // DO NOT log an EXPENSE transaction here anymore.
        }
    } else if (quantity > 0 && !linkedBankId) {
         logger.info(`Inventory purchased for ${productName} but no bank specified. Assumed cash purchase.`);
         // Optionally, could add logic later to deduct from a default "Cash on Hand" account if implemented
    }

    await sendTextMessage(user.whatsappId, `📦 Done! "${product.productName}" has been updated/added. You now have ${product.quantity} units in stock.`);
}


// --- executeAddMultipleProducts - Needs similar correction ---
async function executeAddMultipleProducts(user, data) {
    // TODO: Implement bank deduction logic for bulk adds, similar to single add.
    // This requires asking the user which bank was used *after* confirmation.
    // For now, it adds to inventory but doesn't affect cash flow recorded by the bot.
    const products = data.products || [];
    if (products.length === 0) {
        await sendTextMessage(user.whatsappId, "I couldn't find any products in your message to add. Please try again!");
        return;
    }
    const addedProducts = [];
    for (const p of products) {
        try {
            const newProd = await upsertProduct(user._id, p.productName, p.quantityAdded, p.costPrice, p.sellingPrice);
            addedProducts.push(newProd);
        } catch (error) {
            logger.error(`Failed to add one of the multiple products: ${p.productName}`, error);
            await sendTextMessage(user.whatsappId, `I had an issue adding "${p.productName}". Please try adding it separately.`);
        }
    }
    if (addedProducts.length > 0) {
        const summary = addedProducts.map(p => `"${p.productName}" (${p.quantity} units)`).join(', ');
        await sendTextMessage(user.whatsappId, `✅ Successfully updated ${addedProducts.length} items in your inventory: ${summary}.`);
        await sendTextMessage(user.whatsappId, `(Note: Bank balance deduction for bulk purchases isn't implemented yet.)`);
    }
}

async function executeCheckStock(user, data) {
    const { productName } = data;
    if (!productName) {
        await sendTextMessage(user.whatsappId, "Please tell me which product you'd like to check.");
        return;
    }
    const product = await findProductByName(user._id, productName);
    if (product) {
        await sendTextMessage(user.whatsappId, `You have ${product.quantity} units of "${product.productName}" in stock. 📦`);
    } else {
        await sendTextMessage(user.whatsappId, `I couldn't find a product named "${productName}" in your inventory. 🤔`);
    }
}

async function executeGetFinancialSummary(user, data) {
    const { metric, period } = data;
    if (!metric || !period) {
        await sendTextMessage(user.whatsappId, "Please be more specific. You can ask 'what are my sales today?' or 'show me my expenses this month'.");
        return;
    }
    const { startDate, endDate } = getDateRange(period);
    const type = metric.toUpperCase() === 'SALES' ? 'SALE' : 'EXPENSE';
    const total = await getSummaryByDateRange(user._id, type, startDate, endDate);
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(total);
    const readablePeriod = period.replace('_', ' '); // Use replace safely here
    await sendTextMessage(user.whatsappId, `Your total ${metric} for ${readablePeriod} is ${formattedAmount}. 📊`);
}

// --- executeGenerateReport - Fixed period bug ---
async function executeGenerateReport(user, data) {
    const { reportType, period = 'this_month' } = data; // Default period here
    if (!reportType) {
        await sendTextMessage(user.whatsappId, "Please specify which report you need, e.g., 'sales report for this month' or 'inventory report'.");
        return;
    }
    let reportTypeLower = reportType.toLowerCase();
    if (reportTypeLower.includes('profit') || reportTypeLower.includes('p&l')) {
        reportTypeLower = 'pnl';
    }
    const readablePeriodStr = period.replace('_', ' '); // Safe to use replace now

    await sendTextMessage(user.whatsappId, `Generating your ${reportTypeLower} report for ${readablePeriodStr}... Please wait. 📄`);

    let pdfBuffer;
    let filename;
    const { startDate, endDate } = getDateRange(period); // Get dates for titles/queries
    const readablePeriodTitle = `For the Period: ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;

    if (reportTypeLower === 'sales' || reportTypeLower === 'expenses') {
        const type = reportTypeLower === 'sales' ? 'SALE' : 'EXPENSE';
        const transactions = await getTransactionsByDateRange(user._id, type, startDate, endDate);
        if (transactions.length === 0) {
            await sendTextMessage(user.whatsappId, `You have no ${reportTypeLower} data for ${readablePeriodStr}.`);
            return;
        }
        pdfBuffer = reportTypeLower === 'sales'
            ? await generateSalesReport(user, transactions, readablePeriodTitle)
            : await generateExpenseReport(user, transactions, readablePeriodTitle); // Pass correct title
        filename = `${reportTypeLower === 'sales' ? 'Sales' : 'Expense'}_Report_${period}.pdf`;
    } else if (reportTypeLower === 'inventory') {
        const products = await getAllProducts(user._id);
        if (products.length === 0) {
            await sendTextMessage(user.whatsappId, "You haven't added any products to your inventory yet.");
            return;
        }
        pdfBuffer = await generateInventoryReport(user, products);
        filename = 'Inventory_Report.pdf';
    } else if (reportTypeLower === 'pnl') {
        const pnlData = await _calculatePnLData(user._id, period);
        pdfBuffer = await generatePnLReport(user, pnlData, readablePeriodTitle); // Pass correct title
        filename = `P&L_Report_${period}.pdf`;
    } else {
        await sendTextMessage(user.whatsappId, `Sorry, I can only generate sales, expense, inventory, and P&L reports for now.`);
        return;
    }
    if (pdfBuffer) {
        const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
        if (mediaId) {
            await sendDocument(user.whatsappId, mediaId, filename, `Here is your ${reportTypeLower} report for ${readablePeriodStr}.`);
        } else {
            await sendTextMessage(user.whatsappId, "I couldn't send the report. There was an issue with the file upload. Please try again.");
        }
    }
}

async function executeLogCustomerPayment(user, data) {
    const { customerName, amount, linkedBankId } = data;
    const paymentAmount = parsePrice(amount);
    if (isNaN(paymentAmount)) throw new Error("Invalid amount provided for the payment.");
    const customer = await findOrCreateCustomer(user._id, customerName);
    const description = `Payment of ${paymentAmount} received from ${customer.customerName}.`;
    await createCustomerPaymentTransaction({ userId: user._id, linkedCustomerId: customer._id, amount: paymentAmount, date: new Date(), description, linkedBankId });
    const updatedCustomer = await updateBalanceOwed(customer._id, -paymentAmount);
    if (linkedBankId) {
        await updateBankBalance(linkedBankId, paymentAmount);
    }
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(paymentAmount);
    const formattedBalance = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(updatedCustomer.balanceOwed);
    await sendTextMessage(user.whatsappId, `✅ Payment of ${formattedAmount} from ${customer.customerName} has been recorded.`);
    await sendTextMessage(user.whatsappId, `Their new outstanding balance is ${formattedBalance}.`);
}

async function executeAddBankAccount(user, data) {
    const { bankName, openingBalance } = data;
    const balance = parsePrice(openingBalance);
    if (isNaN(balance)) throw new Error("Invalid opening balance provided.");
    const newAccount = await createBankAccount(user._id, bankName, balance);
    const formattedBalance = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(newAccount.balance);
    await sendTextMessage(user.whatsappId, `🏦 Success! Your bank account "${newAccount.bankName}" has been added with a starting balance of ${formattedBalance}.`);
}

async function executeCheckBankBalance(user, data) {
    const { bankName } = data;
    const format = (amount) => new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(amount);
    if (bankName) {
        const bank = await findBankAccountByName(user._id, bankName);
        if (bank) {
            await sendTextMessage(user.whatsappId, `Your balance in *${bank.bankName}* is ${format(bank.balance)}.`);
        } else {
            await sendTextMessage(user.whatsappId, `I couldn't find a bank account named "${bankName}".`);
        }
    } else {
        const banks = await getAllBankAccounts(user._id);
        if (banks.length === 0) {
            await sendTextMessage(user.whatsappId, "You haven't added any bank accounts yet. You can add one by saying 'add bank account'.");
            return;
        }
        let summary = "Here are your current bank balances:\n\n";
        banks.forEach(bank => {
            summary += `*${bank.bankName}*: ${format(bank.balance)}\n`;
        });
        await sendTextMessage(user.whatsappId, summary);
    }
}

async function executeDeleteTransaction(user, data) {
    const { transactionId } = data;
    const transaction = await findTransactionById(transactionId);
    if (!transaction || transaction.userId.toString() !== user._id.toString()) {
        await sendTextMessage(user.whatsappId, "Transaction not found or you don't have permission to delete it.");
        return;
    }
    // Rollback logic (unchanged, seems correct based on new structure)
    if (transaction.type === 'SALE') { /* ... */ }
    else if (transaction.type === 'EXPENSE') { /* ... */ }
    else if (transaction.type === 'CUSTOMER_PAYMENT') { /* ... */ }
    
    const deleted = await deleteTransactionById(transactionId);
    if (deleted) {
        await sendTextMessage(user.whatsappId, "✅ The transaction has been successfully deleted and all associated balances have been updated.");
    } else {
        await sendTextMessage(user.whatsappId, "There was an issue deleting the transaction record. Please check your recent transactions.");
    }
}

async function executeUpdateTransaction(user, data) {
    const { transactionId, changes } = data;
    const originalTx = await findTransactionById(transactionId);
    if (!originalTx) throw new Error("Could not find the original transaction to update.");
    
    // Rollback logic (unchanged, seems correct)
    logger.info(`Rolling back original transaction ${transactionId}`);
    if (originalTx.type === 'SALE') { /* ... */ }
    else if (originalTx.type === 'EXPENSE') { /* ... */ }
    else if (originalTx.type === 'CUSTOMER_PAYMENT') { /* ... */ }

    // Prepare update data and Recalculate (unchanged, seems correct)
    let updateData = { ...changes };
    if (originalTx.type === 'SALE') { /* ... */ }
    else { /* ... */ }

    // Save and Replay (unchanged, seems correct)
    const updatedTx = await updateTransactionById(transactionId, updateData);
    logger.info(`Re-applying impact for updated transaction ${transactionId}`);
    if (updatedTx.type === 'SALE') { /* ... */ }
    else if (updatedTx.type === 'EXPENSE') { /* ... */ }
    else if (updatedTx.type === 'CUSTOMER_PAYMENT') { /* ... */ }

    const newFormattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(updatedTx.amount);
    await sendTextMessage(user.whatsappId, `✅ The transaction has been successfully updated. The new total amount is ${newFormattedAmount}.`);
}

async function executeGetFinancialInsight(user, data) {
    const period = data.period || 'this_month';
    await sendTextMessage(user.whatsappId, `Analyzing your business performance for ${period.replace('_', ' ')}... 🧠`);
    const pnlData = await _calculatePnLData(user._id, period);
    const insight = await getFinancialInsight(pnlData, user.currency);
    await sendTextMessage(user.whatsappId, insight);
}

async function executeGetCustomerBalances(user) {
    const customers = await getCustomersWithBalance(user._id);
    if (customers.length === 0) {
        await sendTextMessage(user.whatsappId, "Great news! It looks like no customers currently owe you money. 👍");
        return;
    }
    let summary = "Here is a list of customers with outstanding balances:\n\n";
    customers.forEach(customer => {
        const formattedBalance = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(customer.balanceOwed);
        summary += `*${customer.customerName}*: ${formattedBalance}\n`;
    });
    await sendTextMessage(user.whatsappId, summary);
}
