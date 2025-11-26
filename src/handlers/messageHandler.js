import { findOrCreateUser, updateUser, updateUserState } from '../db/userService.js';
import { findProductByName } from '../db/productService.js';
import { getAllBankAccounts } from '../db/bankService.js';
import { getRecentTransactions } from '../db/transactionService.js';
import { extractOnboardingDetails, extractCurrency, getIntent, gatherSaleDetails, gatherExpenseDetails, gatherProductDetails, gatherPaymentDetails, gatherBankAccountDetails } from '../services/aiService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendInteractiveButtons, sendInteractiveList, sendMainMenu, sendReportMenu } from '../api/whatsappService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';

const CANCEL_KEYWORDS = ['cancel', 'stop', 'exit', 'nevermind', 'abort'];

// Helper: Parsing Prices
const parsePrice = (priceInput) => {
    if (typeof priceInput === 'number') return priceInput;
    if (typeof priceInput !== 'string') return NaN;
    const cleaned = priceInput.replace(/₦|,/g, '').toLowerCase().trim();
    let multiplier = 1;
    let numericPart = cleaned;
    if (cleaned.endsWith('k')) {
        multiplier = 1000;
        numericPart = cleaned.slice(0, -1);
    } else if (cleaned.endsWith('m')) {
        multiplier = 1000000;
        numericPart = cleaned.slice(0, -1);
    }
    const value = parseFloat(numericPart);
    return isNaN(value) ? NaN : value * multiplier;
};

// Helper: Parsing Lists
const parseProductList = (text) => {
    const products = [];
    const lines = text.split('\n');
    const lineRegex = /^\s*\d+\.?\s+(\d+)\s+(.+?)\s*[-:]\s*cost\s*[-:]?\s*([^,]+),?\s*sell\s*[-:]?\s*(.+)/i;

    for (const line of lines) {
        const match = line.trim().match(lineRegex);
        if (match) {
            try {
                const [, quantityAdded, productName, costPriceStr, sellingPriceStr] = match;
                const costPrice = parsePrice(costPriceStr.trim());
                const sellingPrice = parsePrice(sellingPriceStr.trim());
                if (!isNaN(costPrice) && !isNaN(sellingPrice)) {
                     products.push({
                        quantityAdded: parseInt(quantityAdded.trim(), 10),
                        productName: productName.trim(),
                        costPrice: costPrice,
                        sellingPrice: sellingPrice
                    });
                } else {
                     logger.warn(`Failed to parse prices in line: "${line}"`);
                }
            } catch (e) {
                logger.warn(`Failed to parse line structure: "${line}"`, e);
            }
        }
    }
    return products;
};


