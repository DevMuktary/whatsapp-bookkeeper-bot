import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

export async function generateMonthlyReportPDF(transactions, monthName) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = new PassThrough();
        
        doc.pipe(stream);

        // --- Report Header ---
        doc.fontSize(20).font('Helvetica-Bold').text('Monthly Financial Report', { align: 'center' });
        doc.fontSize(14).font('Helvetica').text(monthName, { align: 'center' });
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
        doc.font('Helvetica').text(`Total Income: NGN ${totalIncome.toLocaleString()}`);
        doc.text(`Total Expense: NGN ${totalExpense.toLocaleString()}`);
        doc.font('Helvetica-Bold').text(`Net Balance: NGN ${net.toLocaleString()}`);
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
           .text('Amount (NGN)', amountX, tableTop, { align: 'right' });
        doc.moveTo(itemX, doc.y).lineTo(550, doc.y).stroke(); // Underline header
        
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
            doc.moveTo(itemX, doc.y + 12).lineTo(550, doc.y + 12).strokeColor('#dddddd').stroke(); // Separator line
        });
        
        // Finalize the PDF and resolve the promise with the buffer
        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}
