import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

// --- Function for the Transaction Report ---
export async function generateMonthlyReportPDF(transactions, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = new PassThrough();
        const currency = user.currency || 'CURRENCY';
        
        doc.pipe(stream);

        // --- Report Header ---
        doc.fontSize(20).font('Helvetica-Bold').text('Monthly Financial Report', { align: 'center' });
        doc.fontSize(14).font('Helvetica').text(user.storeName || '', { align: 'center' });
        doc.fontSize(12).text(monthName, { align: 'center' });
        doc.moveDown(2);

        // --- Summary Section ---
        let totalIncome = 0;
        let totalExpense = 0;
        transactions.forEach(t => {
            if (t.type === 'income') totalIncome += t.amount;
            if (t.type === 'expense') totalExpense += t.amount;
        });
        const net = totalIncome - totalExpense;

        doc.fontSize(12).font('Helvetica-Bold').text('Summary', { underline: true });
        doc.moveDown();
        doc.font('Helvetica').text(`Total Income: ${currency} ${totalIncome.toLocaleString()}`);
        doc.text(`Total Expense: ${currency} ${totalExpense.toLocaleString()}`);
        doc.font('Helvetica-Bold').text(`Net Balance: ${currency} ${net.toLocaleString()}`);
        doc.moveDown(2);

        // --- Transactions Table Header ---
        doc.font('Helvetica-Bold').text('Detailed Transactions');
        doc.moveDown();
        const tableTop = doc.y;
        const itemX = 50;
        const dateX = 150;
        const typeX = 250;
        const amountX = 450;

        doc.fontSize(10)
           .text('Date', itemX, tableTop)
           .text('Description', dateX, tableTop)
           .text('Type', typeX, tableTop)
           .text(`Amount (${currency})`, amountX, tableTop, { align: 'right' });
        doc.moveTo(itemX, doc.y).lineTo(550, doc.y).stroke();
        
        // --- Transactions Table Rows ---
        doc.font('Helvetica');
        transactions.forEach(t => {
            const y = doc.y + 15;
            const formattedDate = t.createdAt.toLocaleDateString('en-GB');
            doc.fontSize(10)
               .text(formattedDate, itemX, y)
               .text(t.description, dateX, y)
               .text(t.type.charAt(0).toUpperCase() + t.type.slice(1), typeX, y)
               .text(t.amount.toLocaleString(), amountX, y, { align: 'right' });
            doc.moveTo(itemX, doc.y + 12).lineTo(550, doc.y + 12).strokeColor('#dddddd').stroke();
        });
        
        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

// --- Function for the Inventory & Profit Report ---
export async function generateInventoryReportPDF(products, logs, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50, layout: 'landscape' });
        const stream = new PassThrough();
        const currency = user.currency || 'CURRENCY';
        doc.pipe(stream);

        // Header
        doc.fontSize(20).font('Helvetica-Bold').text('Inventory & Profit Report', { align: 'center' });
        doc.fontSize(14).font('Helvetica').text(user.storeName || '', { align: 'center' });
        doc.fontSize(12).text(monthName, { align: 'center' });
        doc.moveDown(2);

        products.forEach((product, index) => {
            doc.fontSize(14).font('Helvetica-Bold').text(`Product: ${product.productName}`, { underline: true });
            doc.moveDown();

            const productLogs = logs.filter(log => log.productId.equals(product._id));
            const unitsSold = productLogs.filter(l => l.type === 'sale').reduce((sum, l) => sum - l.quantityChange, 0);
            const revenue = unitsSold * product.price;
            const costOfGoodsSold = unitsSold * product.cost;
            const profit = revenue - costOfGoodsSold;

            doc.fontSize(11).font('Helvetica')
               .text(`- Stock Status: ${product.stock} units remaining.`)
               .text(`- Units Sold this month: ${unitsSold}`)
               .text(`- Total Revenue: ${currency} ${revenue.toLocaleString()}`)
               .text(`- Cost of Goods Sold: ${currency} ${costOfGoodsSold.toLocaleString()}`)
               .font('Helvetica-Bold').text(`- Gross Profit: ${currency} ${profit.toLocaleString()}`)
               .font('Helvetica');
            doc.moveDown();

            if (productLogs.length > 0) {
                const tableTop = doc.y;
                doc.fontSize(9).font('Helvetica-Bold')
                   .text('Date', 50, tableTop)
                   .text('Action', 150, tableTop)
                   .text('Quantity Change', 350, tableTop)
                   .text('Notes', 500, tableTop);
                doc.moveTo(50, doc.y).lineTo(740, doc.y).stroke();
                
                doc.font('Helvetica');
                productLogs.forEach(log => {
                    const y = doc.y + 12;
                    doc.fontSize(9)
                       .text(log.createdAt.toLocaleDateString('en-GB'), 50, y)
                       .text(log.type.charAt(0).toUpperCase() + log.type.slice(1), 150, y)
                       .text(log.quantityChange.toString(), 350, y)
                       .text(log.notes || '', 500, y);
                    doc.moveTo(50, doc.y + 10).lineTo(740, doc.y + 10).strokeColor('#dddddd').stroke();
                });
            }
            if (index < products.length - 1) {
                doc.addPage({ margin: 50, layout: 'landscape' });
            }
        });

        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

