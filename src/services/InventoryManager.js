import { upsertProduct } from '../db/productService.js';
import { updateBankBalance } from '../db/bankService.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

export async function addProduct(user, productData) {
    const { productName, quantityAdded, costPrice, sellingPrice, linkedBankId } = productData;
    
    const quantity = parseInt(quantityAdded, 10);
    const cost = parseFloat(costPrice);
    const sell = parseFloat(sellingPrice);

    // Update/Create the product
    const product = await upsertProduct(user._id, productName, quantity, cost, sell);

    // Handle Bank Deduction for Stock Purchase
    if (quantity > 0 && linkedBankId) {
        const totalCost = cost * quantity;
        if (totalCost > 0) {
            await updateBankBalance(new ObjectId(linkedBankId), -totalCost);
            logger.info(`Deducted ${totalCost} from bank ${linkedBankId} for inventory purchase.`);
        }
    }

    return product;
}

export async function addBulkProducts(user, productsList) {
    const results = {
        added: [],
        errors: []
    };

    for (const p of productsList) {
        try {
            const product = await upsertProduct(
                user._id, 
                p.productName, 
                p.quantityAdded, 
                p.costPrice, 
                p.sellingPrice
            );
            results.added.push(product);
        } catch (error) {
            logger.error(`Failed to add product ${p.productName} in bulk op`, error);
            results.errors.push(p.productName);
        }
    }
    
    // NOTE: We are NOT deducting from bank for bulk uploads yet as it requires 
    // asking the user which bank to use for the *sum* of all items. 
    // This can be added as a future feature.

    return results;
}