export async function handleMessage(message) {
  const whatsappId = message.from;
  const originalText = message.text.body;
  const lowerCaseText = originalText.trim().toLowerCase();

  try {
    const user = await findOrCreateUser(whatsappId);

    // --- 1. STRICT ONBOARDING GATEKEEPER ---
    // If user is in an onboarding state, force them to finish. 
    // Do NOT check for 'cancel' or AI intents.
    const onboardingStates = [
        USER_STATES.NEW_USER,
        USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL,
        USER_STATES.ONBOARDING_AWAIT_OTP,
        USER_STATES.ONBOARDING_AWAIT_CURRENCY
    ];

    if (onboardingStates.includes(user.state)) {
        switch (user.state) {
            case USER_STATES.NEW_USER: await handleNewUser(user); break;
            case USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL: await handleOnboardingDetails(user, originalText); break;
            case USER_STATES.ONBOARDING_AWAIT_OTP: await handleOtp(user, originalText); break;
            case USER_STATES.ONBOARDING_AWAIT_CURRENCY: await handleCurrency(user, originalText); break;
        }
        return; // Stop here. No other logic runs until onboarding is done.
    }

    // --- 2. HANDLE CANCELLATION (Only for logged-in users) ---
    if (CANCEL_KEYWORDS.includes(lowerCaseText)) {
        if (user.state === USER_STATES.IDLE) {
            await sendTextMessage(whatsappId, "There's nothing to cancel. What would you like to do?");
            await sendMainMenu(whatsappId);
            return;
        }
        logger.info(`User ${whatsappId} cancelled operation from state: ${user.state}`);
        await updateUserState(whatsappId, USER_STATES.IDLE, {});
        await sendTextMessage(whatsappId, "Okay, I've cancelled the current operation. 👍");
        await sendMainMenu(whatsappId); 
        return;
    }

    // --- 3. HANDLE ACTIVE STATES ---
    switch (user.state) {
      case USER_STATES.IDLE: await handleIdleState(user, originalText); break;
      case USER_STATES.LOGGING_SALE: await handleLoggingSale(user, originalText); break;
      case USER_STATES.LOGGING_MULTI_ITEM_SALE: await handleMultiItemSale(user, originalText); break; 
      case USER_STATES.LOGGING_EXPENSE: await handleLoggingExpense(user, originalText); break;
      case USER_STATES.ADDING_PRODUCT: await handleAddingProduct(user, originalText); break;
      case USER_STATES.LOGGING_CUSTOMER_PAYMENT: await handleLoggingCustomerPayment(user, originalText); break;
      case USER_STATES.ADDING_BANK_ACCOUNT: await handleAddingBankAccount(user, originalText); break;
      case USER_STATES.AWAITING_EDIT_VALUE: await handleEditValue(user, originalText); break;

      // Handle Interactive States (User typed instead of clicked)
      case USER_STATES.AWAITING_BANK_SELECTION_SALE:
      case USER_STATES.AWAITING_BANK_SELECTION_EXPENSE:
      case USER_STATES.AWAITING_BANK_SELECTION_PURCHASE:
      case USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT:
      case USER_STATES.AWAITING_SALE_TYPE_CONFIRMATION:
      case USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION:
      case USER_STATES.AWAITING_INVOICE_CONFIRMATION:
      case USER_STATES.AWAITING_DELETE_CONFIRMATION:
      case USER_STATES.AWAITING_RECONCILE_ACTION:
      case USER_STATES.AWAITING_EDIT_FIELD_SELECTION:
      case USER_STATES.AWAITING_TRANSACTION_SELECTION:
      case USER_STATES.AWAITING_REPORT_TYPE_SELECTION:
        await sendTextMessage(whatsappId, "Please select an option from the buttons or list I sent above, or type 'cancel' to stop.");
        break;

      default:
        logger.warn(`Unhandled state: ${user.state} for user ${whatsappId}`);
        await sendTextMessage(whatsappId, "Apologies, I'm a bit stuck. Let's get you back on track.");
        await updateUserState(whatsappId, USER_STATES.IDLE);
        await sendMainMenu(whatsappId);
        break;
    }
  } catch (error) {
    logger.error(`Error in message handler for ${whatsappId}:`, error);
    await sendTextMessage(whatsappId, "Oh dear, something went wrong on my end. Please try again in a moment. 🛠️");
  }
}

