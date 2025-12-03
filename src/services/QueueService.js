import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis'; 
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { generatePDFFromTemplate } from './pdfService.js';
import { sendDocument, sendTextMessage, uploadMedia } from '../api/whatsappService.js';
import { getPnLData, getReportTransactions } from './ReportManager.js';

// [UPDATED] Connection Logic - Uses family: 0 for auto-detection (IPv4/IPv6)
let connection;

try {
    if (config.redis.url) {
        logger.info('Connecting to Redis via URL...');
        connection = new IORedis(config.redis.url, {
            maxRetriesPerRequest: null,
            family: 0 // <--- CHANGED: 0 means "Try both IPv4 and IPv6"
        });
    } else {
        logger.info(`Connecting to Redis at ${config.redis.host}:${config.redis.port}...`);
        connection = {
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            family: 0 // <--- CHANGED
        };
    }
} catch (err) {
    logger.error("Redis Connection Failed immediately:", err);
}

// 1. Define the Queue
export const reportQueue = new Queue('report-generation', { connection });

// Log connection errors
reportQueue.on('error', (err) => {
    logger.error('Queue connection error:', err.message);
});

/**
 * Add a job to the queue
 */
export async function queueReportGeneration(userId, userCurrency, reportType, dateRange, whatsappId) {
    await reportQueue.add('generate-report', {
        userId,
        userCurrency,
        reportType,
        dateRange,
        whatsappId
    });
    logger.info(`Queued ${reportType} report for user ${userId}`);
}

// 2. Define the Worker (Processor)
export const reportWorker = new Worker('report-generation', async (job) => {
    const { userId, userCurrency, reportType, dateRange, whatsappId } = job.data;
    
    try {
        logger.info(`Processing report job ${job.id} for ${reportType}`);
        
        let pdfBuffer;
        let filename;
        let dataContext = { currency: userCurrency, dateRange };

        // Fetch Data based on Type
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
        }

        if (pdfBuffer) {
            const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
            if (mediaId) {
                await sendDocument(whatsappId, mediaId, filename, `Here is your ${dataContext.type}.`);
            } else {
                await sendTextMessage(whatsappId, "Report generated, but upload failed.");
            }
        }

    } catch (error) {
        logger.error(`Job ${job.id} failed:`, error);
        await sendTextMessage(whatsappId, "Sorry, I encountered an error generating your report.");
    }

}, { connection });
