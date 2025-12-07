import axios from 'axios';
import * as XLSX from 'xlsx';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export async function parseExcelImport(mediaId) {
    try {
        const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        const mediaUrl = urlRes.data.url;

        const mediaRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });

        const workbook = XLSX.read(mediaRes.data, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        const rawRows = XLSX.utils.sheet_to_json(worksheet);

        // [FIX] Excel Bomb Protection
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
        logger.error('Error parsing Excel import:', error);
        throw new Error(error.message || 'Failed to process the file.');
    }
}
