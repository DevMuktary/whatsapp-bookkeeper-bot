import axios from 'axios';
import * as XLSX from 'xlsx';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Downloads a file from WhatsApp and parses it as an Excel sheet.
 * Expected Columns: "Product Name", "Quantity", "Cost Price", "Selling Price"
 */
export async function parseExcelImport(mediaId) {
    try {
        // 1. Get the URL
        const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        const mediaUrl = urlRes.data.url;

        // 2. Download Binary
        const mediaRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });

        // 3. Parse Workbook
        const workbook = XLSX.read(mediaRes.data, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // 4. Convert to JSON
        const rawRows = XLSX.utils.sheet_to_json(worksheet);

        // 5. Map and Validate
        const products = [];
        const errors = [];

        rawRows.forEach((row, index) => {
            // Flexible column matching (case insensitive)
            const getCol = (keys) => {
                const found = Object.keys(row).find(k => keys.includes(k.toLowerCase().trim()));
                return found ? row[found] : null;
            };

            const name = getCol(['product name', 'name', 'item', 'product']);
            const qty = getCol(['quantity', 'qty', 'count', 'units']);
            const cost = getCol(['cost price', 'cost', 'cp', 'buying price']);
            const sell = getCol(['selling price', 'price', 'sp', 'sell']);

            if (name && qty) {
                products.push({
                    productName: name.toString().trim(),
                    quantityAdded: parseInt(qty) || 0,
                    costPrice: parseFloat(cost) || 0,
                    sellingPrice: parseFloat(sell) || 0
                });
            } else {
                errors.push(`Row ${index + 2}: Missing Name or Quantity.`);
            }
        });

        return { products, errors };

    } catch (error) {
        logger.error('Error parsing Excel import:', error);
        throw new Error('Failed to process the file. Please ensure it is a valid Excel file.');
    }
}
