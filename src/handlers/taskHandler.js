import { findProductByName, updateStock } from '../db/productService.js';
import { getSummaryByDateRange, getRecentTransactions, findTransactionById, deleteTransactionById, updateTransactionById } from '../db/transactionService.js';
import { getAllBankAccounts, findBankAccountByName, updateBankBalance } from '../db/bankService.js';
import { getCustomersWithBalance, updateBalanceOwed, findCustomerById } from '../db/customerService.js';
import { updateUserState } from '../db/userService.js';
import { sendTextMessage, sendMainMenu, sendInteractiveList } from '../api/whatsappService.js';
// [UPDATED IMPORT]
import { getFinancialInsight } from '../ai/prompts.js';

import { INTENTS, USER_STATES } from '../utils/constants.js';
import { getDateRange } from '../utils/dateUtils.js';
import { getPnLData } from '../services/ReportManager.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

export async function executeTask(intent, user, data) {
    try {
        switch (intent) {
            case INTENTS.CHECK_STOCK:
                await executeCheckStock(user, data);
                break;
            case INTENTS.GET_FINANCIAL_SUMMARY:
                await executeGetFinancialSummary(user, data);
                break;
            case INTENTS.CHECK_BANK_BALANCE:
                await executeCheckBankBalance(user, data);
                break;
            case INTENTS.GET_FINANCIAL_INSIGHT:
                await executeGetFinancialInsight(user, data);
                break;
            case INTENTS.GET_CUSTOMER_BALANCES:
                await executeGetCustomerBalances(user);
                break;
            case INTENTS.RECONCILE_TRANSACTION:
                if (data.action === 'delete') await executeDeleteTransaction(user, data);
                else if (data.action === 'edit') await executeUpdateTransaction(user, data);
                else await executeListTransactionsForReconcile(user);
                break;
            default:
                logger.warn(`Task handler received intent handled elsewhere: ${intent}`);
                break;
        }
    } catch (error) {
        logger.error(`Error executing task ${intent}:`, error);
        await sendTextMessage(user.whatsappId, `Error: ${error.message}`);
    } 
}

async function executeCheckStock(user, data) {
    const { productName } = data;
    if (!productName) {
        await sendTextMessage(user.whatsappId, "Which product are you checking?");
        return;
    }
    const product = await findProductByName(user._id, productName);
    if (product) {
        await sendTextMessage(user.whatsappId, `📦 Stock: ${product.quantity} units of "${product.productName}".`);
    } else {
        await sendTextMessage(user.whatsappId, `Product "${productName}" not found.`);
    }
    await sendMainMenu(user.whatsappId);
}

async function executeGetFinancialSummary(user, data) {
    const { metric, period, dateRange } = data;
    const { startDate, endDate } = getDateRange(dateRange || period || 'this_month');
    
    const type = metric.toUpperCase() === 'SALES' ? 'SALE' : 'EXPENSE';
    const total = await getSummaryByDateRange(user._id, type, startDate, endDate);
    
    await sendTextMessage(user.whatsappId, `Total ${metric} (${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}): ${user.currency} ${total.toLocaleString()}`);
    await sendMainMenu(user.whatsappId);
}

async function executeCheckBankBalance(user, data) {
    const { bankName } = data;
    if (bankName) {
        const bank = await findBankAccountByName(user._id, bankName);
        if (bank) await sendTextMessage(user.whatsappId, `🏦 ${bank.bankName}: ${user.currency} ${bank.balance.toLocaleString()}`);
        else await sendTextMessage(user.whatsappId, `Bank "${bankName}" not found.`);
    } else {
        const banks = await getAllBankAccounts(user._id);
        if (banks.length === 0) {
            await sendTextMessage(user.whatsappId, "No bank accounts found.");
        } else {
            const summary = banks.map(b => `*${b.bankName}*: ${user.currency} ${b.balance.toLocaleString()}`).join('\n');
            await sendTextMessage(user.whatsappId, `Current Balances:\n${summary}`);
        }
    }
    await sendMainMenu(user.whatsappId);
}

async function executeGetFinancialInsight(user, data) {
    const { dateRange } = data;
    const period = dateRange || { startDate: new Date(new Date().setDate(1)), endDate: new Date() }; 
    await sendTextMessage(user.whatsappId, "Crunching the numbers... 🧠");
    const pnlData = await getPnLData(user._id, period.startDate, period.endDate);
    const insight = await getFinancialInsight(pnlData, user.currency);
    await sendTextMessage(user.whatsappId, insight);
    await sendMainMenu(user.whatsappId);
}

