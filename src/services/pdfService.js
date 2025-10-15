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

/**
 * Generates an expense report PDF.
 * @param {object} user - The user object, containing businessName and currency.
 * @param {Array<object>} transactions - An array of expense transaction documents.
 * @param {string} periodTitle - A readable title for the report's date range.
 * @returns {Promise<Buffer>} A promise that resolves with the PDF buffer.
 */
export function generateExpenseReport(user, transactions, periodTitle) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            // --- Document Header ---
            doc.fontSize(20).font('Helvetica-Bold').text(user.businessName, { align: 'center' });
            doc.fontSize(14).font('Helvetica').text('Expense Report', { align: 'center' });
            doc.fontSize(10).text(periodTitle, { align: 'center' });
            doc.moveDown(2);

            // --- Table Header ---
            const tableTop = doc.y;
            const itemX = 50;
            const dateX = 100;
            const categoryX = 200;
            const descX = 300;
            const amountX = 450;

            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('Date', dateX, tableTop);
            doc.text('Category', categoryX, tableTop);
            doc.text('Description', descX, tableTop);
            doc.text('Amount', amountX, tableTop, { align: 'right' });
            doc.moveTo(itemX, doc.y).lineTo(550, doc.y).stroke();
            doc.font('Helvetica');

            // --- Table Rows ---
            let totalExpenses = 0;
            transactions.forEach(tx => {
                const y = doc.y + 5;
                totalExpenses += tx.amount;
                const formattedAmount = new Intl.NumberFormat('en-US').format(tx.amount);
                
                doc.text(new Date(tx.date).toLocaleDateString(), dateX, y);
                doc.text(tx.category, categoryX, y, { width: 90, ellipsis: true });
                doc.text(tx.description, descX, y, { width: 140, ellipsis: true });
                doc.text(`${user.currency} ${formattedAmount}`, amountX, y, { align: 'right' });
            });

            // --- Footer and Total ---
            doc.moveTo(itemX, doc.y + 15).lineTo(550, doc.y + 15).stroke();
            doc.moveDown(2);
            const totalY = doc.y;
            doc.font('Helvetica-Bold');
            doc.text('Total Expenses:', descX, totalY);
            const formattedTotal = new Intl.NumberFormat('en-US').format(totalExpenses);
            doc.text(`${user.currency} ${formattedTotal}`, amountX, totalY, { align: 'right' });

            doc.end();

        } catch (error) {
            logger.error('Error generating Expense PDF report:', error);
            reject(error);
        }
    });
}

/**
 * Generates an inventory report PDF.
 * @param {object} user - The user object, containing businessName and currency.
 * @param {Array<object>} products - An array of all product documents.
 * @returns {Promise<Buffer>} A promise that resolves with the PDF buffer.
 */
export function generateInventoryReport(user, products) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            // --- Document Header ---
            doc.fontSize(20).font('Helvetica-Bold').text(user.businessName, { align: 'center' });
            doc.fontSize(14).font('Helvetica').text('Inventory Report', { align: 'center' });
            doc.fontSize(10).text(`As of: ${new Date().toLocaleString()}`, { align: 'center' });
            doc.moveDown(2);

            // --- Table Header ---
            const tableTop = doc.y;
            const itemX = 40;
            const nameX = 40;
            const qtyX = 250;
            const costX = 310;
            const sellX = 390;
            const valueX = 470;

            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('Product Name', nameX, tableTop);
            doc.text('Quantity', qtyX, tableTop, { align: 'center' });
            doc.text('Cost Price', costX, tableTop, { align: 'right' });
            doc.text('Sell Price', sellX, tableTop, { align: 'right' });
            doc.text('Total Value', valueX, tableTop, { align: 'right' });
            doc.moveTo(itemX, doc.y).lineTo(560, doc.y).stroke();
            doc.font('Helvetica');

            // --- Table Rows ---
            let totalInventoryValue = 0;
            products.forEach(p => {
                const y = doc.y + 5;
                const itemValue = p.quantity * p.costPrice;
                totalInventoryValue += itemValue;
                
                doc.text(p.productName, nameX, y, { width: 200, ellipsis: true });
                doc.text(p.quantity, qtyX, y, { align: 'center', width: 50 });
                doc.text(new Intl.NumberFormat('en-US').format(p.costPrice), costX, y, { align: 'right', width: 60 });
                doc.text(new Intl.NumberFormat('en-US').format(p.sellingPrice), sellX, y, { align: 'right', width: 60 });
                doc.text(new Intl.NumberFormat('en-US').format(itemValue), valueX, y, { align: 'right', width: 80 });
            });

            // --- Footer and Total ---
            doc.moveTo(itemX, doc.y + 15).lineTo(560, doc.y + 15).stroke();
            doc.moveDown(2);
            const totalY = doc.y;
            doc.font('Helvetica-Bold');
            doc.text('Total Inventory Value (at Cost):', sellX - 50, totalY, { align: 'right' });
            const formattedTotal = new Intl.NumberFormat('en-US').format(totalInventoryValue);
            doc.text(`${user.currency} ${formattedTotal}`, valueX, totalY, { align: 'right' });

            doc.end();

        } catch (error) {
            logger.error('Error generating Inventory PDF report:', error);
            reject(error);
        }
    });
}

/**
 * Generates a Profit & Loss (P&L) report PDF.
 * @param {object} user - The user object.
 * @param {object} pnlData - The calculated P&L data.
 * @param {string} periodTitle - A readable title for the report's date range.
 * @returns {Promise<Buffer>} A promise that resolves with the PDF buffer.
 */
