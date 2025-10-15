import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findOrCreateProduct, updateStock, upsertProduct, findProductByName, getAllProducts } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction, getSummaryByDateRange, getTransactionsByDateRange, findTransactionById, deleteTransactionById, updateTransactionById } from '../db/transactionService.js';
import { createBankAccount, updateBankBalance, findBankAccountByName, getAllBankAccounts } from '../db/bankService.js';
import { updateUserState } from '../db/userService.js';
import { sendTextMessage, sendInteractiveButtons, uploadMedia, sendDocument, sendMainMenu } from '../api/whatsappService.js';
import { generateSalesReport, generateExpenseReport, generateInventoryReport, generatePnLReport } from '../services/pdfService.js';
import { getFinancialInsight } from '../services/aiService.js';
import { INTENTS, USER_STATES } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';
import logger from '../utils/logger.js';

/**
 * Helper function to calculate P&L data.
 * This is the financial "engine" of the bot.
 */
async function _calculatePnLData(userId, period) {
    const { startDate, endDate } = getDateRange(period);

    // 1. Get total sales and expenses
    const totalSales = await getSummaryByDateRange(userId, 'SALE', startDate, endDate);
    const totalExpenses = await getSummaryByDateRange(userId, 'EXPENSE', startDate, endDate);

    // 2. Calculate Cost of Goods Sold (COGS)
    let totalCogs = 0;
    const salesTransactions = await getTransactionsByDateRange(userId, 'SALE', startDate, endDate);
    for (const sale of salesTransactions) {
        if (sale.linkedProductId) {
            // We need the full product details to get the costPrice
            const product = await findProductByName(userId, sale.description.split(' x ')[1].split(' sold to ')[0]);
            if (product) {
                const unitsSold = parseInt(sale.description.split(' x ')[0], 10) || 0;
                totalCogs += (product.costPrice * unitsSold);
            }
        }
    }
    
    // 3. Get top expenses
    const allExpenses = await getTransactionsByDateRange(userId, 'EXPENSE', startDate, endDate);
    const expenseMap = allExpenses.reduce((acc, tx) => {
        acc[tx.category] = (acc[tx.category] || 0) + tx.amount;
        return acc;
    }, {});
    const topExpenses = Object.entries(expenseMap)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .map(([category, total]) => ({ _id: category, total }));

    // 4. Calculate final numbers
    const grossProfit = totalSales - totalCogs;
    const netProfit = grossProfit - totalExpenses;

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
                await executeAddProduct(user, data);
                success = true;
                break;
            case INTENTS.ADD_MULTIPLE_PRODUCTS:
                await executeAddMultipleProducts(user, data);
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
                await executeGenerateReport(user, data);
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
            default:
                logger.warn(`No executor found for intent: ${intent}`);
                await sendTextMessage(user.whatsappId, "I'm not sure how to process that right now.");
                break;
        }
    } catch (error) {
        logger.error(`Error executing task for intent ${intent} and user ${user.whatsappId}:`, error);
        await sendTextMessage(user.whatsappId, `I ran into an issue: ${error.message} Please try again. 🛠️`);
    } finally {
        if (user.state !== USER_STATES.IDLE && intent !== INTENTS.LOG_SALE) {
            await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        }
        if (success && intent !== INTENTS.LOG_SALE) {
            await sendMainMenu(user.whatsappId);
        }
    }
}

async function executeLogSale(user, data) {
    const { productName, unitsSold, amountPerUnit, customerName, saleType, linkedBankId } = data;
    const totalAmount = unitsSold * amountPerUnit;
    const customer = await findOrCreateCustomer(user._id, customerName);
    const product = await findOrCreateProduct(user._id, productName);
    const description = `${unitsSold} x ${productName} sold to ${customerName}`;
    const transactionData = { userId: user._id, totalAmount, date: new Date(), description, linkedProductId: product._id, linkedCustomerId: customer._id, linkedBankId, paymentMethod: saleType };
    const transaction = await createSaleTransaction(transactionData);
    await updateStock(product._id, -unitsSold, 'SALE', transaction._id);
    if (saleType.toLowerCase() === 'credit') {
        await updateBalanceOwed(customer._id, totalAmount);
    } else if (linkedBankId) {
        await updateBankBalance(linkedBankId, totalAmount);
    }
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(totalAmount);
    await sendTextMessage(user.whatsappId, `✅ Sale logged successfully! ${description} for ${formattedAmount}.`);
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_INVOICE_CONFIRMATION, { transactionId: transaction._id });
    await sendInteractiveButtons(user.whatsappId, 'Would you like me to generate a PDF invoice for this sale?', [{ id: 'invoice_yes', title: 'Yes, Please' }, { id: 'invoice_no', title: 'No, Thanks' }]);
}

