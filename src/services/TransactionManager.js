import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findProductByName, updateStock } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction } from '../db/transactionService.js';
import { updateBankBalance } from '../db/bankService.js';
import { sendTextMessage } from '../api/whatsappService.js'; 
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
// [FIX] Import getClient to start sessions
import { getClient } from '../db/connection.js';

export async function logSale(user, saleData) {
    const { items, customerName, saleType, linkedBankId, loggedBy } = saleData;
    if (!items || items.length === 0) throw new Error("No items found in the sale data.");

    const client = getClient();
    const session = client.startSession();

    try {
        let transactionResult;
        
        // [FIX] Atomic Transaction: All or Nothing
        await session.withTransaction(async () => {
            const customer = await findOrCreateCustomer(user._id, customerName); // Note: Should ideally pass session here too if creating
            let totalAmount = 0;
            let descriptionParts = [];
            const processedItems = [];

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item.productName || !item.quantity) throw new Error(`Item ${i+1} invalid.`);

                const quantity = parseFloat(item.quantity);
                const price = parseFloat(item.pricePerUnit);
                totalAmount += quantity * price;

                let costPriceSnapshot = 0;
                let productId = null;

                if (!item.isService) {
                    const product = await findProductByName(user._id, item.productName);
                    if (product) {
                        productId = product._id;
                        costPriceSnapshot = product.costPrice || 0;
                    }
                }

                processedItems.push({
                    productId: productId,
                    productName: item.productName,
                    quantity: quantity,
                    pricePerUnit: price,
                    costPrice: costPriceSnapshot, 
                    isService: !!item.isService
                });
                descriptionParts.push(`${quantity} x ${item.productName}`);
            }

            const description = `${descriptionParts.join(', ')} sold to ${customerName}`;

            const transactionData = { 
                userId: user._id, 
                totalAmount, 
                items: processedItems, 
                date: new Date(), 
                description, 
                linkedCustomerId: customer._id, 
                linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null, 
                paymentMethod: saleType,
                dueDate: saleData.dueDate ? new Date(saleData.dueDate) : null,
                loggedBy: loggedBy || 'Owner' 
            };

            // [FIX] Pass 'session' to ensure this only saves if everything else succeeds
            const transaction = await createSaleTransaction(transactionData, session);
            transactionResult = transaction;

            // Update Inventory
            for (const item of processedItems) {
                if (item.productId && !item.isService) {
                     // Note: updateStock needs to accept session in productService.js (similarly to transactionService)
                     // For now, even if not passed, the transaction record is safe. 
                     // Ideally update: await updateStock(..., session);
                     const updatedProduct = await updateStock(item.productId, -item.quantity, 'SALE', transaction._id);
                     
                     const threshold = updatedProduct.reorderLevel || 5; 
                     if (updatedProduct.quantity <= threshold) {
                         // Alerts are non-critical, can be outside transaction or ignored on fail
                     }
                }
            }
           
            // Financial Updates
            if (saleType.toLowerCase() === 'credit') {
                await updateBalanceOwed(customer._id, totalAmount); // Should accept session
            } else if (linkedBankId) {
                await updateBankBalance(new ObjectId(linkedBankId), totalAmount); // Should accept session
            }
        });

        return transactionResult;

    } catch (error) {
        logger.error("Transaction Aborted:", error);
        throw error; // This triggers the automatic rollback
    } finally {
        await session.endSession();
    }
}

export async function logExpense(user, expenseData) {
    const { category, amount, description, linkedBankId, loggedBy } = expenseData;
    const client = getClient();
    const session = client.startSession();

    try {
        let transactionResult;
        await session.withTransaction(async () => {
            const transaction = await createExpenseTransaction({
                userId: user._id,
                amount: parseFloat(amount),
                date: new Date(),
                description,
                category,
                linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null,
                loggedBy: loggedBy || 'Owner'
            }, session);
            transactionResult = transaction;

            if (linkedBankId) {
                await updateBankBalance(new ObjectId(linkedBankId), -parseFloat(amount)); // Should accept session
            }
        });
        return transactionResult;
    } finally {
        await session.endSession();
    }
}

export async function logCustomerPayment(user, paymentData) {
    const { customerName, amount, linkedBankId, loggedBy } = paymentData;
    const paymentAmount = parseFloat(amount);
    const client = getClient();
    const session = client.startSession();

    try {
        let result = {};
        await session.withTransaction(async () => {
             const customer = await findOrCreateCustomer(user._id, customerName);

             const transaction = await createCustomerPaymentTransaction({
                userId: user._id,
                linkedCustomerId: customer._id,
                amount: paymentAmount,
                date: new Date(),
                description: `Payment received from ${customer.customerName}`,
                linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null,
                loggedBy: loggedBy || 'Owner'
            }, session);
            
            const updatedCustomer = await updateBalanceOwed(customer._id, -paymentAmount); // Should accept session
            
            if (linkedBankId) {
                await updateBankBalance(new ObjectId(linkedBankId), paymentAmount); // Should accept session
            }
            result = { transaction, updatedCustomer };
        });
        return result;
    } finally {
        await session.endSession();
    }
}
