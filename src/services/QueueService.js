import { Queue, Worker } from 'bullmq';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { generatePDFFromTemplate } from './pdfService.js'; // You will update pdfService to use this
import { sendDocument, sendTextMessage } from '../api/whatsappService.js';
import { uploadMedia } from '../api/whatsappService.js';
import { getPnLData, getReportTransactions } from './ReportManager.js';

// Connection config for Redis
const connection = {
    host: config.redis?.host || 'localhost',
    port: config.redis?.port || 6379,
    password: config.redis?.password
};

// 1. Define the Queue
export const reportQueue = new Queue('report-generation', { connection });

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
// This usually runs in index.js or a separate worker process, but defined here for modularity.
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
            
            // Generate PDF using HTML Template
            pdfBuffer = await generatePDFFromTemplate('report', dataContext);

        } else if (reportType === 'SALES' || reportType === 'EXPENSES') {
            const type = reportType === 'SALES' ? 'SALE' : 'EXPENSE';
            const transactions = await getReportTransactions(userId, type, dateRange.startDate, dateRange.endDate);
            
            dataContext.type = reportType === 'SALES' ? 'Sales Report' : 'Expense Report';
            dataContext.transactions = transactions;
            dataContext.isList = true; // Flag for template
            filename = `${reportType}_Report.pdf`;

            pdfBuffer = await generatePDFFromTemplate('report', dataContext);
        }

        if (pdfBuffer) {
            // Upload and Send via WhatsApp
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