async function handleIdleState(user, text) {
    // Get Intent from AI
    const { intent, context } = await getIntent(text);

    // --- CONVERSATIONAL & SCOPE LOGIC ---
    
    if (intent === INTENTS.CHITCHAT) {
        // Friendly reply, but steer back to business
        await sendTextMessage(user.whatsappId, "I'm doing great and ready to help! 🚀 What would you like to do? You can log a sale, check stock, or generate a report.");
        await sendMainMenu(user.whatsappId);
        return;
    } 
    
    if (intent === null) {
        // Out of scope or misunderstood
        await sendTextMessage(user.whatsappId, "I'm designed to help you with bookkeeping, inventory, and financial reports. I can't help with that specifically, but here is what I can do:");
        await sendMainMenu(user.whatsappId);
        return;
    }

    // --- BUSINESS LOGIC ---

    if (intent === INTENTS.SHOW_MAIN_MENU) {
        await sendMainMenu(user.whatsappId);
    } else if (intent === INTENTS.ADD_PRODUCTS_FROM_LIST) {
        const products = parseProductList(text);
        if (products.length === 0) {
            await sendTextMessage(user.whatsappId, "I see you sent a list, but I couldn't understand its format. Please try a format like:\n\n`1. 10 Shirts - cost: 5000, sell: 8000`");
            return;
        }
        let summary = "Great! I've parsed your list. Please confirm these items:\n\n";
        products.forEach((p, index) => {
            const cost = new Intl.NumberFormat('en-US').format(p.costPrice);
            const sell = new Intl.NumberFormat('en-US').format(p.sellingPrice);
            summary += `${index + 1}. *${p.quantityAdded}x ${p.productName}*\n   Cost: ${user.currency} ${cost}, Sell: ${user.currency} ${sell}\n`;
        });
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION, { products });
        await sendInteractiveButtons(user.whatsappId, summary, [
            { id: 'confirm_bulk_add', title: '✅ Yes, Proceed' },
            { id: 'cancel_bulk_add', title: '❌ No, Cancel' }
        ]);
    } else if (intent === INTENTS.LOG_SALE) {
        let existingProduct = null;
        if (context.productName) {
            existingProduct = await findProductByName(user._id, context.productName);
        }
        const initialMemory = [{ role: 'user', content: text }];
        const initialSaleData = { items: [], customerName: context.customerName, saleType: context.saleType };
        let firstItem = {};

        if (context.productName) {
            firstItem.productName = context.productName;
            firstItem.quantity = context.unitsSold || 1;
            let priceFound = parsePrice(context.amountPerUnit);
            if(isNaN(priceFound) && existingProduct) {
                priceFound = existingProduct.sellingPrice;
            }
            if(isNaN(priceFound) && context.totalAmount && !isNaN(parsePrice(context.totalAmount))) {
                 priceFound = parsePrice(context.totalAmount) / firstItem.quantity;
            }
            firstItem.pricePerUnit = priceFound; 
            firstItem.productId = existingProduct?._id;
            firstItem.isService = !existingProduct;
        }

        if (firstItem.productName && !isNaN(firstItem.pricePerUnit) && !existingProduct) {
             initialSaleData.items.push(firstItem);
             await updateUserState(user.whatsappId, USER_STATES.AWAITING_SALE_TYPE_CONFIRMATION, { memory: initialMemory, saleData: initialSaleData, productName: context.productName });
             await sendInteractiveButtons(user.whatsappId, `I couldn't find "${context.productName}" in your inventory. Is this a Product you want to add now, or a Service you provided?`, [
                 { id: 'sale_type:product', title: 'Add Product' },
                 { id: 'sale_type:service', title: 'It\'s a Service' },
             ]);
        } else {
             if (firstItem.productName && !isNaN(firstItem.pricePerUnit) && firstItem.quantity) {
                 initialSaleData.items.push(firstItem);
             }
             await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { memory: initialMemory, saleData: initialSaleData, existingProduct });
             await handleLoggingSale({ ...user, state: USER_STATES.LOGGING_SALE, stateContext: { memory: initialMemory, saleData: initialSaleData, existingProduct } }, text);
        }

    } else if (intent === INTENTS.LOG_EXPENSE) {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: [{ role: 'user', content: text }] });
        await handleLoggingExpense({ ...user, state: USER_STATES.LOGGING_EXPENSE, stateContext: { memory: [{ role: 'user', content: text }] } }, text);
    } else if (intent === INTENTS.ADD_PRODUCT) {
        let existingProduct = null;
        if (context.productName) {
            existingProduct = await findProductByName(user._id, context.productName);
        }
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: [{ role: 'user', content: text }], existingProduct });
        await handleAddingProduct({ ...user, state: USER_STATES.ADDING_PRODUCT, stateContext: { memory: [{ role: 'user', content: text }], existingProduct } }, text);
    } else if (intent === INTENTS.LOG_CUSTOMER_PAYMENT) {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: [{ role: 'user', content: text }] });
        await handleLoggingCustomerPayment({ ...user, state: USER_STATES.LOGGING_CUSTOMER_PAYMENT, stateContext: { memory: [{ role: 'user', content: text }] } }, text);
    } else if (intent === INTENTS.ADD_BANK_ACCOUNT || text.toLowerCase().includes('manage bank')) {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: [{ role: 'user', content: text }] });
        await handleAddingBankAccount({ ...user, state: USER_STATES.ADDING_BANK_ACCOUNT, stateContext: { memory: [{ role: 'user', content: text }] } }, text);
    } else if (intent === INTENTS.RECONCILE_TRANSACTION) {
        const recentTransactions = await getRecentTransactions(user._id, 5);
        if (recentTransactions.length === 0) {
            await sendTextMessage(user.whatsappId, "You don't have any recent transactions to modify.");
            await sendMainMenu(user.whatsappId);
            return;
        }
        const rows = recentTransactions.map(tx => {
            const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: user.currency }).format(tx.amount);
            let title = tx.description || tx.type;
            if (tx.items && tx.items.length > 0) {
                 title = tx.items.map(i => `${i.quantity}x ${i.productName}`).join(', ');
            }
            title = title.length > 24 ? title.substring(0, 21) + '...' : title;
            return { id: `select_tx:${tx._id}`, title: title, description: `${tx.type} - ${formattedAmount}` };
        });
        const sections = [{ title: "Recent Transactions", rows: rows }];
        await updateUserState(user.whatsappId, USER_STATES.AWAITING_TRANSACTION_SELECTION);
        await sendInteractiveList(user.whatsappId, "Modify Transaction", "Please select the transaction you would like to modify.", "View Transactions", sections);
    } else if (intent === INTENTS.GENERATE_REPORT) {
        if (context.reportType) {
            await executeTask(intent, user, context);
        } else {
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_REPORT_TYPE_SELECTION);
            await sendReportMenu(user.whatsappId);
        }
    } else if (intent === INTENTS.CHECK_STOCK || intent === INTENTS.GET_FINANCIAL_SUMMARY || intent === INTENTS.CHECK_BANK_BALANCE || intent === INTENTS.GET_FINANCIAL_INSIGHT || intent === INTENTS.GET_CUSTOMER_BALANCES) {
        await executeTask(intent, user, context);
    } else {
        await sendTextMessage(user.whatsappId, "I'm not sure I understood that. Please try again or select an option from the menu.");
        await sendMainMenu(user.whatsappId);
    }
}

