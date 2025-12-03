import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define path to templates
const TEMPLATE_DIR = path.join(__dirname, '../templates');

/**
 * Generates a PDF from an EJS template.
 * @param {string} templateName - The name of the template file (e.g., 'invoice', 'report').
 * @param {object} data - The data object to inject into the template.
 * @returns {Promise<Buffer>} The PDF buffer.
 */
export async function generatePDFFromTemplate(templateName, data) {
    let browser;
    try {
        const templatePath = path.join(TEMPLATE_DIR, `${templateName}.ejs`);
        
        // 1. Render HTML
        const html = await ejs.renderFile(templatePath, data);

        // 2. Launch Puppeteer
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Required for some cloud environments
        });
        const page = await browser.newPage();

        // 3. Set Content
        await page.setContent(html, { waitUntil: 'networkidle0' });

        // 4. Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20px',
                bottom: '20px',
                left: '20px',
                right: '20px'
            }
        });

        logger.info(`Generated PDF for ${templateName}`);
        return pdfBuffer;

    } catch (error) {
        logger.error(`Error generating PDF for ${templateName}:`, error);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
}

// These legacy functions are replaced by the generic generatePDFFromTemplate
// but we can keep wrappers for backward compatibility if needed:
export async function generateInvoice(user, transaction, customer) {
    return generatePDFFromTemplate('invoice', {
        businessName: user.businessName,
        email: user.email,
        transactionId: transaction._id.toString(),
        date: new Date(transaction.date).toLocaleDateString(),
        customerName: customer.customerName,
        items: transaction.items,
        totalAmount: transaction.amount,
        currency: user.currency
    });
}
