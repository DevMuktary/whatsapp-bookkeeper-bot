import { upsertProduct } from '../db/productService.js';
import { updateBankBalance } from '../db/bankService.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

export async function addProduct(user, productData) {
    // Destructure reorderLevel and linkedBankId
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

    let totalCostToDeduct = 0;
    let bankIdToDeduct = null;

    for (const p of productsList) {
        try {
            const product = await upsertProduct(
                user._id, 
                p.productName, 
                p.quantityAdded, 
                p.costPrice, 
                p.sellingPrice,
                5 // Default reorder level for bulk
            );
            results.added.push(product);

            // [FIX] Accumulate Cost for Bank Deduction
            // Check if this specific item has a bank linked (passed from handler)
            if (p.linkedBankId && p.quantityAdded > 0 && p.costPrice > 0) {
                totalCostToDeduct += (p.quantityAdded * p.costPrice);
                
                // Capture the bank ID (assuming all items in one bulk batch use the same bank)
                if (!bankIdToDeduct) {
                    bankIdToDeduct = p.linkedBankId;
                }
            }

        } catch (error) {
            logger.error(`Failed to add product ${p.productName} in bulk op`, error);
            results.errors.push(p.productName);
        }
    }
    
    // [FIX] Perform the Bank Deduction
    if (bankIdToDeduct && totalCostToDeduct > 0) {
        try {
            // Ensure ID is in ObjectId format
            const bankId = typeof bankIdToDeduct === 'string' ? new ObjectId(bankIdToDeduct) : bankIdToDeduct;
            
            await updateBankBalance(bankId, -totalCostToDeduct);
            logger.info(`Bulk Import: Deducted total ${totalCostToDeduct} from bank ${bankId}`);
        } catch (err) {
            logger.error("Failed to deduct bulk cost from bank:", err);
            // We don't stop the process here because products are already added, 
            // but we log the error for review.
        }
    }

    return results;
}
