import axios from 'axios';
import * as XLSX from 'xlsx';
import config from '../config/index.js';
import logger from '../utils/logger.js';

// [FIX] Limit file size to 5MB to prevent RAM crashes (Excel Bomb)
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; 

export async function parseExcelImport(mediaId) {
    try {
        // 1. Get the download URL
        const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        const mediaUrl = urlRes.data.url;

        // 2. Download the file with strict size limits
        const mediaRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` },
            maxContentLength: MAX_FILE_SIZE_BYTES, // [CRITICAL FIX] Abort if > 5MB
            maxBodyLength: MAX_FILE_SIZE_BYTES     // [CRITICAL FIX] Abort if > 5MB
        });

        // 3. Parse Excel
        const workbook = XLSX.read(mediaRes.data, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        const rawRows = XLSX.utils.sheet_to_json(worksheet);

        // [FIX] Excel Row Limit (Logic protection)
        if (rawRows.length > 500) {
            throw new Error(`File too large (${rawRows.length} rows). Please upload less than 500 items at a time.`);
        }

        const products = [];
        const errors = [];

        rawRows.forEach((row, index) => {
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
        if (error.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' || error.message.includes('maxContentLength')) {
            logger.warn('File upload blocked: Too large.');
            throw new Error('File is too large! Please upload a file smaller than 5MB.');
        }
        logger.error('Error parsing Excel import:', error);
        throw new Error(error.message || 'Failed to process the file.');
    }
}
