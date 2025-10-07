import OpenAI from 'openai';
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';
import * as advisorService from './advisorService.js';
import * as onboardingService from './onboardingService.js';

const deepseek = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com/v1" });

// --- A dedicated, smaller set of tools just for the onboarding process ---
const onboardingTools = [
    { type: "function", function: { name: 'onboardUser', description: "Saves a new user's business name and email address. Generates and sends a 6-digit OTP to their email for verification.", parameters: { type: 'object', properties: { businessName: { type: 'string' }, email: { type: 'string' } }, required: ['businessName', 'email'] } } },
    { type: "function", function: { name: 'verifyEmailOTP', description: "Verifies the 6-digit OTP that the user provides from their email.", parameters: { type: 'object', properties: { otp: { type: 'string', description: "The 6-digit code from the user." } }, required: ['otp'] } } },
    { type: "function", function: { name: 'setCurrency', description: "Sets the user's preferred currency. Infer the standard 3-letter currency code (e.g., NGN for Naira, USD for Dollar).", parameters: { type: 'object', properties: { currencyCode: { type: 'string', description: "The 3-letter currency code, e.g., NGN, USD, GHS." } }, required: ['currencyCode'] } } },
];

// --- Tools for the main, already-onboarded user ---
const mainUserTools = [
    { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory. This is the primary tool for recording sales.', parameters: { type: 'object', properties: { productName: { type: 'string', description: 'The name of the product sold, e.g., "iPhone 17 Air".' }, quantitySold: { type: 'number', description: 'The number of units sold.' }, totalAmount: { type: 'number', description: 'The total income received from the sale.' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } },
    { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense that is NOT a product sale, such as "rent", "utilities", or "service income".', parameters: { type: 'object', properties: { type: { type: 'string', description: 'The type of transaction, either "income" or "expense".' }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string', description: 'For expenses, a category like "rent", "utilities", "transport". Defaults to "Uncategorized".' } }, required: ['type', 'amount', 'description'] } } },
    { type: "function", function: { name: 'addProduct', description: 'Adds one or more new products to inventory. If a product already exists, this updates its price and adds to its stock.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
    { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of total income, expenses, and net balance for the current month.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions. Use only when the user explicitly asks to "export", "download", or receive a "PDF report".', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit. Use only when the user explicitly asks for an "inventory report" or "profit report".', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement. Use only when the user asks for a "P&L" or "statement".', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'changeWebsitePassword', description: "Changes the user's password for the Fynax website dashboard.", parameters: { type: 'object', properties: { newPassword: { type: 'string', description: 'The new password. Must be at least 6 characters.' } }, required: ['newPassword'] } } },
    { type: "function", function: { name: 'requestLiveChat', description: "Connects the user to a human support agent. Use this if the user asks for a human, is stuck, or explicitly requests 'support' or 'accountant'.", parameters: { type: 'object', properties: { issue: { type: 'string', description: "A brief summary of the user's issue. e.g., 'User is confused about P&L report'." } }, required: ['issue'] } } },
    { type: "function", function: { name: 'getFinancialDataForAnalysis', description: "Fetches a complete snapshot of the user's monthly summary, top expenses, and inventory status. Use this tool when the user asks for 'advice', 'analysis', 'suggestions', or 'how to improve'.", parameters: { type: 'object', properties: {} } } }
];

// This map contains ALL possible tools for the application
const availableTools = { 
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
    // setOpeningBalance is an alias, but we can remove it from AI tools if we handle it in the prompt
    setOpeningBalance: accountingService.setOpeningBalance, 
    getInventory: accountingService.getInventory, 
    getMonthlySummary: accountingService.getMonthlySummary, 
    generateTransactionReport: reportService.generateTransactionReport, 
    generateInventoryReport: reportService.generateInventoryReport, 
    generatePnLReport: reportService.generatePnLReport,
    changeWebsitePassword: authService.changePasswordFromBot,
    requestLiveChat: liveChatService.requestLiveChat,
    getFinancialDataForAnalysis: advisorService.getFinancialDataForAnalysis,
    onboardUser: onboardingService.onboardUser,
    verifyEmailOTP: onboardingService.verifyEmailOTP,
    setCurrency: onboardingService.setCurrency,
};

// --- NEW: ONBOARDING AI PROCESS ---
export async function processOnboardingMessage(text, collections, senderId, user, conversation) {
    const onboardingSystemInstruction = `You are Fynax Bookkeeper's onboarding assistant. Your ONLY job is to guide a new user through setup. You MUST follow these steps in order, using your tools at each step.
1.  **Welcome & Collect Info:** Greet the user warmly. Ask for their business name and email address in the same message.
2.  **Use 'onboardUser' tool:** Once you have both their business name and email, you MUST call the \`onboardUser\` tool.
3.  **Ask for OTP:** After the tool is called, tell the user to check their email and ask them to provide the 6-digit code.
4.  **Use 'verifyEmailOTP' tool:** When the user provides the OTP, you MUST call the \`verifyEmailOTP\` tool.
5.  **Ask for Currency:** After the email is verified, ask the user for their primary currency (e.g., Naira, Dollars, Cedis).
6.  **Use 'setCurrency' tool:** When the user provides a currency, infer the 3-letter code (e.g., NGN, USD, GHS) and you MUST call the \`setCurrency\` tool.
7.  **Complete:** After the currency is set, congratulate them and tell them they are ready to start logging transactions.

Handle one step at a time. If a user gives you an invalid email, the tool will fail. Politely ask them for a correct one. If they say something off-topic, gently guide them back to the current step.`;

    const messages = [
        { role: "system", content: onboardingSystemInstruction },
        ...(conversation.history || []),
        { role: "user", content: text }
    ];

    return await runAiCycle(messages, onboardingTools, collections, senderId, user, conversation);
}


// --- EXISTING: MAIN AI PROCESS ---
export async function processMessageWithAI(text, collections, senderId, user, conversation) {
    const mainSystemInstruction = `You are 'Fynax Bookkeeper', an expert AI financial advisor. Your name is Fynax Bookkeeper. Follow these rules:
1.  **Use Tools:** Your primary job is to use tools to perform actions (log sales, change passwords, etc.) or gather data.
2.  **Stay in Scope:** Your abilities are: bookkeeping, inventory, reporting, password changes, live support, and **financial analysis**. Do not answer questions outside this scope.
3.  **Live Support:** If the user asks for a 'human' or 'support', use the 'requestLiveChat' tool.
4.  **CRITICAL: Financial Advisor Role:**
    * If a user asks for 'advice', 'analysis', 'suggestions', 'how to improve', or 'what am I doing wrong?', you MUST use the \`getFinancialDataForAnalysis\` tool.
    * This tool will return a JSON object with the user's financial data.
    * When you get this data, your *only* job is to analyze it and give 3-5 short, clear, actionable bullet points of advice.
    * Start your reply with "Here's my analysis of your month so far:"
    * Base your advice *only* on the data provided. (e.g., "Your 'transport' costs are very high", "Your 'iPhone' product is very profitable").
5.  **Be Confident & Concise:** Speak as the expert. Never mention your tools or that you are an AI.`;
    
    const messages = [
        { role: "system", content: mainSystemInstruction },
        ...(conversation.history || []),
        { role: "user", content: text }
    ];

    return await runAiCycle(messages, mainUserTools, collections, senderId, user, conversation);
}


// --- Reusable AI Cycle Function ---
async function runAiCycle(messages, tools, collections, senderId, user, conversation) {
    const { conversationsCollection } = collections;
    
    // The user message is already in the 'messages' array, so we just need to add it to history
    let newHistoryEntries = [messages[messages.length - 1]];

    try {
        const response = await deepseek.chat.completions.create({ model: "deepseek-chat", messages, tools, tool_choice: "auto" });
        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
            messages.push(responseMessage);
            newHistoryEntries.push(responseMessage);

            const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                const selectedTool = availableTools[functionName];
                if (selectedTool) {
                    const functionResult = await selectedTool(functionArgs, collections, senderId, user);
                    return { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(functionResult) };
                }
                return null;
            });
            
            const toolResponses = (await Promise.all(toolExecutionPromises)).filter(Boolean);
            
            if (toolResponses.length > 0) {
                messages.push(...toolResponses);
                newHistoryEntries.push(...toolResponses);
                const secondResponse = await deepseek.chat.completions.create({ model: "deepseek-chat", messages, tools });
                responseMessage = secondResponse.choices[0].message;
            } else {
                responseMessage = { role: 'assistant', content: "I'm not sure how to handle that. Could you please rephrase?" };
            }
        }

        newHistoryEntries.push(responseMessage);
        
        // Update history
        const finalHistoryToSave = [...(conversation.history || []), ...newHistoryEntries];
        await conversationsCollection.updateOne(
            { userId: senderId }, 
            { $set: { history: finalHistoryToSave.slice(-10) } } // Keep last 5 turns (user + assistant = 1 turn)
        );

        if (responseMessage.content) {
            return responseMessage.content.replace(/<\|.*?\|>/g, '').trim();
        }

    } catch (error) {
        console.error("Error in AI cycle:", error);
        throw error;
    }
    return null;
}