async function handleLoggingSale(user, text) {
    const { memory: currentMemory = [], existingProduct, saleData = { items: [] }, isService = false } = user.stateContext;
    
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }

    const aiResponse = await gatherSaleDetails(currentMemory, existingProduct, isService);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_SALE, { ...user.stateContext, memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        const finalSaleData = { ...saleData, ...aiResponse.data }; 
        
        if (!finalSaleData.items || finalSaleData.items.length === 0) {
            await sendTextMessage(user.whatsappId, "It seems no items were added to the sale. Please try again.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE);
            await sendMainMenu(user.whatsappId);
            return;
        }
        for(const item of finalSaleData.items) {
            if (isNaN(item.pricePerUnit) || isNaN(item.quantity)) {
                 await sendTextMessage(user.whatsappId, `There was an issue with the price or quantity for ${item.productName}. Please start the sale again.`);
                 await updateUserState(user.whatsappId, USER_STATES.IDLE);
                 await sendMainMenu(user.whatsappId);
                 return;
            }
        }

        if (finalSaleData.saleType.toLowerCase() === 'credit') {
            await sendTextMessage(user.whatsappId, "Got it! Let me record that credit sale... 📝");
            await executeTask(INTENTS.LOG_SALE, user, finalSaleData);
        } else { // Cash or Bank
            const banks = await getAllBankAccounts(user._id);
            if (banks.length === 0) {
                await sendTextMessage(user.whatsappId, "FYI: You haven't set up any bank accounts. I'll log this sale, but I can't track it against a specific account.");
                await executeTask(INTENTS.LOG_SALE, user, finalSaleData);
            } else {
                await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_SALE, { transactionData: finalSaleData });
                const buttons = banks.map(bank => ({ id: `select_bank:${bank._id}`, title: bank.bankName }));
                await sendInteractiveButtons(user.whatsappId, 'Which account received the payment?', buttons);
            }
        }
    }
}

// async function handleMultiItemSale(user, text) { ... } // Optional hook

async function handleLoggingExpense(user, text) {
    const { memory: currentMemory = [] } = user.stateContext;
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    const aiResponse = await gatherExpenseDetails(currentMemory);

    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_EXPENSE, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        const expenseData = aiResponse.data;
        if (isNaN(parsePrice(expenseData.amount))) {
            await sendTextMessage(user.whatsappId, "There was an issue with the amount. Let's try that again. What was the expense amount?");
            return; // Stay in state
        }
        const banks = await getAllBankAccounts(user._id);
        if (banks.length === 0) {
            await sendTextMessage(user.whatsappId, "FYI: You haven't set up any bank accounts. I'll log this expense, but I can't track it against a specific account.");
            await executeTask(INTENTS.LOG_EXPENSE, user, expenseData);
        } else {
            await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_EXPENSE, { transactionData: expenseData });
            const buttons = banks.map(bank => ({ id: `select_bank:${bank._id}`, title: bank.bankName }));
            await sendInteractiveButtons(user.whatsappId, 'Which account was used for this payment?', buttons);
        }
    }
}

