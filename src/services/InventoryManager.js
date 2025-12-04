import { upsertProduct } from '../db/productService.js';
import { updateBankBalance } from '../db/bankService.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

export async function addProduct(user, productData) {
    // [UPDATED] Destructure reorderLevel
    const { productName, quantityAdded, costPrice, sellingPrice, linkedBankId, reorderLevel } = productData;
    
    const quantity = parseInt(quantityAdded, 10);
    const cost = parseFloat(costPrice);
    const sell = parseFloat(sellingPrice);
    const alertThreshold = reorderLevel ? parseInt(reorderLevel, 10) : 5; // Default 5

    // Update/Create the product
    const product = await upsertProduct(user._id, productName, quantity, cost, sell, alertThreshold);

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
                p.sellingPrice,
                5 // Default reorder level for bulk (can be improved later)
            );
            results.added.push(product);
        } catch (error) {
            logger.error(`Failed to add product ${p.productName} in bulk op`, error);
            results.errors.push(p.productName);
        }
    }
    
    return results;
}
