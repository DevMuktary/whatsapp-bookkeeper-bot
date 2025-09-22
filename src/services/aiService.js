import OpenAI from 'openai';
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js'; // <-- NEW IMPORT

// --- AI Client Initialization ---
const deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
});

// --- AI Tool Definitions (UPDATED) ---
const tools = [
  // ... (all existing tools)
  { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory.', parameters: { type: 'object', properties: { productName: { type: 'string' }, quantitySold: { type: 'number' }, totalAmount: { type: 'number' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } },
  { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense (not a product sale).', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['income', 'expense'] }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string' } }, required: ['type', 'amount', 'description'] } } },
  { type: "function", function: { name: 'addProduct', description: 'Adds new products to inventory.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'setOpeningBalance', description: 'Sets the initial inventory or opening balance.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of finances for the current month.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'changeWebsitePassword', description: "Changes the user's password for the Fynax website dashboard.", parameters: { type: 'object', properties: { newPassword: { type: 'string', description: 'The new password. Must be at least 6 characters.' } }, required: ['newPassword'] } } },
  
  // --- NEWLY ADDED TOOL ---
  {
    type: "function",
    function: {
      name: 'requestLiveChat',
      description: "Connects the user to a human support agent. Use this if the user asks for a human, is stuck, or explicitly requests 'support' or 'accountant'.",
      parameters: {
        type: 'object',
        properties: {
          issue: {
            type: 'string',
            description: "A brief summary of the user's issue that the AI can understand. e.g., 'User is confused about P&L report'."
          }
        },
        required: ['issue']
      }
    }
  }
];

// --- Tool Function Mapping (UPDATED) ---
const availableTools = { 
    // Accounting
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
    setOpeningBalance: accountingService.setOpeningBalance, 
    getInventory: accountingService.getInventory, 
    getMonthlySummary: accountingService.getMonthlySummary, 
    
    // Reporting
    generateTransactionReport: reportService.generateTransactionReport, 
    generateInventoryReport: reportService.generateInventoryReport, 
    generatePnLReport: reportService.generatePnLReport,

    // Auth
    changeWebsitePassword: authService.changePasswordFromBot,

    // --- NEWLY ADDED MAPPING ---
    requestLiveChat: liveChatService.requestLiveChat
};

// --- Core AI Processing Function (UPDATED) ---
export async function processMessageWithAI(text, collections, senderId, sock, user) { // <-- Pass 'user'
    const { conversationsCollection } = collections;
    
    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        const savedHistory = conversation ? conversation.history : [];
        
        // --- UPDATED SYSTEM PROMPT ---
        const systemInstruction = `You are 'Fynax Bookkeeper', a professional AI bookkeeping assistant. Your name is Fynax Bookkeeper. Follow these rules: 1. **Use Tools:** Your primary job is to use tools to answer questions about user data or perform actions. 2. **Never Explain:** Do not mention your functions, code, or that you are an AI. Speak as if you are the one performing the action. 3. **No Code:** Never write tool call syntax in your text responses. 4. **Stay in Scope:** Your abilities are: logging sales/expenses, managing inventory, generating reports, changing website passwords, and **connecting the user to live support**. If asked to do something else, politely state your purpose is bookkeeping. 5. **Live Support:** If the user asks for a 'human', 'support', 'accountant', or seems very stuck, use the 'requestLiveChat' tool. This is a high-priority action. 6. **Password Rule:** If a user wants to change their password, use 'changeWebsitePassword' and ensure it's 6+ characters. 7. **Be Confident & Concise.**`;
        
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
                    // Pass all required args
                    const functionResult = await selectedTool(functionArgs, collections, senderId, sock, user);
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

        // History pruning...
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
        throw error;
    }
}
