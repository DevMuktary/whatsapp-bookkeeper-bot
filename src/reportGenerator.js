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
       .text(user.storeName || 'Business Report', { align: 'left' });
    doc.moveDown(0.5);
}

// --- Reusable Footer Function ---
function generateFooter(doc) {
    doc.strokeColor('#AAAAAA')
       .lineWidth(1)
       .moveTo(50, doc.page.height - 50)
       .lineTo(doc.page.width - 50, doc.page.height - 50)
       .stroke();
    
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(8)
           .fillColor('#AAAAAA')
           .text(`Page ${i + 1} of ${range.count}`, 50, doc.page.height - 45, { align: 'right' });
    }
}

// --- Reusable function for P&L and Summary rows ---
function generateHr(doc, y) {
    doc.strokeColor("#AAAAAA").lineWidth(1).moveTo(50, y).lineTo(550, y).stroke();
}

function generateReportRow(doc, y, label, value, currency, isBold = false) {
    doc.fontSize(10)
       .font(isBold ? fontBold : font)
       .fillColor('black')
       .text(label, 50, y)
       .text(`${currency} ${value}`, 0, y, { align: 'right' });
}


function createMonthlyReportPDF(transactions, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50, bufferPages: true });
        const stream = new PassThrough();
        doc.pipe(stream);

        // --- Header ---
        generateHeader(doc, user);
        doc.fillColor('#444444').fontSize(12).font(font).text('Monthly Financial Report', { align: 'left' });
        doc.fontSize(10).text(monthName, { align: 'left' });
        doc.moveDown(2);

        // --- Summary Section ---
        let totalIncome = 0;
        let totalExpense = 0;
        transactions.forEach(t => {
            if (t.type === 'income') totalIncome += t.amount;
            if (t.type === 'expense') totalExpense += t.amount;
        });
        const net = totalIncome - totalExpense;

        doc.font(fontBold).text('Summary', { underline: true });
        doc.moveDown();
        generateReportRow(doc, doc.y, 'Total Income:', totalIncome.toLocaleString(), user.currency || 'CUR');
        generateReportRow(doc, doc.y + 15, 'Total Expenses:', totalExpense.toLocaleString(), user.currency || 'CUR');
        generateReportRow(doc, doc.y + 30, 'Net Balance:', net.toLocaleString(), user.currency || 'CUR', true);
        doc.moveDown(3);

        // --- Transactions Table ---
        doc.font(fontBold).text('Detailed Transactions', { underline: true });
        doc.moveDown();
        
        const tableTop = doc.y;
        const tableHeaders = ['Date', 'Description', 'Category', 'Type', 'Amount'];
        
        // Draw Table Header
        doc.fontSize(10).font(fontBold);
        doc.rect(50, tableTop, 500, 20).fill(brandColor);
        doc.fillColor('white');
        doc.text(tableHeaders[0], 60, tableTop + 6, { width: 70 });
        doc.text(tableHeaders[1], 140, tableTop + 6, { width: 150 });
        doc.text(tableHeaders[2], 300, tableTop + 6, { width: 100 });
        doc.text(tableHeaders[3], 410, tableTop + 6, { width: 50 });
        doc.text(tableHeaders[4], 470, tableTop + 6, { width: 70, align: 'right' });
        
        let y = tableTop + 20;
        doc.fillColor('black').font(font);

        transactions.forEach((t, i) => {
            // Zebra stripes for rows
            if (i % 2 === 0) {
                doc.rect(50, y, 500, 20).fill(lightGrey);
            }
            const formattedDate = t.createdAt.toLocaleDateString('en-GB');
            doc.fontSize(9)
               .text(formattedDate, 60, y + 6, { width: 70 })
               .text(t.description, 140, y + 6, { width: 150 })
               .text(t.category, 300, y + 6, { width: 100 })
               .text(t.type.charAt(0).toUpperCase() + t.type.slice(1), 410, y + 6, { width: 50 })
               .text(t.amount.toLocaleString(), 470, y + 6, { width: 70, align: 'right' });
            y += 20;
        });

        // --- Footer ---
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
        doc.pipe(stream);

        doc.on('pageAdded', () => generateHeader(doc, user));
        
        generateHeader(doc, user);
        doc.fillColor('#444444').fontSize(12).font(font).text('Inventory & Profitability Report', { align: 'left' });
        doc.fontSize(10).text(monthName, { align: 'left' });
        doc.moveDown(2);
        
        products.forEach((product, index) => {
            const productLogs = logs.filter(log => log.productId.equals(product._id));
            const unitsSold = productLogs.filter(l => l.type === 'sale').reduce((sum, l) => sum - l.quantityChange, 0);
            const revenue = unitsSold * product.price;
            const costOfGoodsSold = unitsSold * product.cost;
            const profit = revenue - costOfGoodsSold;

            doc.font(fontBold).fontSize(14).text(product.productName);
            generateHr(doc, doc.y);
            doc.moveDown();

            doc.fontSize(10).font(fontBold).text('Current Status', 50, doc.y);
            doc.font(font).text(`Remaining Stock: ${product.stock} units`, 70, doc.y);
            doc.moveDown(1.5);

            doc.font(fontBold).text('Monthly Performance', 50, doc.y);
            doc.font(font).text(`Units Sold: ${unitsSold}`, 70, doc.y);
            doc.text(`Revenue: ${(user.currency || 'CUR')} ${revenue.toLocaleString()}`, 70, doc.y + 15);
            doc.text(`Cost of Goods Sold: ${(user.currency || 'CUR')} ${costOfGoodsSold.toLocaleString()}`, 70, doc.y + 30);
            doc.font(fontBold).text(`Gross Profit: ${(user.currency || 'CUR')} ${profit.toLocaleString()}`, 70, doc.y + 45);
            
            doc.moveDown(2);

            if (productLogs.length > 0) {
                doc.font(fontBold).text('Monthly Activity Log');
                doc.moveDown();
                // Draw Table for logs...
            }
            
            if (index < products.length - 1) doc.addPage();
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
        doc.pipe(stream);

        const { totalRevenue, cogs, expensesByCategory } = data;
        const grossProfit = totalRevenue - cogs;
        const totalExpenses = Object.values(expensesByCategory).reduce((sum, val) => sum + val, 0);
        const netProfit = grossProfit - totalExpenses;
        const currency = user.currency || 'CUR';

        // --- Header ---
        generateHeader(doc, user);
        doc.fillColor('#444444').fontSize(12).font(font).text('Profit & Loss Statement', { align: 'left' });
        doc.fontSize(10).text(`For the Month of ${monthName}`, { align: 'left' });
        doc.moveDown(3);

        // --- Revenue Section ---
        doc.fontSize(12).font(fontBold).text('Revenue');
        generateHr(doc, doc.y);
        doc.moveDown();
        generateReportRow(doc, doc.y, 'Total Sales Revenue', totalRevenue.toLocaleString(), currency);
        generateReportRow(doc, doc.y + 15, 'Cost of Goods Sold (COGS)', `(${cogs.toLocaleString()})`, currency);
        doc.moveDown(2);
        generateHr(doc, doc.y);
        doc.moveDown(0.5);
        generateReportRow(doc, doc.y, 'Gross Profit', grossProfit.toLocaleString(), currency, true);
        doc.moveDown(3);

        // --- Expenses Section ---
        doc.fontSize(12).font(fontBold).text('Operating Expenses');
        generateHr(doc, doc.y);
        doc.moveDown();
        let yPos = doc.y;
        if (Object.keys(expensesByCategory).length > 0) {
            for (const [category, amount] of Object.entries(expensesByCategory)) {
                generateReportRow(doc, yPos, category, `(${amount.toLocaleString()})`, currency);
                yPos += 15;
            }
        } else {
            doc.fontSize(10).font(font).text("No operating expenses logged this month.", { indent: 20 });
            yPos += 15;
        }
        doc.y = yPos;
        doc.moveDown();
        generateHr(doc, doc.y);
        doc.moveDown(0.5);
        generateReportRow(doc, doc.y, 'Total Operating Expenses', `(${totalExpenses.toLocaleString()})`, currency, true);
        doc.moveDown(3);

        // --- Net Profit Section ---
        doc.rect(50, doc.y, 500, 25).fill(brandColor);
        doc.fontSize(12).font(fontBold).fillColor('white');
        doc.text('Net Profit / (Loss)', 60, doc.y + 8);
        doc.text(`${currency} ${netProfit.toLocaleString()}`, 0, doc.y + 8, { align: 'right', indent: -10 });

        // --- Footer ---
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
