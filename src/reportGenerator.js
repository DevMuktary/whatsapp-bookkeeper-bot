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
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);

        // Add page number
        doc.fontSize(8)
           .fillColor('#AAAAAA')
           .text(`Page ${i + 1} of ${range.count}`, 50, doc.page.height - 35, { align: 'right', width: 500 });

        // Add generation date
        const genDate = new Date().toLocaleString('en-GB');
        doc.fontSize(8)
           .fillColor('#AAAAAA')
           .text(`Generated on: ${genDate}`, 50, doc.page.height - 35, { align: 'left' });
    }
}

// --- Reusable function for drawing a horizontal line ---
function generateHr(doc, y) {
    doc.strokeColor("#AAAAAA").lineWidth(1).moveTo(50, y).lineTo(550, y).stroke();
}


function createMonthlyReportPDF(transactions, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50, bufferPages: true });
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
        
        let y = tableTop + 20;
        doc.fillColor('black').font(font);
        transactions.forEach((t, i) => {
            if ((doc.y + 20) > (doc.page.height - 50)) { doc.addPage(); y = 50; }
            if (i % 2 === 1) doc.rect(50, y, 500, 20).fill(lightGrey);
            
            const formattedDate = t.createdAt.toLocaleDateString('en-GB');
            doc.fontSize(9)
               .text(formattedDate, 60, y + 6, { width: 70 })
               .text(t.description, 140, y + 6, { width: 150 })
               .text(t.category, 300, y + 6, { width: 100 })
               .text(t.type.charAt(0).toUpperCase() + t.type.slice(1), 410, y + 6, { width: 50 })
               .text(t.amount.toLocaleString(), 460, y + 6, { width: 80, align: 'right' });
            y += 20;
        });

        generateFooter(doc);
        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

function createInventoryReportPDF(products, logs, monthName, user) {
     return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50, bufferPages: true });
        const stream = new PassThrough();
        const currency = user.currency || 'CUR';
        doc.pipe(stream);

        const addHeaderAndInfo = (isFirstPage) => {
            generateHeader(doc, user);
            doc.fillColor('#444444').fontSize(12).font(font).text('Inventory & Profitability Report', { align: 'left' });
            doc.fontSize(10).text(monthName, { align: 'left' });
            if (!isFirstPage) doc.moveDown(1);
        };
        
        doc.on('pageAdded', () => addHeaderAndInfo(false));
        addHeaderAndInfo(true);
        doc.moveDown(2);
        
        products.forEach((product, index) => {
            const productLogs = logs.filter(log => log.productId.equals(product._id));
            const unitsSold = productLogs.filter(l => l.type === 'sale').reduce((sum, l) => sum - l.quantityChange, 0);
            const revenue = unitsSold * product.price;
            const costOfGoodsSold = unitsSold * product.cost;
            const profit = revenue - costOfGoodsSold;

            if (doc.y > 650) doc.addPage();
            
            doc.font(fontBold).fontSize(14).text(product.productName);
            generateHr(doc, doc.y);
            doc.moveDown();

            doc.fontSize(10).font(fontBold).text('Current Status', 50, doc.y, { width: 250, continued: true }).font(font).text(`Remaining Stock: ${product.stock} units`);
            doc.moveDown(1.5);

            doc.font(fontBold).text('Monthly Performance');
            doc.font(font).text('Units Sold:', 70, doc.y, { continued: true }).text(`${unitsSold}`, { align: 'right' });
            doc.text('Revenue:', 70, doc.y, { continued: true }).text(`${currency} ${revenue.toLocaleString()}`, { align: 'right' });
            doc.text('Cost of Goods Sold:', 70, doc.y, { continued: true }).text(`${currency} ${costOfGoodsSold.toLocaleString()}`, { align: 'right' });
            doc.font(fontBold).text('Gross Profit:', 70, doc.y, { continued: true }).text(`${currency} ${profit.toLocaleString()}`, { align: 'right' });
            
            doc.moveDown(2);
        });

        generateFooter(doc);
        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

function createPnLReportPDF(data, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50, bufferPages: true });
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

        const itemX = 50;
        const amountX = 350;
        const rowWidth = 190;
        
        const drawRow = (label, amount, isBold = false, isSub = false) => {
            const y = doc.y;
            doc.font(isBold ? fontBold : font)
               .fontSize(isBold ? 10 : 9)
               .text(label, itemX + (isSub ? 15 : 0), y)
               .text(amount, amountX, y, { width: rowWidth, align: 'right' });
            doc.moveDown(0.7);
        };

        doc.fontSize(11).font(fontBold).text('Revenue');
        generateHr(doc, doc.y);
        doc.moveDown();
        drawRow('Total Sales Revenue', `${currency} ${totalRevenue.toLocaleString()}`);
        drawRow('Cost of Goods Sold (COGS)', `(${currency} ${cogs.toLocaleString()})`);
        doc.moveDown(0.5);
        generateHr(doc, doc.y);
        doc.moveDown(0.5);
        drawRow('Gross Profit', `${currency} ${grossProfit.toLocaleString()}`, true);
        doc.moveDown(2);

        doc.fontSize(11).font(fontBold).text('Operating Expenses');
        generateHr(doc, doc.y);
        doc.moveDown();

        if (Object.keys(expensesByCategory).length > 0) {
            for (const [category, amount] of Object.entries(expensesByCategory)) {
                drawRow(category, `(${currency} ${amount.toLocaleString()})`, false, true);
            }
        } else {
            doc.fontSize(9).font(font).text('No operating expenses logged.', { indent: 15 });
            doc.moveDown();
        }
        
        doc.moveDown(0.5);
        generateHr(doc, doc.y);
        doc.moveDown(0.5);
        drawRow('Total Operating Expenses', `(${currency} ${totalExpenses.toLocaleString()})`, true);
        doc.moveDown(2);

        const netProfitY = doc.y;
        doc.rect(itemX, netProfitY, 500, 25).fill(brandColor);
        
        doc.font(fontBold).fontSize(12).fillColor('white');
        doc.text('Net Profit / (Loss)', itemX + 10, netProfitY + 7);
        doc.text(`${currency} ${netProfit.toLocaleString()}`, amountX, netProfitY + 7, { width: rowWidth, align: 'right' });

        generateFooter(doc);
        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

export const ReportGenerators = {
    createMonthlyReportPDF,
    createInventoryReportPDF,
    createPnLReportPDF,
};
