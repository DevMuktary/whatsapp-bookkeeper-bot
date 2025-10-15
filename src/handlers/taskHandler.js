import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findOrCreateProduct, updateStock, upsertProduct, findProductByName, getAllProducts } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction, getSummaryByDateRange, getTransactionsByDateRange } from '../db/transactionService.js';
import { createBankAccount } from '../db/bankService.js';
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
    
    if (user.state !== USER_STATES.IDLE) {
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}

async function executeLogSale(user, data) { /* ... full code ... */ }
async function executeLogExpense(user, data) { /* ... full code ... */ }
async function executeAddProduct(user, data) { /* ... full code ... */ }
async function executeAddMultipleProducts(user, data) { /* ... full code ... */ }
async function executeCheckStock(user, data) { /* ... full code ... */ }
async function executeGetFinancialSummary(user, data) { /* ... full code ... */ }
async function executeGenerateReport(user, data) { /* ... full code ... */ }
async function executeLogCustomerPayment(user, data) { /* ... full code ... */ }

async function executeAddBankAccount(user, data) {
    const { bankName, openingBalance } = data;
    const balance = Number(openingBalance);

    const newAccount = await createBankAccount(user._id, bankName, balance);

    const formattedBalance = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(newAccount.balance);
    await sendTextMessage(user.whatsappId, `🏦 Success! Your bank account "${newAccount.bankName}" has been added with a starting balance of ${formattedBalance}.`);
}
