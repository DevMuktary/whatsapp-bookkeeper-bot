import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { MongoDBChatMessageHistory } from "@langchain/mongodb";
import { DynamicTool } from "langchain/tools";
import { StringOutputParser } from "@langchain/core/output_parsers";
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';

const llm = new ChatOpenAI({
    modelName: "deepseek-chat",
    temperature: 0.1,
    configuration: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
    },
});

// --- ONBOARDING & CURRENCY EXTRACTION (No changes here) ---
const onboardingSystemPrompt = `You are an onboarding assistant for 'Fynax Bookkeeper'. Your SOLE GOAL is to collect a business name and a valid email address from the user. - Be conversational and friendly. - You can ask for the details one at a time. - If the user provides an invalid email, ask them for a correct one. - Once you are confident that you have successfully collected BOTH a business name AND a valid email address, your FINAL response MUST BE ONLY a raw JSON object with the collected data. - The JSON object should look like this: {{\"businessName\": \"Example Inc.\", \"email\": \"user@example.com\"}} - DO NOT add any other text, greetings, or markdown formatting to the final JSON response. Just the raw JSON.`;
const onboardingPrompt = ChatPromptTemplate.fromMessages([["system", onboardingSystemPrompt], new MessagesPlaceholder("chat_history"), ["human", "{input}"]]);
const onboardingChain = onboardingPrompt.pipe(llm).pipe(new StringOutputParser());
export async function processOnboardingMessage(text, collections, senderId) {
    const history = new MongoDBChatMessageHistory({ collection: collections.conversationsCollection, sessionId: senderId });
    const aiResponse = await onboardingChain.invoke({ input: text, chat_history: await history.getMessages() });
    try { JSON.parse(aiResponse); } catch (e) { await history.addUserMessage(text); await history.addAIMessage(aiResponse); }
    return aiResponse;
}
const currencySystemPrompt = `You are an expert currency identifier. Your only task is to identify the official 3-letter ISO 4217 currency code from the user's text. The user might provide the currency name (e.g., 'Naira', 'Dollars'), a symbol (e.g., '₦', '$'), or slang (e.g., 'bucks'). If you can confidently identify the currency, respond with ONLY the 3-letter code (e.g., NGN, USD, GHS). If you cannot identify a currency, respond with the single word: UNKNOWN.`;
const currencyPrompt = ChatPromptTemplate.fromMessages([["system", currencySystemPrompt], ["human", "{text}"]]);
const currencyChain = currencyPrompt.pipe(llm).pipe(new StringOutputParser());
export async function extractCurrency(text) {
    try {
        const result = await currencyChain.invoke({ text });
        if (result && result.trim().toUpperCase() !== 'UNKNOWN' && result.trim().length === 3) {
            return result.trim().toUpperCase();
        }
        return null;
    } catch (error) { console.error("Error in extractCurrency:", error); return null; }
}


// --- MAIN AI AGENT (FINAL VERSION) ---
const availableTools = { 
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
    getInventory: accountingService.getInventory, 
    getMonthlySummary: accountingService.getMonthlySummary, 
    generateSalesReport: reportService.generateSalesReport,
    generateTransactionReport: reportService.generateTransactionReport, 
    generateInventoryReport: reportService.generateInventoryReport, 
    generatePnLReport: reportService.generatePnLReport,
    changeWebsitePassword: authService.changePasswordFromBot,
    requestLiveChat: liveChatService.requestLiveChat,
};

// --- TOOL DESCRIPTIONS SYNCED WITH ACCOUNTING SERVICE ---
const toolDescriptions = {
    logSale: "Logs a customer sale. You need the following arguments: customerName, productName, unitsSold, amount, date, and saleType (cash or credit).",
    logTransaction: "Logs a general business expense. You need the following arguments: date, expenseType, amount, and an optional description.",
    addProduct: "Adds a new product to inventory. You must have all four of the following arguments: productName, quantity, costPrice (per unit), and sellingPrice (per unit).",
    getInventory: "Retrieves a list of all products in inventory as a text message.",
    getMonthlySummary: "Gets a quick text summary of finances for the current month.",
    generateSalesReport: "Generates a PDF report of sales for a specific 'timeFrame' (e.g., 'today', 'this week').",
    generateTransactionReport: "Generates a PDF file of all financial transactions for the current month.",
    generateInventoryReport: "Generates a PDF file of inventory and profit for the current month.",
    generatePnLReport: "Generates a Profit & Loss (P&L) PDF statement for the current month.",
    changeWebsitePassword: "Changes the user's password for the Fynax website dashboard.",
    requestLiveChat: "Connects the user to a human support agent for help.",
};

const createMainAgentExecutor = async (collections, senderId, user) => {
    const systemPrompt = `You are 'Fynax Bookkeeper', a friendly and professional AI bookkeeping assistant.
- Your main purpose is to help users manage their business finances by calling the tools you have been given.
- If you are missing required arguments for a tool, you MUST ask the user for the missing information.
- Before executing a tool that writes data (like logging a sale or adding a product), you MUST briefly summarize the details and ask for the user's confirmation. Only call the tool after the user agrees.
- Use single asterisks for bolding (*bold*) and relevant emojis (like ✅, 💰, 📦, 📄).`;

    const prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        new MessagesPlaceholder("chat_history"),
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad"),
    ]);

    const toolNames = Object.keys(availableTools);
    const tools = toolNames.map(name => new DynamicTool({
        name,
        description: toolDescriptions[name],
        func: async (argsString) => {
            const args = argsString ? JSON.parse(argsString) : {};
            const result = await availableTools[name](args, collections, senderId, user);
            return JSON.stringify(result);
        }
    }));

    const agent = await createOpenAIFunctionsAgent({
        llm: llm.bind({ temperature: 0 }),
        tools,
        prompt
    });

    return new AgentExecutor({
        agent,
        tools,
        // Set to true for extremely detailed debugging in your Railway logs
        verbose: false 
    });
};

export async function processMessageWithAI(text, collections, senderId, user) {
    const agentExecutor = await createMainAgentExecutor(collections, senderId, user);
    
    const history = new MongoDBChatMessageHistory({
        collection: collections.conversationsCollection,
        sessionId: senderId,
    });
    
    const result = await agentExecutor.invoke({
        input: text,
        chat_history: await history.getMessages(),
    });

    await history.addUserMessage(text);
    await history.addAIMessage(result.output);
    
    return result.output;
}
