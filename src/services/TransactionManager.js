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

    // Handle missing saleType safely. Default to CASH.
    const finalSaleType = saleType ? saleType : 'CASH';

    // Robust Credit Detection (Checks for "Credit" anywhere in the string)
    const isCredit = finalSaleType.toLowerCase().includes('credit');

    // [FIX] Safely handle Linked Bank ID
    // If it's already an ObjectId, don't try to create a new one (prevents crash)
    let safeBankId = null;
    if (linkedBankId) {
        try {
            safeBankId = (typeof linkedBankId === 'string') ? new ObjectId(linkedBankId) : linkedBankId;
        } catch (e) {
            logger.error(`Invalid Bank ID provided: ${linkedBankId}`);
            // Fallback: Don't crash, just log without bank link
            safeBankId = null;
        }
    }

    const client = getDB().client;
    const session = client.startSession();

    try {
        let transactionResult;

        await session.withTransaction(async () => {
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

                if (item.productId) {
                    try {
                        productId = (typeof item.productId === 'string') ? new ObjectId(item.productId) : item.productId;
                        const product = await getDB().collection('products').findOne({ _id: productId }, { session });
                        if (product) costPriceSnapshot = product.costPrice || 0;
                    } catch (e) {
                        logger.warn(`Invalid Product ID ignored: ${item.productId}`);
                    }
                } 
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
                linkedBankId: safeBankId, 
                paymentMethod: isCredit ? 'CREDIT' : finalSaleType.toUpperCase(), 
                dueDate: saleData.dueDate ? new Date(saleData.dueDate) : null,
                loggedBy: loggedBy || 'Owner' 
            };

            const transaction = await createSaleTransaction(transactionData, { session });
            transactionResult = transaction;

            // --- STEP 3: Update Inventory ---
            for (const item of processedItems) {
                if (item.productId && !item.isService) {
                     const updatedProduct = await updateStock(item.productId, -item.quantity, 'SALE', transaction._id, { session });
                     
                     if (updatedProduct.quantity <= (updatedProduct.reorderLevel || 5)) {
                         transactionResult.lowStockAlert = updatedProduct;
                     }
                }
            }
           
            // --- STEP 4: Financial Updates ---
            if (isCredit) {
                await updateBalanceOwed(customer._id, totalAmount, { session });
            } else if (safeBankId && !isNaN(totalAmount) && totalAmount > 0) {
                // [FIX] Only attempt bank update if ID is valid and amount is valid
                await updateBankBalance(safeBankId, totalAmount, { session });
            }
        });

        if (transactionResult?.lowStockAlert) {
            const p = transactionResult.lowStockAlert;
            await sendTextMessage(user.whatsappId, 
                `⚠️ *Low Stock Alert:*\n"${p.productName}" is down to *${p.quantity} units*.\n\nReply with 'Restock ${p.productName} ...' to add more.`
            );
        }

        return transactionResult;

    } catch (error) {
        logger.error('Transaction Failed (Rolled Back):', error);
        throw error;
    } finally {
        await session.endSession();
    }
}

export async function logExpense(user, expenseData) {
    const { category, amount, description, linkedBankId, loggedBy } = expenseData;
    
    // [FIX] Safe ID conversion for Expense as well
    let safeBankId = null;
    if (linkedBankId) {
        try {
            safeBankId = (typeof linkedBankId === 'string') ? new ObjectId(linkedBankId) : linkedBankId;
        } catch(e) { safeBankId = null; }
    }

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
                linkedBankId: safeBankId,
                loggedBy: loggedBy || 'Owner'
            }, { session });

            if (safeBankId) {
                await updateBankBalance(safeBankId, -parseFloat(amount), { session });
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
    
    let safeBankId = null;
    if (linkedBankId) {
        try {
            safeBankId = (typeof linkedBankId === 'string') ? new ObjectId(linkedBankId) : linkedBankId;
        } catch(e) { safeBankId = null; }
    }

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
                linkedBankId: safeBankId,
                loggedBy: loggedBy || 'Owner'
            }, { session });

            const updatedCustomer = await updateBalanceOwed(customer._id, -paymentAmount, { session });
            
            if (safeBankId) {
                await updateBankBalance(safeBankId, paymentAmount, { session });
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
