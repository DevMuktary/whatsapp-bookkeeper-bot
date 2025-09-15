import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

// --- Professional Design Colors & Fonts ---
const brandColor = '#001232'; // Dark Blue
const lightGrey = '#F2F2F2'; // For table row backgrounds
const font = 'Helvetica';
const fontBold = 'Helvetica-Bold';

// --- Reusable Header Function ---
function generateHeader(doc, user) {
    doc.fillColor(brandColor)
       .fontSize(20)
       .font(fontBold)
       .text(user.storeName || 'Business Report', 50, 50, { align: 'left' });
    doc.moveDown(0.5);
}

// --- Reusable Footer Function ---
function generateFooter(doc) {
    const pageCount = doc.bufferedPageRange().count; // Get the total number of pages after all content
    for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i); // Switch to each page to add the footer

        const genDate = new Date().toLocaleString('en-GB');
        doc.fontSize(8)
           .fillColor('#AAAAAA')
           .text(`Page ${i + 1} of ${pageCount}`, 50, doc.page.height - 50, { align: 'right', width: 500 })
           .text(`Generated on: ${genDate}`, 50, doc.page.height - 50, { align: 'left' });
    }
}

// --- Reusable function for drawing a horizontal line ---
function generateHr(doc, y) {
    doc.strokeColor("#E5E7EB").lineWidth(1).moveTo(50, y).lineTo(550, y).stroke();
}

function createMonthlyReportPDF(transactions, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true });
        const stream = new PassThrough();
        const currency = user.currency || 'CUR';
        doc.pipe(stream);

        generateHeader(doc, user);
        doc.fillColor('#444444').fontSize(12).font(font).text('Monthly Financial Report', { align: 'left' });
        doc.fontSize(10).text(monthName, { align: 'left' });
        doc.moveDown(2);

        let totalIncome = 0, totalExpense = 0;
        transactions.forEach(t => {
            if (t.type === 'income') totalIncome += t.amount;
            if (t.type === 'expense') totalExpense += t.amount;
        });
        const net = totalIncome - totalExpense;
        
        doc.font(fontBold).text('Summary', { underline: true });
        doc.moveDown();
        doc.fontSize(10).font(font).text('Total Income:', 50, doc.y, { continued: true }).text(`${currency} ${totalIncome.toLocaleString()}`, { align: 'right' });
        doc.text('Total Expenses:', 50, doc.y, { continued: true }).text(`${currency} ${totalExpense.toLocaleString()}`, { align: 'right' });
        doc.font(fontBold).text('Net Balance:', 50, doc.y, { continued: true }).text(`${currency} ${net.toLocaleString()}`, { align: 'right' });
        doc.moveDown(3);

        if ((doc.y + 40) > (doc.page.height - doc.page.margins.bottom)) doc.addPage();
        
        doc.font(fontBold).text('Detailed Transactions', { underline: true });
        doc.moveDown();
        
        const tableTop = doc.y;
        doc.rect(50, tableTop, 500, 20).fill(brandColor);
        doc.fontSize(10).font(fontBold).fillColor('white');
        doc.text('Date', 60, tableTop + 6, { width: 70 });
        doc.text('Description', 140, tableTop + 6, { width: 150 });
        doc.text('Category', 300, tableTop + 6, { width: 100 });
        doc.text('Type', 410, tableTop + 6, { width: 50 });
        doc.text('Amount', 460, tableTop + 6, { width: 80, align: 'right' });
        
        let rowY = tableTop + 20;
        doc.fillColor('black').font(font);
        transactions.forEach((t, i) => {
            if ((rowY + 20) > (doc.page.height - doc.page.margins.bottom)) { 
                doc.addPage(); 
                rowY = doc.page.margins.top;
            }
            if (i % 2 === 1) doc.rect(50, rowY, 500, 20).fill(lightGrey);
            
            const formattedDate = t.createdAt.toLocaleDateString('en-GB');
            doc.fontSize(9)
               .text(formattedDate, 60, rowY + 6, { width: 70 })
               .text(t.description, 140, rowY + 6, { width: 150 })
               .text(t.category, 300, rowY + 6, { width: 100 })
               .text(t.type.charAt(0).toUpperCase() + t.type.slice(1), 410, rowY + 6, { width: 50 })
               .text(t.amount.toLocaleString(), 460, rowY + 6, { width: 80, align: 'right' });
            rowY += 20;
        });

        doc.end(); // End the document here to finalize page content
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => {
            generateFooter(doc); // Generate footer after all content is added and page count is final
            resolve(Buffer.concat(buffers));
        });
    });
}