export function generatePnLReport(user, pnlData, periodTitle) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            const format = (amount) => new Intl.NumberFormat('en-US').format(amount);

            // --- Header ---
            doc.fontSize(20).font('Helvetica-Bold').text(user.businessName, { align: 'center' });
            doc.fontSize(14).font('Helvetica').text('Profit & Loss Statement', { align: 'center' });
            doc.fontSize(10).text(periodTitle, { align: 'center' });
            doc.moveDown(3);

            const sectionY = doc.y;
            const labelX = 50;
            const amountX = 400;

            // --- Income Section ---
            doc.fontSize(12).font('Helvetica-Bold');
            doc.text('Revenue', labelX, sectionY);
            doc.font('Helvetica');
            doc.text('Total Sales', labelX + 15, doc.y);
            doc.text(`${user.currency} ${format(pnlData.totalSales)}`, amountX, doc.y - 15, { align: 'right' });
            doc.moveDown();

            doc.font('Helvetica-Bold');
            doc.text('Cost of Goods Sold (COGS)', labelX + 15, doc.y);
            doc.text(`${user.currency} ${format(pnlData.totalCogs)}`, amountX, doc.y - 15, { align: 'right' });
            doc.moveDown();

            doc.moveTo(labelX, doc.y).lineTo(550, doc.y).stroke();
            doc.fontSize(14).font('Helvetica-Bold');
            doc.text('Gross Profit', labelX, doc.y + 10);
            doc.text(`${user.currency} ${format(pnlData.grossProfit)}`, amountX, doc.y - 15, { align: 'right' });
            doc.moveDown(3);

            // --- Expenses Section ---
            const expensesY = doc.y;
            doc.fontSize(12).font('Helvetica-Bold');
            doc.text('Operating Expenses', labelX, expensesY);
            doc.font('Helvetica');
            pnlData.topExpenses.forEach(exp => {
                doc.text(exp._id, labelX + 15, doc.y);
                doc.text(`${user.currency} ${format(exp.total)}`, amountX, doc.y - 15, { align: 'right' });
            });
            doc.moveDown();
            
            doc.moveTo(labelX, doc.y).lineTo(550, doc.y).stroke();
            doc.fontSize(12).font('Helvetica-Bold');
            doc.text('Total Expenses', labelX, doc.y + 10);
            doc.text(`${user.currency} ${format(pnlData.totalExpenses)}`, amountX, doc.y - 15, { align: 'right' });
            doc.moveDown(2);
            
            // --- Net Profit Section ---
            doc.moveTo(labelX, doc.y).lineTo(550, doc.y).stroke();
            doc.fontSize(16).font('Helvetica-Bold');
            const netProfitY = doc.y + 10;
            doc.text('Net Profit / (Loss)', labelX, netProfitY);
            const netProfitText = pnlData.netProfit < 0 ? `(${format(Math.abs(pnlData.netProfit))})` : format(pnlData.netProfit);
            doc.text(`${user.currency} ${netProfitText}`, amountX, netProfitY, { align: 'right' });
            doc.moveTo(labelX, doc.y).lineTo(550, doc.y).stroke();
            
            doc.end();

        } catch (error) {
            logger.error('Error generating P&L PDF report:', error);
            reject(error);
        }
    });
}

/**
 * Generates a professional PDF invoice for a single transaction.
 * @param {object} user - The user object (business details).
 * @param {object} transaction - The transaction document.
 * @param {object} customer - The customer document.
 * @returns {Promise<Buffer>} A promise that resolves with the PDF buffer.
 */
export function generateInvoice(user, transaction, customer) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            // --- Header ---
            doc.fontSize(24).font('Helvetica-Bold').text(user.businessName, { align: 'left' });
            doc.fontSize(10).font('Helvetica').text(user.email || '', { align: 'left' });
            doc.moveDown(2);

            // --- Bill To & Invoice Info ---
            const infoTop = doc.y;
            doc.fontSize(12).font('Helvetica-Bold').text('Bill To:', { continued: false });
            doc.font('Helvetica').text(customer.customerName);
            
            const invoiceNumber = transaction._id.toString().slice(-8).toUpperCase();
            doc.fontSize(12).font('Helvetica-Bold').text('Invoice #:', 300, infoTop);
            doc.font('Helvetica').text(invoiceNumber, 400, infoTop);
            doc.font('Helvetica-Bold').text('Date:', 300, infoTop + 15);
            doc.font('Helvetica').text(new Date(transaction.date).toLocaleDateString(), 400, infoTop + 15);
            doc.moveDown(2);

            // --- Table ---
            const tableTopY = doc.y;
            doc.font('Helvetica-Bold');
            doc.text('Description', 50, tableTopY);
            doc.text('Amount', 450, tableTopY, { align: 'right' });
            doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.font('Helvetica');

            const itemY = doc.y + 5;
            doc.text(transaction.description, 50, itemY, { width: 380 });
            const formattedAmount = new Intl.NumberFormat('en-US').format(transaction.amount);
            doc.text(`${user.currency} ${formattedAmount}`, 450, itemY, { align: 'right' });
            
            // --- Total ---
            const totalY = doc.y + 20;
            doc.moveTo(350, totalY - 5).lineTo(550, totalY - 5).stroke();
            doc.font('Helvetica-Bold').fontSize(14).text('Total:', 350, totalY);
            doc.text(`${user.currency} ${formattedAmount}`, 450, totalY, { align: 'right' });
            doc.moveTo(350, doc.y).lineTo(550, doc.y).stroke();

            // --- Footer ---
            doc.fontSize(10).font('Helvetica-Oblique').text('Thank you for your business!', 50, doc.page.height - 50, { align: 'center', width: 500 });
            
            doc.end();

        } catch (error) {
            logger.error('Error generating invoice PDF:', error);
            reject(error);
        }
    });
}
