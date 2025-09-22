import OpenAI from 'openai';
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';

// --- AI Client Initialization ---
const deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
});

// --- AI Tool Definitions ---
const tools = [
  { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory. This is the primary tool for recording sales.', parameters: { type: 'object', properties: { productName: { type: 'string', description: 'The name of the product sold, e.g., "iPhone 17 Air".' }, quantitySold: { type: 'number', description: 'The number of units sold.' }, totalAmount: { type: 'number', description: 'The total income received from the sale.' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } },
  { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense that is NOT a product sale, such as "rent", "utilities", or "service income".', parameters: { type: 'object', properties: { type: { type: 'string', description: 'The type of transaction, either "income" or "expense".' }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string', description: 'For expenses, a category like "rent", "utilities", "transport". Defaults to "Uncategorized".' } }, required: ['type', 'amount', 'description'] } } },
  { type: "function", function: { name: 'addProduct', description: 'Adds one or more new products to inventory. If a product already exists, this updates its price and adds to its stock.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'setOpeningBalance', description: 'Sets the initial inventory or opening balance for a user.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of total income, expenses, and net balance for the current month.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions. Use only when the user explicitly asks to "export", "download", or receive a "PDF report".', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit. Use only when the user explicitly asks for an "inventory report" or "profit report".', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement. Use only when the user asks for a "P&L" or "statement".', parameters: { type: 'object', properties: {} } } },
];

// --- Tool Function Mapping ---
const availableTools = { 
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
    setOpeningBalance: accountingService.setOpeningBalance, 
    getInventory: accountingService.getInventory, 
    getMonthlySummary: accountingService.getMonthlySummary, 
    generateTransactionReport: reportService.generateTransactionReport, 
    generateInventoryReport: reportService.generateInventoryReport, 
    generatePnLReport: reportService.generatePnLReport 
};

// --- Core AI Processing Function ---
export async function processMessageWithAI(text, collections, senderId, sock) {
    const { conversationsCollection } = collections;
    
    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        const savedHistory = conversation ? conversation.history : [];
        
        const systemInstruction = `You are 'Fynax Bookkeeper', a professional, confident, and friendly AI bookkeeping assistant. Your name is Fynax Bookkeeper. Follow these rules with absolute priority: 1. **Use Tools for All Data Questions:** If a user asks a question about their specific financial or inventory data, you MUST use a tool to get the answer. Your primary job is to call the correct function. 2. **Never Explain Yourself:** Do not mention your functions, code, or that you are an AI. Speak as if you are the one performing the action. 3. **CRITICAL RULE:** Never, under any circumstances, write tool call syntax like "<|tool_calls_begin|>" or other code in your text responses. Your responses must be clean, natural language only. 4. **Stay Within Abilities:** ONLY perform actions defined in the available tools. If asked to do something else (like send an email or browse the internet), politely state your purpose is bookkeeping for their business. Do not answer questions outside of this scope. 5. **Use the Right Tool:** Use 'logSale' for product sales. Use 'logTransaction' for other income/expenses. Use 'getMonthlySummary' for simple questions about totals. Use the 'generate...Report' tools for export requests. 6. **Be Confident & Concise:** When a tool is called, assume it was successful. Announce the result confidently.`;
        
        const messages = [
            { role: "system", content: systemInstruction },
            ...savedHistory,
            { role: "user", content: text }
        ];

        let newHistoryEntries = [{ role: 'user', content: text }];

        const response = await deepseek.chat.completions.create({ 
            model: "deepseek-chat", 
            messages: messages, 
            tools: tools, 
            tool_choice: "auto" 
        });
        
        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
            messages.push(responseMessage);
            
            const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                const selectedTool = availableTools[functionName];
                if (selectedTool) {
                    const functionResult = await selectedTool(functionArgs, collections, senderId, sock);
                    return { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(functionResult) };
                }
                return null;
            });
            
            const toolResponses = (await Promise.all(toolExecutionPromises)).filter(Boolean);
            
            if (toolResponses.length > 0) {
                messages.push(...toolResponses);
                newHistoryEntries.push(responseMessage, ...toolResponses);

                const secondResponse = await deepseek.chat.completions.create({ model: "deepseek-chat", messages: messages });
                responseMessage = secondResponse.choices[0].message;
            } else {
                responseMessage = { role: 'assistant', content: "I'm not sure how to handle that. Could you please rephrase?" };
                newHistoryEntries = [{ role: 'user', content: text }];
            }
        }

        newHistoryEntries.push(responseMessage);

        if (responseMessage.content) {
            const cleanContent = responseMessage.content.replace(/<\|.*?\|>/g, '').trim();
            if (cleanContent) {
                 await sock.sendMessage(senderId, { text: cleanContent });
            }
        }

        const finalHistoryToSave = [...savedHistory, ...newHistoryEntries];
        const MAX_TURNS_TO_KEEP = 5;
        let userMessageCount = 0;
        let startIndex = -1;

        for (let i = finalHistoryToSave.length - 1; i >= 0; i--) {
            if (finalHistoryToSave[i].role === 'user') {
                userMessageCount++;
                if (userMessageCount === MAX_TURNS_TO_KEEP) {
                    startIndex = i;
                    break;
                }
            }
        }

        const prunedHistory = startIndex !== -1 ? finalHistoryToSave.slice(startIndex) : finalHistoryToSave;
        
        await conversationsCollection.updateOne(
            { userId: senderId }, 
            { $set: { history: prunedHistory, updatedAt: new Date() } }, 
            { upsert: true }
        );
        
    } catch (error) {
        console.error("Detailed error in AI message handler:", error);
        throw error; // Re-throw the error to be caught by handleMessage
    }
}