function createInventoryReportPDF(products, logs, monthName, user) {
     return new Promise((resolve) => {
        const doc = new PDFDocument({ margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true });
        const stream = new PassThrough();
        const currency = user.currency || 'CUR';
        doc.pipe(stream);

        const addHeaderAndInfo = (isFirstPage = false) => {
            generateHeader(doc, user);
            doc.fillColor('#444444').fontSize(12).font(font).text('Inventory & Profitability Report', { align: 'left' });
            doc.fontSize(10).text(monthName, { align: 'left' });
            if (!isFirstPage) doc.y = 120;
        };
        
        doc.on('pageAdded', () => addHeaderAndInfo());
        addHeaderAndInfo(true);
        doc.moveDown(2);
        
        products.forEach((product) => {
            // Check if enough space for the next product entry, if not, create a new page
            if (doc.y > (doc.page.height - doc.page.margins.bottom - 150)) doc.addPage();

            const productLogs = logs.filter(log => log.productId.equals(product._id));
            const unitsSold = productLogs.filter(l => l.type === 'sale').reduce((sum, l) => sum - l.quantityChange, 0);
            const revenue = unitsSold * product.price;
            const costOfGoodsSold = unitsSold * product.cost;
            const profit = revenue - costOfGoodsSold;

            doc.font(fontBold).fontSize(14).text(product.productName);
            generateHr(doc, doc.y);
            doc.moveDown();

            doc.fontSize(10).font(fontBold).text('Current Status', 50, doc.y, { continued: true }).font(font).text(`Remaining Stock: ${product.stock} units`);
            doc.moveDown(1.5);

            doc.font(fontBold).text('Monthly Performance');
            doc.font(font).text('Units Sold:', 70, doc.y, { continued: true }).text(`${unitsSold}`, { align: 'right' });
            doc.text('Revenue:', 70, doc.y, { continued: true }).text(`${currency} ${revenue.toLocaleString()}`, { align: 'right' });
            doc.text('Cost of Goods Sold:', 70, doc.y, { continued: true }).text(`${currency} ${costOfGoodsSold.toLocaleString()}`, { align: 'right' });
            doc.font(fontBold).text('Gross Profit:', 70, doc.y, { continued: true }).text(`${currency} ${profit.toLocaleString()}`, { align: 'right' });
            
            doc.moveDown(3);
        });

        doc.end(); // End the document here to finalize page content
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => {
            generateFooter(doc); // Generate footer after all content is added and page count is final
            resolve(Buffer.concat(buffers));
        });
    });
}

function createPnLReportPDF(data, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true });
        const stream = new PassThrough();
        const currency = user.currency || 'CUR';
        doc.pipe(stream);

        const { totalRevenue, cogs, expensesByCategory } = data;
        const grossProfit = totalRevenue - cogs;
        const totalExpenses = Object.values(expensesByCategory).reduce((sum, val) => sum + val, 0);
        const netProfit = grossProfit - totalExpenses;

        generateHeader(doc, user);
        doc.fillColor('#444444').fontSize(12).font(font).text('Profit & Loss Statement', { align: 'left' });
        doc.fontSize(10).text(`For the Month of ${monthName}`, { align: 'left' });
        doc.moveDown(3);

        const drawRow = (label, amount, isBold = false, isSub = false) => {
            // Check if there's enough space for the next line, plus the footer height
            const requiredSpace = (isBold ? 11 : 10) + (isBold ? 1.2 : 1) * 10 + 60; // line height + bottom margin + footer height
            if (doc.y + requiredSpace > doc.page.height - doc.page.margins.bottom) doc.addPage();
            
            const itemX = 50;
            const amountX = 350;
            const rowWidth = 190;
            const y = doc.y;
            doc.font(isBold ? fontBold : font)
               .fontSize(isBold ? 11 : 10)
               .text(label, itemX + (isSub ? 15 : 0), y, { align: 'left' })
               .text(amount, amountX, y, { width: rowWidth, align: 'right' });
            doc.moveDown(isBold ? 1.2 : 1);
        };
        
        doc.fontSize(11).font(fontBold).text('Revenue', 50, doc.y);
        generateHr(doc, doc.y);
        doc.moveDown();
        drawRow('Total Sales Revenue', `${currency} ${totalRevenue.toLocaleString()}`);
        drawRow('Cost of Goods Sold (COGS)', `(${currency} ${cogs.toLocaleString()})`);
        doc.moveDown(0.5);
        generateHr(doc, doc.y);
        doc.moveDown(0.5);
        drawRow('Gross Profit', `${currency} ${grossProfit.toLocaleString()}`, true);
        doc.moveDown(2);

        // Check for page break before drawing Operating Expenses header
        if (doc.y + 100 > doc.page.height - doc.page.margins.bottom) doc.addPage();

        doc.fontSize(11).font(fontBold).text('Operating Expenses', 50, doc.y);
        generateHr(doc, doc.y);
        doc.moveDown();

        if (Object.keys(expensesByCategory).length > 0) {
            for (const [category, amount] of Object.entries(expensesByCategory)) {
                drawRow(category, `(${currency} ${amount.toLocaleString()})`, false, true);
            }
        } else {
            drawRow('No operating expenses logged.', ''); // Align the "No expenses" message
        }
        
        doc.moveDown(0.5);
        generateHr(doc, doc.y);
        doc.moveDown(0.5);
        drawRow('Total Operating Expenses', `(${currency} ${totalExpenses.toLocaleString()})`, true);
        doc.moveDown(2);
        
        // Final check before drawing the Net Profit box, considering footer space
        if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();

        const netProfitY = doc.y;
        doc.rect(50, netProfitY, 500, 30).fill(brandColor);
        doc.font(fontBold).fontSize(12).fillColor('white');
        doc.text('Net Profit / (Loss)', 60, netProfitY + 9);
        doc.text(`${currency} ${netProfit.toLocaleString()}`, 350, netProfitY + 9, { width: 190, align: 'right' });

        doc.end(); // End the document here to finalize page content
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => {
            generateFooter(doc); // Generate footer after all content is added and page count is final
            resolve(Buffer.concat(buffers));
        });
    });
}

export const ReportGenerators = {
    createMonthlyReportPDF,
    createInventoryReportPDF,
    createPnLReportPDF,
};
