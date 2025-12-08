import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findProductByName, updateStock } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction } from '../db/transactionService.js';
import { updateBankBalance } from '../db/bankService.js';
import { sendTextMessage } from '../api/whatsappService.js'; 
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js'; 

export async function logSale(user, saleData) {
    const { items, customerName, saleType, linkedBankId, loggedBy } = saleData;
    if (!items || items.length === 0) throw new Error("No items found in the sale data.");

    // [CRASH FIX] Handle missing saleType safely. Default to CASH.
    const finalSaleType = saleType ? saleType : 'CASH';

    // Start a MongoDB Session for Atomicity
    const client = getDB().client;
    const session = client.startSession();

    try {
        let transactionResult;

        await session.withTransaction(async () => {
            // Pass 'session' to all DB calls to ensure they are part of the transaction
            const customer = await findOrCreateCustomer(user._id, customerName, { session });
            let totalAmount = 0;
            let descriptionParts = [];
            const processedItems = [];

            // --- STEP 1: Process Items & Calculate Totals ---
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                
                if (!item.productName || !item.quantity || isNaN(item.quantity) || item.pricePerUnit === undefined || isNaN(item.pricePerUnit)) {
                     throw new Error(`Item ${i+1} (${item.productName || 'Unknown'}) has invalid details.`);
                }

                const quantity = parseFloat(item.quantity);
                const price = parseFloat(item.pricePerUnit);
                totalAmount += quantity * price;

                let costPriceSnapshot = 0;
                let productId = null;

                // [INVENTORY FIX] Priority 1: Use the ID if the Smart Handler passed it
                if (item.productId) {
                    productId = new ObjectId(item.productId);
                    
                    // Fetch Cost Price (Read op can be outside transaction or inside, inside is safer for consistency)
                    const product = await getDB().collection('products').findOne({ _id: productId }, { session });
                    if (product) {
                        costPriceSnapshot = product.costPrice || 0;
                    }
                } 
                // Priority 2: Lookup by Name (Legacy/Fallback)
                else if (!item.isService) {
                    const cleanName = item.productName.trim(); 
                    const product = await findProductByName(user._id, cleanName, { session });
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

            // --- STEP 2: Create Transaction ---
            const transactionData = { 
                userId: user._id, 
                totalAmount, 
                items: processedItems, 
                date: new Date(), 
                description, 
                linkedCustomerId: customer._id, 
                linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null, 
                paymentMethod: finalSaleType.toUpperCase(), 
                dueDate: saleData.dueDate ? new Date(saleData.dueDate) : null,
                loggedBy: loggedBy || 'Owner' 
            };

            const transaction = await createSaleTransaction(transactionData, { session });
            transactionResult = transaction;

            // --- STEP 3: Update Inventory ---
            for (const item of processedItems) {
                if (item.productId && !item.isService) {
                     const updatedProduct = await updateStock(item.productId, -item.quantity, 'SALE', transaction._id, { session });
                     
                     // Alert logic can happen after transaction commits (it's a side effect)
                     // But we capture the data here.
                     if (updatedProduct.quantity <= (updatedProduct.reorderLevel || 5)) {
                         // We'll send the alert AFTER the transaction block to avoid holding the lock
                         transactionResult.lowStockAlert = updatedProduct;
                     }
                }
            }
           
            // --- STEP 4: Financial Updates ---
            if (finalSaleType.toLowerCase() === 'credit') {
                await updateBalanceOwed(customer._id, totalAmount, { session });
            } else if (linkedBankId) {
                await updateBankBalance(new ObjectId(linkedBankId), totalAmount, { session });
            }
        });

        // --- STEP 5: Post-Transaction Side Effects (Notifications) ---
        if (transactionResult?.lowStockAlert) {
            const p = transactionResult.lowStockAlert;
            await sendTextMessage(user.whatsappId, 
                `⚠️ *Low Stock Alert:*\n"${p.productName}" is down to *${p.quantity} units*.\n\nReply with 'Restock ${p.productName} ...' to add more.`
            );
        }

        return transactionResult;

    } catch (error) {
        logger.error('Transaction Failed (Rolled Back):', error);
        throw error; // Re-throw to handler
    } finally {
        await session.endSession();
    }
}

export async function logExpense(user, expenseData) {
    const { category, amount, description, linkedBankId, loggedBy } = expenseData;
    
    const client = getDB().client;
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
            }, { session });

            if (linkedBankId) {
                await updateBankBalance(new ObjectId(linkedBankId), -parseFloat(amount), { session });
            }
            
            transactionResult = transaction;
        });

        return transactionResult;
    } catch (error) {
        logger.error('Expense Log Failed (Rolled Back):', error);
        throw error;
    } finally {
        await session.endSession();
    }
}

export async function logCustomerPayment(user, paymentData) {
    const { customerName, amount, linkedBankId, loggedBy } = paymentData;
    const paymentAmount = parseFloat(amount);

    const client = getDB().client;
    const session = client.startSession();

    try {
        let resultData;

        await session.withTransaction(async () => {
            const customer = await findOrCreateCustomer(user._id, customerName, { session });

            const transaction = await createCustomerPaymentTransaction({
                userId: user._id,
                linkedCustomerId: customer._id,
                amount: paymentAmount,
                date: new Date(),
                description: `Payment received from ${customer.customerName}`,
                linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null,
                loggedBy: loggedBy || 'Owner'
            }, { session });

            const updatedCustomer = await updateBalanceOwed(customer._id, -paymentAmount, { session });
            
            if (linkedBankId) {
                await updateBankBalance(new ObjectId(linkedBankId), paymentAmount, { session });
            }

            resultData = { transaction, updatedCustomer };
        });

        return resultData;
    } catch (error) {
        logger.error('Customer Payment Failed (Rolled Back):', error);
        throw error;
    } finally {
        await session.endSession();
    }
}
