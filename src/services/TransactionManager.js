import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findProductByName, updateStock } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction } from '../db/transactionService.js';
import { updateBankBalance } from '../db/bankService.js';
import { sendTextMessage } from '../api/whatsappService.js'; 
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

export async function logSale(user, saleData) {
    const { items, customerName, saleType, linkedBankId, loggedBy } = saleData;
    if (!items || items.length === 0) throw new Error("No items found in the sale data.");

    const customer = await findOrCreateCustomer(user._id, customerName);
    let totalAmount = 0;
    let descriptionParts = [];
    const processedItems = [];

    // --- STEP 1: Process Items ---
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

    // --- STEP 2: Create Transaction ---
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
        loggedBy: loggedBy || 'Owner' // [TEAM MODE SUPPORT]
    };

    const transaction = await createSaleTransaction(transactionData);

    // --- STEP 3: Update Inventory & Alert ---
    for (const item of processedItems) {
        if (item.productId && !item.isService) {
             const updatedProduct = await updateStock(item.productId, -item.quantity, 'SALE', transaction._id);
             
             // Low Stock Alert
             const threshold = updatedProduct.reorderLevel || 5; 
             if (updatedProduct.quantity <= threshold) {
                 await sendTextMessage(user.whatsappId, 
                     `⚠️ *Low Stock Alert:*\n"${updatedProduct.productName}" is down to *${updatedProduct.quantity} units*.\n\nReply with 'Restock ${updatedProduct.productName} ...' to add more.`
                 );
             }
        }
    }
   
    // --- STEP 4: Financial Updates ---
    if (saleType.toLowerCase() === 'credit') {
        await updateBalanceOwed(customer._id, totalAmount);
    } else if (linkedBankId) {
        await updateBankBalance(new ObjectId(linkedBankId), totalAmount);
    }

    return transaction;
}

export async function logExpense(user, expenseData) {
    const { category, amount, description, linkedBankId, loggedBy } = expenseData;
    
    const transaction = await createExpenseTransaction({
        userId: user._id,
        amount: parseFloat(amount),
        date: new Date(),
        description,
        category,
        linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null,
        loggedBy: loggedBy || 'Owner'
    });

    if (linkedBankId) {
        await updateBankBalance(new ObjectId(linkedBankId), -parseFloat(amount));
    }

    return transaction;
}

export async function logCustomerPayment(user, paymentData) {
    const { customerName, amount, linkedBankId, loggedBy } = paymentData;
    const paymentAmount = parseFloat(amount);

    const customer = await findOrCreateCustomer(user._id, customerName);

    const transaction = await createCustomerPaymentTransaction({
        userId: user._id,
        linkedCustomerId: customer._id,
        amount: paymentAmount,
        date: new Date(),
        description: `Payment received from ${customer.customerName}`,
        linkedBankId: linkedBankId ? new ObjectId(linkedBankId) : null,
        loggedBy: loggedBy || 'Owner'
    });

    const updatedCustomer = await updateBalanceOwed(customer._id, -paymentAmount);
    
    if (linkedBankId) {
        await updateBankBalance(new ObjectId(linkedBankId), paymentAmount);
    }

    return { transaction, updatedCustomer };
}