// --- Function for the Profit & Loss Statement ---
export async function generatePnLReportPDF(data, monthName, user) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = new PassThrough();
        doc.pipe(stream);

        const { totalRevenue, cogs, expensesByCategory } = data;
        const grossProfit = totalRevenue - cogs;
        const totalExpenses = Object.values(expensesByCategory).reduce((sum, val) => sum + val, 0);
        const netProfit = grossProfit - totalExpenses;
        const currency = user.currency || 'CURRENCY';

        // Header
        doc.fontSize(20).font('Helvetica-Bold').text('Profit & Loss Statement', { align: 'center' });
        doc.fontSize(14).font('Helvetica').text(user.storeName, { align: 'center' });
        doc.fontSize(12).text(`For the Month of ${monthName}`, { align: 'center' });
        doc.moveDown(2);

        // Revenue Section
        doc.fontSize(14).font('Helvetica-Bold').text('Revenue');
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.fontSize(11).font('Helvetica').text('Total Sales Revenue', { continued: true }).text(currency + ' ' + totalRevenue.toLocaleString(), { align: 'right' });
        doc.moveDown();

        // COGS & Gross Profit
        doc.text('Cost of Goods Sold (COGS)', { continued: true }).text(currency + ' ' + cogs.toLocaleString(), { align: 'right' });
        doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('black').stroke();
        doc.font('Helvetica-Bold').text('Gross Profit', { continued: true }).text(currency + ' ' + grossProfit.toLocaleString(), { align: 'right' });
        doc.moveDown(2);

        // Operating Expenses Section
        doc.fontSize(14).font('Helvetica-Bold').text('Operating Expenses');
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.font('Helvetica');
        if (Object.keys(expensesByCategory).length > 0) {
            for (const [category, amount] of Object.entries(expensesByCategory)) {
                doc.text(category.charAt(0).toUpperCase() + category.slice(1), { continued: true }).text(currency + ' ' + amount.toLocaleString(), { align: 'right' });
            }
        } else {
            doc.text("No operating expenses logged.", { color: 'grey' });
        }
        doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('black').stroke();
        doc.font('Helvetica-Bold').text('Total Operating Expenses', { continued: true }).text(currency + ' ' + totalExpenses.toLocaleString(), { align: 'right' });
        doc.moveDown(2);

        // Net Profit Section
        const finalY = doc.y;
        doc.moveTo(50, finalY).lineTo(550, finalY).stroke();
        doc.moveTo(50, finalY + 1.5).lineTo(550, finalY + 1.5).stroke();
        doc.fontSize(14).font('Helvetica-Bold').text('Net Profit / (Loss)', { continued: true }).text(currency + ' ' + netProfit.toLocaleString(), { align: 'right' });
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveTo(50, doc.y + 1.5).lineTo(550, doc.y + 1.5).stroke();

        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}
