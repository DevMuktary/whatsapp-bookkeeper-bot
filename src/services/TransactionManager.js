import { findOrCreateCustomer, updateBalanceOwed } from '../db/customerService.js';
import { findProductByName, updateStock } from '../db/productService.js';
import { createSaleTransaction, createExpenseTransaction, createCustomerPaymentTransaction } from '../db/transactionService.js';
import { updateBankBalance } from '../db/bankService.js';
import { sendTextMessage } from '../api/whatsappService.js'; 
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js'; // Need direct DB access for ID lookup

export async function logSale(user, saleData) {
    const { items, customerName, saleType, linkedBankId, loggedBy } = saleData;
    if (!items || items.length === 0) throw new Error("No items found in the sale data.");

    // [CRASH FIX] Handle missing saleType safely. Default to CASH.
    const finalSaleType = saleType ? saleType : 'CASH';

    const customer = await findOrCreateCustomer(user._id, customerName);
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
            
            // We need to fetch the Cost Price for accurate Profit Reports
            const product = await getDB().collection('products').findOne({ _id: productId });
            if (product) {
                costPriceSnapshot = product.costPrice || 0;
            }
        } 
        // Priority 2: Lookup by Name (Legacy/Fallback)
        else if (!item.isService) {
            const cleanName = item.productName.trim(); // Trim spaces!
            const product = await findProductByName(user._id, cleanName);
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

    const transaction = await createSaleTransaction(transactionData);

    // --- STEP 3: Update Inventory & Alert ---
    for (const item of processedItems) {
        // [LOGIC] Only deduct if we successfully identified a Product ID and it's NOT a service
        if (item.productId && !item.isService) {
             const updatedProduct = await updateStock(item.productId, -item.quantity, 'SALE', transaction._id);
             
             // Low Stock Alert
             const threshold = updatedProduct.reorderLevel || 5; 
             // Logic: If stock WAS above threshold and is NOW below/equal
             if (updatedProduct.quantity <= threshold) {
                 await sendTextMessage(user.whatsappId, 
                     `⚠️ *Low Stock Alert:*\n"${updatedProduct.productName}" is down to *${updatedProduct.quantity} units*.\n\nReply with 'Restock ${updatedProduct.productName} ...' to add more.`
                 );
             }
        }
    }
   
    // --- STEP 4: Financial Updates ---
    if (finalSaleType.toLowerCase() === 'credit') {
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
