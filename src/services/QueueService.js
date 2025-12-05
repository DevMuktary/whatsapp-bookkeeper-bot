import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { 
    generateSalesReport, 
    generateExpenseReport, 
    generatePnLReport, 
    generateInventoryReport 
} from './pdfService.js';
import { sendDocument, sendTextMessage, uploadMedia } from '../api/whatsappService.js';
import { getPnLData, getReportTransactions } from './ReportManager.js';
import { findUserById } from '../db/userService.js';
import { getAllProducts } from '../db/productService.js';

// [NEW IMPORTS FOR DAILY TASKS]
import { getTransactionsByDateRange, getDueTransactions } from '../db/transactionService.js';
import { findCustomerById } from '../db/customerService.js';

// 1. Setup Redis Connection
const connection = new IORedis(config.redis.url, config.redis.options);

connection.on('error', (err) => {
    logger.error('Redis Connection Error:', err);
});

connection.on('connect', () => {
    logger.info('Successfully connected to Redis Queue.');
});

// --- QUEUE 1: REPORT GENERATION ---
const reportQueue = new Queue('report-generation', { connection });

const reportWorker = new Worker('report-generation', async (job) => {
    const { userId, userCurrency, reportType, dateRange, whatsappId } = job.data;
    logger.info(`Processing report job ${job.id} for ${whatsappId}`);

    try {
        const user = await findUserById(userId);
        if (!user) throw new Error("User record not found for report generation.");
        if (!user.currency) user.currency = userCurrency;

        await generateAndSend(user, reportType, dateRange, whatsappId);
        logger.info(`Report Job ${job.id} completed.`);
    } catch (error) {
        logger.error(`Report Job ${job.id} failed:`, error);
        await sendTextMessage(whatsappId, "Sorry, I encountered an error generating your report.");
        throw error; 
    }
}, { connection, concurrency: 5 });

export async function queueReportGeneration(userId, userCurrency, reportType, dateRange, whatsappId) {
    try {
        await reportQueue.add('generate-pdf', {
            userId, userCurrency, reportType, dateRange, whatsappId
        });
        logger.info(`Report queued for ${whatsappId}`);
    } catch (error) {
        logger.error('Failed to queue report:', error);
        throw new Error('Could not queue report generation.');
    }
}

// --- [NEW] QUEUE 2: DAILY TASKS (Scheduler) ---
const dailyTaskQueue = new Queue('daily-tasks', { connection });

const dailyTaskWorker = new Worker('daily-tasks', async (job) => {
    const { userId } = job.data;
    logger.info(`Processing daily task for user ${userId}`);

    try {
        const user = await findUserById(userId);
        if (!user || !user.whatsappId) return;

        // 1. Send Daily Summary
        await processDailyUserSummary(user);

        // 2. Check Debts
        await processDueDebts(user);

    } catch (error) {
        logger.error(`Daily task failed for user ${userId}:`, error);
        // We don't throw here to avoid retrying stale daily updates endlessly
    }
}, { connection, concurrency: 10 }); // Can process 10 users at once

export async function queueDailyTask(userId) {
    await dailyTaskQueue.add('daily-summary', { userId }, {
        removeOnComplete: true,
        removeOnFail: true
    });
}

// --- HELPER FUNCTIONS ---

async function generateAndSend(user, reportType, dateRange, whatsappId) {
    let pdfBuffer;
    let filename;
    
    const startDate = new Date(dateRange.startDate);
    const endDate = new Date(dateRange.endDate);
    const periodString = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;

    if (reportType === 'PNL' || reportType === 'PROFIT') {
        const pnlData = await getPnLData(user._id, startDate, endDate);
        filename = 'PnL_Report.pdf';
        pdfBuffer = await generatePnLReport(user, pnlData, periodString);

    } else if (reportType === 'SALES') {
        const txs = await getReportTransactions(user._id, 'SALE', startDate, endDate);
        filename = 'Sales_Report.pdf';
        pdfBuffer = await generateSalesReport(user, txs, periodString);

    } else if (reportType === 'EXPENSES') {
        const txs = await getReportTransactions(user._id, 'EXPENSE', startDate, endDate);
        filename = 'Expense_Report.pdf';
        pdfBuffer = await generateExpenseReport(user, txs, periodString);
    
    } else if (reportType === 'INVENTORY') {
        const products = await getAllProducts(user._id);
        filename = 'Inventory_Report.pdf';
        pdfBuffer = await generateInventoryReport(user, products);
    }

    if (pdfBuffer) {
        const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
        if (mediaId) {
            await sendDocument(whatsappId, mediaId, filename, `Here is your ${filename.replace('_', ' ')}.`);
        } else {
            await sendTextMessage(whatsappId, "Report generated, but I couldn't upload the file to WhatsApp.");
        }
    } else {
        await sendTextMessage(whatsappId, "No data found for this report.");
    }
}

// [MOVED FROM SCHEDULER.JS]
async function processDailyUserSummary(user) {
    const today = new Date();
    const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

    const sales = await getTransactionsByDateRange(user._id, 'SALE', startOfDay, endOfDay);
    const expenses = await getTransactionsByDateRange(user._id, 'EXPENSE', startOfDay, endOfDay);

    const totalSales = sales.reduce((acc, curr) => acc + curr.amount, 0);
    const totalExpenses = expenses.reduce((acc, curr) => acc + curr.amount, 0);
    const profit = totalSales - totalExpenses;

    if (totalSales === 0 && totalExpenses === 0) {
        const businessName = user.businessName || 'there';
        // Only send "Did you forget?" if they are a relatively new or active user to avoid spamming inactive ones
        // For now, we keep logic simple.
        await sendTextMessage(
            user.whatsappId, 
            `👋 Hey ${businessName}, did you make any sales today that you forgot to log?\n\nReply with something like 'Sold 5 rice' now to keep your books balanced!`
        );
    } else {
        const currency = user.currency || '';
        const profitEmoji = profit >= 0 ? '📈' : '📉';
        const msg = `📉 *Day End Summary* (${today.toLocaleDateString()}):\n\n` +
                    `• Sales: ${currency} ${totalSales.toLocaleString()}\n` +
                    `• Expenses: ${currency} ${totalExpenses.toLocaleString()}\n` +
                    `-------------------\n` +
                    `• *Net Profit: ${currency} ${profit.toLocaleString()}* ${profitEmoji}\n\n` +
                    `Great job today! Rest well. 😴`;
        await sendTextMessage(user.whatsappId, msg);
    }
}

async function processDueDebts(user) {
    const today = new Date();
    const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

    const dueTxns = await getDueTransactions(user._id, startOfDay, endOfDay);

    for (const tx of dueTxns) {
        if (!tx.linkedCustomerId) continue;
        const customer = await findCustomerById(tx.linkedCustomerId);
        if (customer && customer.balanceOwed > 0) {
            const currency = user.currency || '';
            const amount = tx.amount.toLocaleString();
            
            await sendTextMessage(user.whatsappId, 
                `🔔 *Payment Due Today:*\n\n` +
                `**${customer.customerName}** owes you **${currency} ${amount}** from a sale on ${new Date(tx.date).toLocaleDateString()}.\n\n` +
                `Their total outstanding balance is ${currency} ${customer.balanceOwed.toLocaleString()}.`
            );
        }
    }
}