async function handleAddingProduct(user, text) {
    const { memory: currentMemory = [], existingProduct } = user.stateContext;
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    const aiResponse = await gatherProductDetails(currentMemory, existingProduct);
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_PRODUCT, { memory: aiResponse.memory, existingProduct });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        const productData = aiResponse.data;
        if (isNaN(parsePrice(productData.costPrice)) || isNaN(parsePrice(productData.sellingPrice)) || isNaN(parseInt(productData.quantityAdded, 10))) {
            await sendTextMessage(user.whatsappId, "There was an issue with the quantity or prices. Please provide valid numbers.");
             await updateUserState(user.whatsappId, USER_STATES.IDLE);
             await sendMainMenu(user.whatsappId);
             return;
        }
        if (productData.quantityAdded > 0) {
             const banks = await getAllBankAccounts(user._id);
             if (banks.length > 0) {
                await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_PURCHASE, { transactionData: productData });
                const buttons = banks.map(bank => ({ id: `select_bank:${bank._id}`, title: bank.bankName }));
                 buttons.push({ id: 'select_bank:none', title: 'Not from Bank' });
                 await sendInteractiveButtons(user.whatsappId, 'Which account did you use to purchase this stock?', buttons);
             } else {
                 await sendTextMessage(user.whatsappId, "Adding product... (Note: Add a bank account later to track purchase costs accurately!)");
                 await executeTask(INTENTS.ADD_PRODUCT, user, productData);
             }
         } else {
             await sendTextMessage(user.whatsappId, "Updating product details...");
             await executeTask(INTENTS.ADD_PRODUCT, user, productData);
         }
    }
}

async function handleLoggingCustomerPayment(user, text) {
    const { memory: currentMemory = [] } = user.stateContext;
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    const aiResponse = await gatherPaymentDetails(currentMemory, user.currency);
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.LOGGING_CUSTOMER_PAYMENT, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
        const paymentData = aiResponse.data;
         if (isNaN(parsePrice(paymentData.amount))) {
            await sendTextMessage(user.whatsappId, "There was an issue with the amount. Let's try again. What amount did the customer pay?");
            return; // Stay in state
        }
         const banks = await getAllBankAccounts(user._id);
         if (banks.length === 0) {
             await sendTextMessage(user.whatsappId, "FYI: You haven't set up bank accounts. I'll log this payment, but won't link it to an account.");
             await executeTask(INTENTS.LOG_CUSTOMER_PAYMENT, user, paymentData);
         } else {
             await updateUserState(user.whatsappId, USER_STATES.AWAITING_BANK_SELECTION_CUST_PAYMENT, { transactionData: paymentData });
             const buttons = banks.map(bank => ({ id: `select_bank:${bank._id}`, title: bank.bankName }));
             await sendInteractiveButtons(user.whatsappId, 'Which account did this payment go into?', buttons);
         }
    }
}

async function handleAddingBankAccount(user, text) {
    const { memory: currentMemory = [] } = user.stateContext;
    if (currentMemory.length === 0 || currentMemory[currentMemory.length - 1].role !== 'user') {
        currentMemory.push({ role: 'user', content: text });
    }
    const aiResponse = await gatherBankAccountDetails(currentMemory, user.currency);
    if (aiResponse.status === 'incomplete') {
        await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: aiResponse.memory });
        await sendTextMessage(user.whatsappId, aiResponse.reply);
    } else if (aiResponse.status === 'complete') {
         const bankData = aiResponse.data;
         if (isNaN(parsePrice(bankData.openingBalance))) {
             await sendTextMessage(user.whatsappId, "There was an issue with the opening balance. Please provide a valid number.");
             currentMemory.push({ role: 'assistant', content: "Invalid number received." }); // Log invalid attempt
             await updateUserState(user.whatsappId, USER_STATES.ADDING_BANK_ACCOUNT, { memory: currentMemory });
             await sendTextMessage(user.whatsappId, "What is the opening balance?");
             return;
         }
        await sendTextMessage(user.whatsappId, "Got it! Adding your new bank account... 🏦");
        await executeTask(INTENTS.ADD_BANK_ACCOUNT, user, bankData);
    }
}