async function executeLogExpense(user, data) {
    const { category, amount, description, linkedBankId } = data;
    const transactionData = { userId: user._id, amount: Number(amount), date: new Date(), description, category, linkedBankId };
    await createExpenseTransaction(transactionData);
    if (linkedBankId) {
        await updateBankBalance(linkedBankId, -Number(amount));
    }
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(amount);
    await sendTextMessage(user.whatsappId, `✅ Expense logged: ${formattedAmount} for "${description}".`);
}

async function executeAddProduct(user, data) {
    const { productName, quantityAdded, costPrice, sellingPrice } = data;
    const product = await upsertProduct(user._id, productName, Number(quantityAdded), Number(costPrice), Number(sellingPrice));
    await sendTextMessage(user.whatsappId, `📦 Done! "${product.productName}" has been updated. You now have ${product.quantity} units in stock.`);
}

async function executeAddMultipleProducts(user, data) {
    const products = data.products || [];
    if (products.length === 0) {
        await sendTextMessage(user.whatsappId, "I couldn't find any products in your message to add. Please try again!");
        return;
    }
    const addedProducts = [];
    for (const p of products) {
        try {
            const newProd = await upsertProduct(user._id, p.productName, Number(p.quantityAdded), Number(p.costPrice), Number(p.sellingPrice));
            addedProducts.push(newProd);
        } catch (error) {
            logger.error(`Failed to add one of the multiple products: ${p.productName}`, error);
            await sendTextMessage(user.whatsappId, `I had an issue adding "${p.productName}". Please try adding it separately.`);
        }
    }
    if (addedProducts.length > 0) {
        const summary = addedProducts.map(p => `"${p.productName}" (${p.quantity} units)`).join(', ');
        await sendTextMessage(user.whatsappId, `✅ Successfully updated ${addedProducts.length} items in your inventory: ${summary}.`);
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
    const readablePeriod = period.replace('_', ' ');
    await sendTextMessage(user.whatsappId, `Your total ${metric} for ${readablePeriod} is ${formattedAmount}. 📊`);
}

async function executeGenerateReport(user, data) {
    const { reportType, period = 'this_month' } = data;
    if (!reportType) {
        await sendTextMessage(user.whatsappId, "Please specify which report you need, e.g., 'sales report for this month' or 'inventory report'.");
        return;
    }
    
    const reportTypeLower = reportType.toLowerCase();
    const readablePeriodStr = period.replace('_', ' ');

    await sendTextMessage(user.whatsappId, `Generating your ${reportTypeLower} report for ${readablePeriodStr}... Please wait. 📄`);
    
    let pdfBuffer;
    let filename;
    
    if (reportTypeLower === 'sales' || reportTypeLower === 'expenses') {
        const { startDate, endDate } = getDateRange(period);
        const readablePeriod = `For the Period: ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
        const type = reportTypeLower === 'sales' ? 'SALE' : 'EXPENSE';
        const transactions = await getTransactionsByDateRange(user._id, type, startDate, endDate);
        if (transactions.length === 0) {
            await sendTextMessage(user.whatsappId, `You have no ${reportTypeLower} data for ${readablePeriodStr}.`);
            return;
        }
        pdfBuffer = reportTypeLower === 'sales' 
            ? await generateSalesReport(user, transactions, readablePeriod)
            : await generateExpenseReport(user, transactions, readablePeriod);
        filename = `${reportType.charAt(0).toUpperCase() + reportType.slice(1)}_Report_${period}.pdf`;
    } else if (reportTypeLower === 'inventory') {
        const products = await getAllProducts(user._id);
        if (products.length === 0) {
            await sendTextMessage(user.whatsappId, "You haven't added any products to your inventory yet.");
            return;
        }
        pdfBuffer = await generateInventoryReport(user, products);
        filename = 'Inventory_Report.pdf';
    } else if (reportTypeLower === 'pnl') {
        const { startDate, endDate } = getDateRange(period);
        const readablePeriod = `For the Period: ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
        const pnlData = await _calculatePnLData(user._id, period);
        pdfBuffer = await generatePnLReport(user, pnlData, readablePeriod);
        filename = `P&L_Report_${period}.pdf`;
    } else {
        await sendTextMessage(user.whatsappId, `Sorry, I can only generate sales, expense, inventory, and P&L reports for now.`);
        return;
    }

    if (pdfBuffer) {
        const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
        if (mediaId) {
            await sendDocument(user.whatsappId, mediaId, filename, `Here is your ${reportTypeLower} report.`);
        } else {
            await sendTextMessage(user.whatsappId, "I couldn't send the report. There was an issue with the file upload. Please try again.");
        }
    }
}

async function executeLogCustomerPayment(user, data) {
    const { customerName, amount } = data;
    const paymentAmount = Number(amount);
    const customer = await findOrCreateCustomer(user._id, customerName);
    const description = `Payment of ${paymentAmount} received from ${customer.customerName}.`;
    await createCustomerPaymentTransaction({ userId: user._id, linkedCustomerId: customer._id, amount: paymentAmount, date: new Date(), description });
    const updatedCustomer = await updateBalanceOwed(customer._id, -paymentAmount);
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(paymentAmount);
    const formattedBalance = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(updatedCustomer.balanceOwed);
    await sendTextMessage(user.whatsappId, `✅ Payment of ${formattedAmount} from ${customer.customerName} has been recorded.`);
    await sendTextMessage(user.whatsappId, `Their new outstanding balance is ${formattedBalance}.`);
}

async function executeAddBankAccount(user, data) {
    const { bankName, openingBalance } = data;
    const balance = Number(openingBalance);
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
    if (transaction.type === 'SALE') {
        const unitsSoldMatch = transaction.description.match(/^(\d+)\s*x/);
        const unitsSold = unitsSoldMatch ? parseInt(unitsSoldMatch[1], 10) : 0;
        if (transaction.linkedProductId && unitsSold > 0) {
            await updateStock(transaction.linkedProductId, unitsSold, 'SALE_DELETED', transaction._id);
        }
        if (transaction.paymentMethod === 'CREDIT') {
            await updateBalanceOwed(transaction.linkedCustomerId, -transaction.amount);
        }
        if (transaction.linkedBankId) {
            await updateBankBalance(transaction.linkedBankId, -transaction.amount);
        }
    } else if (transaction.type === 'EXPENSE') {
        if (transaction.linkedBankId) {
            await updateBankBalance(transaction.linkedBankId, transaction.amount);
        }
    } else if (transaction.type === 'CUSTOMER_PAYMENT') {
        await updateBalanceOwed(transaction.linkedCustomerId, transaction.amount);
    }
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
    if (!originalTx) {
        throw new Error("Could not find the original transaction to update.");
    }
    logger.info(`Rolling back original transaction ${transactionId}`);
    if (originalTx.type === 'SALE') {
        const unitsSoldMatch = originalTx.description.match(/^(\d+)\s*x/);
        const unitsSold = unitsSoldMatch ? parseInt(unitsSoldMatch[1], 10) : 0;
        if (originalTx.linkedProductId && unitsSold > 0) {
            await updateStock(originalTx.linkedProductId, unitsSold, 'SALE_EDIT_ROLLBACK');
        }
        if (originalTx.paymentMethod === 'CREDIT') {
            await updateBalanceOwed(originalTx.linkedCustomerId, -originalTx.amount);
        }
        if (originalTx.linkedBankId) {
            await updateBankBalance(originalTx.linkedBankId, -originalTx.amount);
        }
    } else if (originalTx.type === 'EXPENSE') {
        if (originalTx.linkedBankId) {
            await updateBankBalance(originalTx.linkedBankId, originalTx.amount);
        }
    } else if (originalTx.type === 'CUSTOMER_PAYMENT') {
        await updateBalanceOwed(originalTx.linkedCustomerId, originalTx.amount);
    }
    let updateData = { ...changes };
    if (originalTx.type === 'SALE') {
        const unitsSoldMatch = originalTx.description.match(/^(\d+)\s*x/);
        const originalUnitsSold = unitsSoldMatch ? parseInt(unitsSoldMatch[1], 10) : 0;
        const originalAmountPerUnit = originalUnitsSold > 0 ? (originalTx.amount / originalUnitsSold) : 0;
        const descParts = originalTx.description.split(' sold to ');
        const customerName = descParts[1];
        const productPart = descParts[0].split(' x ');
        const productName = productPart.slice(1).join(' x ');
        const newUnitsSold = changes.unitsSold ?? originalUnitsSold;
        const newAmountPerUnit = changes.amountPerUnit ?? originalAmountPerUnit;
        updateData.amount = newUnitsSold * newAmountPerUnit;
        updateData.description = `${newUnitsSold} x ${productName} sold to ${customerName}`;
    }
    const updatedTx = await updateTransactionById(transactionId, updateData);
    logger.info(`Re-applying impact for updated transaction ${transactionId}`);
    if (updatedTx.type === 'SALE') {
        const unitsSoldMatch = updatedTx.description.match(/^(\d+)\s*x/);
        const newUnitsSold = unitsSoldMatch ? parseInt(unitsSoldMatch[1], 10) : 0;
        if (updatedTx.linkedProductId && newUnitsSold > 0) {
            await updateStock(updatedTx.linkedProductId, -newUnitsSold, 'SALE_EDIT_REAPPLY');
        }
        if (updatedTx.paymentMethod === 'CREDIT') {
            await updateBalanceOwed(updatedTx.linkedCustomerId, updatedTx.amount);
        }
        if (updatedTx.linkedBankId) {
            await updateBankBalance(updatedTx.linkedBankId, updatedTx.amount);
        }
    } else if (updatedTx.type === 'EXPENSE') {
        if (updatedTx.linkedBankId) {
            await updateBankBalance(updatedTx.linkedBankId, -updatedTx.amount);
        }
    } else if (updatedTx.type === 'CUSTOMER_PAYMENT') {
        await updateBalanceOwed(updatedTx.linkedCustomerId, -updatedTx.amount);
    }
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