async function executeGetCustomerBalances(user) {
    const customers = await getCustomersWithBalance(user._id);
    if (customers.length === 0) {
        await sendTextMessage(user.whatsappId, "No customers owe you money right now. 🎉");
    } else {
        const list = customers.map(c => `*${c.customerName}*: ${user.currency} ${c.balanceOwed.toLocaleString()}`).join('\n');
        await sendTextMessage(user.whatsappId, `Outstanding Balances:\n${list}`);
    }
    await sendMainMenu(user.whatsappId);
}

async function executeListTransactionsForReconcile(user) {
    const transactions = await getRecentTransactions(user._id, 8);
    if (transactions.length === 0) {
        await sendTextMessage(user.whatsappId, "No recent transactions found.");
        await sendMainMenu(user.whatsappId);
        return;
    }

    const rows = transactions.map(tx => {
        let desc = tx.description || tx.type;
        if (desc.length > 22) desc = desc.substring(0, 20) + '..';
        return {
            id: `select_tx:${tx._id}`,
            title: desc,
            description: `${new Date(tx.date).toLocaleDateString()} - ${user.currency} ${tx.amount.toLocaleString()}`
        };
    });

    const sections = [{ title: "Select Transaction", rows }];
    await updateUserState(user.whatsappId, USER_STATES.AWAITING_TRANSACTION_SELECTION);
    await sendInteractiveList(user.whatsappId, "Edit/Delete Transaction", "Select a transaction to modify:", "View List", sections);
}

async function executeDeleteTransaction(user, data) {
    const { transactionId } = data;
    const tx = await findTransactionById(transactionId);
    if (!tx) {
        await sendTextMessage(user.whatsappId, "Transaction not found.");
        await sendMainMenu(user.whatsappId);
        return;
    }

    if (tx.type === 'SALE') {
        if (tx.items) {
            for (const item of tx.items) {
                if (item.productId && !item.isService) {
                    await updateStock(item.productId, item.quantity, 'SALE_DELETED', tx._id);
                }
            }
        }
        if (tx.paymentMethod === 'CREDIT' && tx.linkedCustomerId) {
            await updateBalanceOwed(tx.linkedCustomerId, -tx.amount);
        } else if (tx.linkedBankId) {
            await updateBankBalance(tx.linkedBankId, -tx.amount);
        }
    } else if (tx.type === 'EXPENSE' && tx.linkedBankId) {
        await updateBankBalance(tx.linkedBankId, tx.amount);
    } else if (tx.type === 'CUSTOMER_PAYMENT') {
        if (tx.linkedCustomerId) await updateBalanceOwed(tx.linkedCustomerId, tx.amount); 
        if (tx.linkedBankId) await updateBankBalance(tx.linkedBankId, -tx.amount);
    }

    await deleteTransactionById(transactionId);
    await sendTextMessage(user.whatsappId, "✅ Transaction deleted and balances reversed.");
    await sendMainMenu(user.whatsappId);
}

async function executeUpdateTransaction(user, data) {
    const { transactionId, changes } = data;
    const originalTx = await findTransactionById(transactionId);
    if (!originalTx) return;

    if (originalTx.type === 'SALE') {
        if (originalTx.items) {
            for (const item of originalTx.items) {
                if (item.productId && !item.isService) await updateStock(item.productId, item.quantity, 'EDIT_ROLLBACK');
            }
        }
        if (originalTx.paymentMethod === 'CREDIT') await updateBalanceOwed(originalTx.linkedCustomerId, -originalTx.amount);
        else if (originalTx.linkedBankId) await updateBankBalance(originalTx.linkedBankId, -originalTx.amount);
    }

    let updatedTxData = { ...originalTx, ...changes };
    if (changes.unitsSold || changes.amountPerUnit) {
        const qty = parseFloat(changes.unitsSold || originalTx.items[0].quantity);
        const price = parseFloat(changes.amountPerUnit || originalTx.items[0].pricePerUnit);
        updatedTxData.amount = qty * price;
        updatedTxData.items[0].quantity = qty;
        updatedTxData.items[0].pricePerUnit = price;
    }

    await updateTransactionById(transactionId, updatedTxData);
    
    if (updatedTxData.type === 'SALE') {
        if (updatedTxData.items) {
            for (const item of updatedTxData.items) {
                if (item.productId && !item.isService) await updateStock(item.productId, -item.quantity, 'EDIT_APPLY');
            }
        }
        if (updatedTxData.paymentMethod === 'CREDIT') await updateBalanceOwed(updatedTxData.linkedCustomerId, updatedTxData.amount);
        else if (updatedTxData.linkedBankId) await updateBankBalance(updatedTxData.linkedBankId, updatedTxData.amount);
    }

    await sendTextMessage(user.whatsappId, `✅ Transaction updated. New amount: ${updatedTxData.amount}`);
    await sendMainMenu(user.whatsappId);
}
