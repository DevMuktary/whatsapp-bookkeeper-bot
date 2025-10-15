import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findOrCreateProduct, updateStock, upsertProduct, findProductByName, getAllProducts } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction, getSummaryByDateRange, getTransactionsByDateRange } from '../db/transactionService.js';
import { createBankAccount, updateBankBalance } from '../db/bankService.js';
import { updateUserState } from '../db/userService.js';
import { sendTextMessage, sendInteractiveButtons, uploadMedia, sendDocument } from '../api/whatsappService.js';
import { generateSalesReport, generateExpenseReport, generateInventoryReport } from '../services/pdfService.js';
import { INTENTS, USER_STATES } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';
import logger from '../utils/logger.js';

export async function executeTask(intent, user, data) {
    try {
        switch (intent) {
            case INTENTS.LOG_SALE:
                await executeLogSale(user, data);
                // State is managed by executeLogSale for the invoice flow
                return; 
            case INTENTS.LOG_EXPENSE:
                await executeLogExpense(user, data);
                break;
            case INTENTS.ADD_PRODUCT:
                await executeAddProduct(user, data);
                break;
            case INTENTS.ADD_MULTIPLE_PRODUCTS:
                await executeAddMultipleProducts(user, data);
                break;
            case INTENTS.CHECK_STOCK:
                await executeCheckStock(user, data);
                break;
            case INTENTS.GET_FINANCIAL_SUMMARY:
                await executeGetFinancialSummary(user, data);
                break;
            case INTENTS.GENERATE_REPORT:
                await executeGenerateReport(user, data);
                break;
            case INTENTS.LOG_CUSTOMER_PAYMENT:
                await executeLogCustomerPayment(user, data);
                break;
            case INTENTS.ADD_BANK_ACCOUNT:
                await executeAddBankAccount(user, data);
                break;
            default:
                logger.warn(`No executor found for intent: ${intent}`);
                await sendTextMessage(user.whatsappId, "I'm not sure how to process that right now, but I'm learning!");
                break;
        }
    } catch (error) {
        logger.error(`Error executing task for intent ${intent} and user ${user.whatsappId}:`, error);
        await sendTextMessage(user.whatsappId, `I ran into an issue trying to complete that task: ${error.message} Please try again. 🛠️`);
    } 
    
    // Most tasks reset state to IDLE. Sales is a special case.
    if (user.state !== USER_STATES.IDLE) {
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}

async function executeLogSale(user, data) {
    const { productName, unitsSold, amountPerUnit, customerName, saleType, linkedBankId } = data;
    const totalAmount = unitsSold * amountPerUnit;

    const customer = await findOrCreateCustomer(user._id, customerName);
    const product = await findOrCreateProduct(user._id, productName);

    const description = `${unitsSold} x ${productName} sold to ${customerName}`;
    const transactionData = {
        userId: user._id,
        totalAmount,
        date: new Date(),
        description,
        linkedProductId: product._id,
        linkedCustomerId: customer._id,
        linkedBankId,
        paymentMethod: saleType,
    };
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
    await sendInteractiveButtons(
        user.whatsappId,
        'Would you like me to generate a PDF invoice for this sale?',
        [{ id: 'invoice_yes', title: 'Yes, Please' }, { id: 'invoice_no', title: 'No, Thanks' }]
    );
}

async function executeLogExpense(user, data) {
    const { category, amount, description, linkedBankId } = data;

    const transactionData = {
        userId: user._id,
        amount: Number(amount),
        date: new Date(),
        description,
        category,
        linkedBankId,
    };
    await createExpenseTransaction(transactionData);
    
    if (linkedBankId) {
        await updateBankBalance(linkedBankId, -Number(amount));
    }
    
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(amount);
    await sendTextMessage(user.whatsappId, `✅ Expense logged: ${formattedAmount} for "${description}".`);
}

async function executeAddProduct(user, data) {
    const { productName, quantityAdded, costPrice, sellingPrice } = data;

    const product = await upsertProduct(
        user._id,
        productName,
        Number(quantityAdded),
        Number(costPrice),
        Number(sellingPrice)
    );

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
            const newProd = await upsertProduct(
                user._id,
                p.productName,
                Number(p.quantityAdded),
                Number(p.costPrice),
                Number(p.sellingPrice)
            );
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
    const { reportType, period } = data;
    if (!reportType && !data.reportType) {
        await sendTextMessage(user.whatsappId, "Please specify the report you need, for example: 'send sales report for this month' or 'generate inventory report'.");
        return;
    }
    
    const reportTypeLower = (reportType || data.reportType).toLowerCase();
    
    await sendTextMessage(user.whatsappId, `Generating your ${reportTypeLower} report... Please wait a moment. 📄`);
    
    let pdfBuffer;
    let filename;
    
    if (reportTypeLower === 'sales' || reportTypeLower === 'expenses') {
        if (!period) {
            await sendTextMessage(user.whatsappId, "Please specify a period for this report, like 'today' or 'this month'.");
            return;
        }
        const { startDate, endDate } = getDateRange(period);
        const readablePeriod = `For the Period: ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
        const type = reportTypeLower === 'sales' ? 'SALE' : 'EXPENSE';

        const transactions = await getTransactionsByDateRange(user._id, type, startDate, endDate);
        if (transactions.length === 0) {
            await sendTextMessage(user.whatsappId, `You have no ${reportTypeLower} data for ${period.replace('_', ' ')}.`);
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

    } else {
        await sendTextMessage(user.whatsappId, `Sorry, I can only generate sales, expense, and inventory reports for now.`);
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
    await createCustomerPaymentTransaction({
        userId: user._id,
        linkedCustomerId: customer._id,
        amount: paymentAmount,
        date: new Date(),
        description,
    });
    
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
