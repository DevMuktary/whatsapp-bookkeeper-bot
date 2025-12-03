import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findProductByName, updateStock } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction } from '../db/transactionService.js';
import { updateBankBalance } from '../db/bankService.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

/**
 * Orchestrates the complex logic of logging a sale:
 * 1. Validates items.
 * 2. Snapshots the current Cost Price (CRITICAL FIX).
 * 3. Updates Inventory.
 * 4. Updates Customer Balance or Bank Balance.
 * 5. Creates the Transaction Record.
 */
export async function logSale(user, saleData) {
    const { items, customerName, saleType, linkedBankId } = saleData;
    if (!items || items.length === 0) throw new Error("No items found in the sale data.");

    const customer = await findOrCreateCustomer(user._id, customerName);
    let totalAmount = 0;
    let descriptionParts = [];
    const processedItems = [];

    // --- STEP 1 & 2: Process Items & Snapshot Cost ---
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        
        // Basic Validation
        if (!item.productName || !item.quantity || isNaN(item.quantity) || item.pricePerUnit === undefined || isNaN(item.pricePerUnit)) {
             throw new Error(`Item ${i+1} (${item.productName || 'Unknown'}) has invalid details.`);
        }

        const quantity = parseFloat(item.quantity);
        const price = parseFloat(item.pricePerUnit);
        totalAmount += quantity * price;

        let costPriceSnapshot = 0;
        let productId = null;

        // If it's a product (not service), get the current Cost Price for accurate P&L
        if (!item.isService) {
            const product = await findProductByName(user._id, item.productName);
            if (product) {
                productId = product._id;
                // SNAPSHOT: Use the product's current cost price at this exact moment
                costPriceSnapshot = product.costPrice || 0;
            }
        }

        processedItems.push({
            productId: productId,
            productName: item.productName,
            quantity: quantity,
            pricePerUnit: price,
            costPrice: costPriceSnapshot, // <--- Stored permanently in the transaction
            isService: !!item.isService
        });
        
        descriptionParts.push(`${quantity} x ${item.productName}`);
    }

    const description = `${descriptionParts.join(', ')} sold to ${customerName}`;

    // --- STEP 3: Create Transaction ---
    const transactionData = { 
        userId: user._id, 
        totalAmount, 
        items: processedItems, 
        date: new Date(), 
        description, 
        linkedCustomerId: customer._id, 
        linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null, 
        paymentMethod: saleType 
    };

    const transaction = await createSaleTransaction(transactionData);

    // --- STEP 4: Update Inventory (Concurrency Safe) ---
    for (const item of processedItems) {
        if (item.productId && !item.isService) {
             // We pass the transaction ID to link the inventory log
             await updateStock(item.productId, -item.quantity, 'SALE', transaction._id);
        }
    }
   
    // --- STEP 5: Financial Updates ---
    if (saleType.toLowerCase() === 'credit') {
        await updateBalanceOwed(customer._id, totalAmount);
    } else if (linkedBankId) {
        await updateBankBalance(new ObjectId(linkedBankId), totalAmount);
    }

    return transaction;
}

export async function logExpense(user, expenseData) {
    const { category, amount, description, linkedBankId } = expenseData;
    
    // Create Record
    const transaction = await createExpenseTransaction({
        userId: user._id,
        amount: parseFloat(amount),
        date: new Date(),
        description,
        category,
        linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null
    });

    // Deduct from Bank
    if (linkedBankId) {
        await updateBankBalance(new ObjectId(linkedBankId), -parseFloat(amount));
    }

    return transaction;
}

export async function logCustomerPayment(user, paymentData) {
    const { customerName, amount, linkedBankId } = paymentData;
    const paymentAmount = parseFloat(amount);

    const customer = await findOrCreateCustomer(user._id, customerName);

    // Create Record
    const transaction = await createCustomerPaymentTransaction({
        userId: user._id,
        linkedCustomerId: customer._id,
        amount: paymentAmount,
        date: new Date(),
        description: `Payment received from ${customer.customerName}`,
        linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null
    });

    // Update Balances
    const updatedCustomer = await updateBalanceOwed(customer._id, -paymentAmount);
    
    if (linkedBankId) {
        await updateBankBalance(new ObjectId(linkedBankId), paymentAmount);
    }

    return { transaction, updatedCustomer };
}
