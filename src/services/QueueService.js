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
import { findOrCreateUser } from '../db/userService.js'; 
import { getAllProducts } from '../db/productService.js';

// 1. Setup Redis Connection
const connection = new IORedis(config.redis.url, config.redis.options);

connection.on('error', (err) => {
    logger.error('Redis Connection Error:', err);
});

connection.on('connect', () => {
    logger.info('Successfully connected to Redis Queue.');
});

// 2. Create the Queue (Producer)
const reportQueue = new Queue('report-generation', { connection });

// 3. Create the Worker (Consumer)
const worker = new Worker('report-generation', async (job) => {
    const { userId, userCurrency, reportType, dateRange, whatsappId } = job.data;
    logger.info(`Processing report job ${job.id} for ${whatsappId}`);

    try {
        // We need to fetch the full user object to get the Business Name for the PDF Header
        const user = await findOrCreateUser(whatsappId);
        
        await generateAndSend(user, reportType, dateRange, whatsappId);
        logger.info(`Job ${job.id} completed successfully.`);
    } catch (error) {
        logger.error(`Job ${job.id} failed:`, error);
        await sendTextMessage(whatsappId, "Sorry, I encountered an error generating your report. Please try again later.");
        throw error; 
    }
}, { 
    connection,
    concurrency: 5 
});

/**
 * Adds a report generation task to the Redis queue.
 */
export async function queueReportGeneration(userId, userCurrency, reportType, dateRange, whatsappId) {
    try {
        await reportQueue.add('generate-pdf', {
            userId,
            userCurrency,
            reportType,
            dateRange,
            whatsappId
        });
        logger.info(`Report queued for ${whatsappId}`);
    } catch (error) {
        logger.error('Failed to queue report:', error);
        throw new Error('Could not queue report generation.');
    }
}

// Internal function to route to the correct PDF generator
async function generateAndSend(user, reportType, dateRange, whatsappId) {
    let pdfBuffer;
    let filename;
    
    // Convert string dates back to Date objects for MongoDB
    const startDate = new Date(dateRange.startDate);
    const endDate = new Date(dateRange.endDate);
    const periodString = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;

    if (reportType === 'PNL' || reportType === 'PROFIT') {
        const pnlData = await getPnLData(user._id, startDate, endDate);
        filename = 'PnL_Report.pdf';
        // Pass user object so PDF can extract businessName
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