async function handleEditValue(user, text) {
    const { transaction, fieldToEdit } = user.stateContext;
    if (!transaction || !fieldToEdit) {
        await sendTextMessage(user.whatsappId, "I've lost my train of thought. Please start the edit process again.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        return;
    }
    let newValue;
    if (['unitsSold', 'amountPerUnit', 'amount'].includes(fieldToEdit)) {
        newValue = parsePrice(text);
        if (isNaN(newValue)) {
            await sendTextMessage(user.whatsappId, "That doesn't seem to be a valid number. Please provide a number for this field.");
            return;
        }
    } else {
        newValue = text;
    }
    const changes = { [fieldToEdit]: newValue };
    await sendTextMessage(user.whatsappId, "Okay, applying your changes... 🔄");
    await executeTask(INTENTS.RECONCILE_TRANSACTION, user, { transactionId: transaction._id, action: 'edit', changes });
}

// --- ONBOARDING HANDLERS ---

async function handleNewUser(user) {
  await sendTextMessage(user.whatsappId, "👋 Welcome to Fynax Bookkeeper! I'm here to help you manage your business finances effortlessly.");
  await sendTextMessage(user.whatsappId, "To get started, what is your business name and your email address?");
  // Move state forward to avoid loop
  await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_BUSINESS_AND_EMAIL);
}

async function handleOnboardingDetails(user, text) {
  const { businessName, email } = await extractOnboardingDetails(text);
  let updates = {};
  if (businessName) updates.businessName = businessName;
  if (email) updates.email = email;
  
  let updatedUser = user;
  if (Object.keys(updates).length > 0) {
    updatedUser = await updateUser(user.whatsappId, updates);
  }

  if (updatedUser.businessName && updatedUser.email) {
    const otp = await sendOtp(updatedUser.email, updatedUser.businessName);
    const tenMinutes = 10 * 60 * 1000;
    const otpExpires = new Date(Date.now() + tenMinutes);
    await updateUser(updatedUser.whatsappId, { otp, otpExpires });
    await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_OTP);
    await sendTextMessage(user.whatsappId, `Perfect! I've just sent a 6-digit verification code to ${updatedUser.email}. 📧 Please enter it here to continue.`);
  } else if (updatedUser.businessName) {
    await sendTextMessage(user.whatsappId, `Got it! Your business is "${updatedUser.businessName}". Now, what's your email address?`);
  } else if (updatedUser.email) {
    await sendTextMessage(user.whatsappId, `Thanks! I have your email as ${updatedUser.email}. What's your business name?`);
  } else {
    await sendTextMessage(user.whatsappId, "I'm sorry, I couldn't quite understand that. Could you please provide your business name and email address?");
  }
}

async function handleOtp(user, text) {
  const otpAttempt = text.trim();
  if (user.otpExpires < new Date()) {
    await sendTextMessage(user.whatsappId, "It looks like that code has expired. 😥 Let's send a new one.");
    await handleOnboardingDetails(user, user.email);
    return;
  }
  if (user.otp === otpAttempt) {
    await updateUser(user.whatsappId, { isEmailVerified: true, otp: null, otpExpires: null });
    await updateUserState(user.whatsappId, USER_STATES.ONBOARDING_AWAIT_CURRENCY);
    await sendTextMessage(user.whatsappId, `✅ Email verified! Just one last thing: what is your primary business currency? (e.g., Naira, GHS, USD)`);
  } else {
    await sendTextMessage(user.whatsappId, "That code doesn't seem to match. Please double-check and try again. 🤔");
  }
}

async function handleCurrency(user, text) {
  const { currency } = await extractCurrency(text);
  if (currency) {
    await updateUser(user.whatsappId, { currency });
    await updateUserState(user.whatsappId, USER_STATES.IDLE);
    await sendTextMessage(user.whatsappId, `Excellent! Your account is fully set up with ${currency} as your currency. 🎉`);
    await sendMainMenu(user.whatsappId); 
  } else {
    await sendTextMessage(user.whatsappId, "I didn't recognize that currency. Please tell me your main currency, like 'Naira', 'Dollars', or 'GHS'.");
  }
}
