import logger from '../utils/logger.js';
import { generatePDFFromTemplate } from './pdfService.js';
import { sendDocument, sendTextMessage, uploadMedia } from '../api/whatsappService.js';
import { getPnLData, getReportTransactions } from './ReportManager.js';

/**
 * DIRECT REPORT GENERATION (No Redis)
 * This function is called by messageHandler. It triggers the generation
 * but does not wait for it to finish, allowing the bot to stay responsive.
 */
export async function queueReportGeneration(userId, userCurrency, reportType, dateRange, whatsappId) {
    logger.info(`Starting direct report generation: ${reportType} for ${userId}`);

    // Run in background so we don't block the WhatsApp webhook response
    generateAndSend(userId, userCurrency, reportType, dateRange, whatsappId)
        .catch(error => {
            logger.error('Background report generation failed:', error);
            sendTextMessage(whatsappId, "Sorry, I encountered an error creating your report.");
        });
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
    }

    if (pdfBuffer) {
        const mediaId = await uploadMedia(pdfBuffer, 'application/pdf');
        if (mediaId) {
            await sendDocument(whatsappId, mediaId, filename, `Here is your ${dataContext.type}.`);
        } else {
            await sendTextMessage(whatsappId, "Report generated, but I couldn't upload the file to WhatsApp.");
        }
    }
}
