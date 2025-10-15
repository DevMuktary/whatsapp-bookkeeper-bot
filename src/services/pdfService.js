import PDFDocument from 'pdfkit';
import logger from '../utils/logger.js';

/**
 * Generates a sales report PDF.
 * @param {object} user - The user object, containing businessName and currency.
 * @param {Array<object>} transactions - An array of sale transaction documents.
 * @param {string} periodTitle - A readable title for the report's date range (e.g., "This Month").
 * @returns {Promise<Buffer>} A promise that resolves with the PDF buffer.
 */
export function generateSalesReport(user, transactions, periodTitle) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                resolve(Buffer.concat(buffers));
            });

            // --- Document Header ---
            doc.fontSize(20).font('Helvetica-Bold').text(user.businessName, { align: 'center' });
            doc.fontSize(14).font('Helvetica').text('Sales Report', { align: 'center' });
            doc.fontSize(10).text(periodTitle, { align: 'center' });
            doc.moveDown(2);

            // --- Table Header ---
            const tableTop = doc.y;
            const itemX = 50;
            const dateX = 150;
            const descX = 250;
            const amountX = 450;

            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('Date', dateX, tableTop);
            doc.text('Description', descX, tableTop);
            doc.text('Amount', amountX, tableTop, { align: 'right' });
            doc.moveTo(itemX, doc.y).lineTo(550, doc.y).stroke();
            doc.font('Helvetica');

            // --- Table Rows ---
            let totalSales = 0;
            transactions.forEach(tx => {
                const y = doc.y + 5;
                totalSales += tx.amount;
                const formattedAmount = new Intl.NumberFormat('en-US').format(tx.amount);
                
                doc.text(new Date(tx.date).toLocaleDateString(), dateX, y);
                doc.text(tx.description, descX, y, { width: 200, ellipsis: true });
                doc.text(`${user.currency} ${formattedAmount}`, amountX, y, { align: 'right' });
            });

            // --- Footer and Total ---
            doc.moveTo(itemX, doc.y + 15).lineTo(550, doc.y + 15).stroke();
            doc.moveDown(2);
            const totalY = doc.y;
            doc.font('Helvetica-Bold');
            doc.text('Total Sales:', descX, totalY);
            const formattedTotal = new Intl.NumberFormat('en-US').format(totalSales);
            doc.text(`${user.currency} ${formattedTotal}`, amountX, totalY, { align: 'right' });

            doc.end();
            
        } catch (error) {
            logger.error('Error generating PDF report:', error);
            reject(error);
        }
    });
}
