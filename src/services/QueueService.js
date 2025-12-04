import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { generatePDFFromTemplate } from './pdfService.js';
import { sendDocument, sendTextMessage, uploadMedia } from '../api/whatsappService.js';
import { getPnLData, getReportTransactions } from './ReportManager.js';

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
// This runs in the background and processes jobs one by one.
const worker = new Worker('report-generation', async (job) => {
    const { userId, userCurrency, reportType, dateRange, whatsappId } = job.data;
    logger.info(`Processing report job ${job.id} for ${whatsappId}`);

    try {
        await generateAndSend(userId, userCurrency, reportType, dateRange, whatsappId);
        logger.info(`Job ${job.id} completed successfully.`);
    } catch (error) {
        logger.error(`Job ${job.id} failed:`, error);
        // Notify user of failure
        await sendTextMessage(whatsappId, "Sorry, I encountered an error generating your report. Please try again later.");
        throw error; // Let BullMQ know it failed
    }
}, { 
    connection,
    concurrency: 5 // Process up to 5 reports at the same time
});

/**
 * Adds a report generation task to the Redis queue.
 * This function returns immediately, keeping the bot fast.
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

// Internal function that does the heavy lifting
async function generateAndSend(userId, userCurrency, reportType, dateRange, whatsappId) {
    let pdfBuffer;
    let filename;
    let dataContext = { currency: userCurrency, dateRange };

    if (reportType === 'PNL') {
        const pnlData = await getPnLData(userId, dateRange.startDate, dateRange.endDate);
        dataContext.type = 'Profit & Loss';
        dataContext.pnl = pnlData;
        filename = 'PnL_Report.pdf';
        
        pdfBuffer = await generatePDFFromTemplate('report', dataContext);

    } else if (reportType === 'SALES' || reportType === 'EXPENSES') {
        const type = reportType === 'SALES' ? 'SALE' : 'EXPENSE';
        const transactions = await getReportTransactions(userId, type, dateRange.startDate, dateRange.endDate);
        
        dataContext.type = reportType === 'SALES' ? 'Sales Report' : 'Expense Report';
        dataContext.transactions = transactions;
        dataContext.isList = true; 
        filename = `${reportType}_Report.pdf`;

        pdfBuffer = await generatePDFFromTemplate('report', dataContext);
    } else if (reportType === 'INVENTORY') {
        // Assuming generateInventoryReport is handled or we use a generic template
        // For now, handling generic reports. 
        // Note: You might need to import getAllProducts if supporting Inventory here specifically.
        // Keeping logic consistent with previous file for now.
    }

    if (pdfBuffer) {
        const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
        if (mediaId) {
            await sendDocument(whatsappId, mediaId, filename, `Here is your ${dataContext.type}.`);
        } else {
            await sendTextMessage(whatsappId, "Report generated, but I couldn't upload the file to WhatsApp.");
        }
    } else {
        await sendTextMessage(whatsappId, "No data found for this report.");
    }
}
