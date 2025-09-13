import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

// ... (The generateMonthlyReportPDF function remains here, unchanged)

export async function generateInventoryReportPDF(products, logs, monthName) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50, layout: 'landscape' });
        const stream = new PassThrough();
        doc.pipe(stream);

        // Header
        doc.fontSize(20).font('Helvetica-Bold').text('Inventory & Profit Report', { align: 'center' });
        doc.fontSize(14).font('Helvetica').text(monthName, { align: 'center' });
        doc.moveDown(2);

        products.forEach(product => {
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
               .text(`- Total Revenue: NGN ${revenue.toLocaleString()}`)
               .text(`- Cost of Goods Sold: NGN ${costOfGoodsSold.toLocaleString()}`)
               .font('Helvetica-Bold').text(`- Gross Profit: NGN ${profit.toLocaleString()}`)
               .font('Helvetica');
            doc.moveDown();

            // Detailed Log Table
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
            doc.moveDown(3);
        });

        doc.end();
        const buffers = [];
        stream.on('data', chunk => buffers.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}
