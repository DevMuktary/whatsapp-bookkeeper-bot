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

// --- ONBOARDING CONVERSATIONAL AI ---
const onboardingSystemPrompt = `You are an onboarding assistant for 'Fynax Bookkeeper'.
Your SOLE GOAL is to collect a business name and a valid email address from the user.
- Be conversational and friendly.
- You can ask for the details one at a time.
- If the user provides an invalid email, ask them for a correct one.
- Once you are confident that you have successfully collected BOTH a business name AND a valid email address, your FINAL response MUST BE ONLY a raw JSON object with the collected data.
- The JSON object should look like this: {{\"businessName\": \"Example Inc.\", \"email\": \"user@example.com\"}}
- DO NOT add any other text, greetings, or markdown formatting to the final JSON response. Just the raw JSON.`;

const onboardingPrompt = ChatPromptTemplate.fromMessages([
    ["system", onboardingSystemPrompt],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
]);

const onboardingChain = onboardingPrompt.pipe(llm).pipe(new StringOutputParser());

export async function processOnboardingMessage(text, collections, senderId) {
    const history = new MongoDBChatMessageHistory({
        collection: collections.conversationsCollection,
        sessionId: senderId,
    });
    
    const aiResponse = await onboardingChain.invoke({
        input: text,
        chat_history: await history.getMessages(),
    });

    try {
        JSON.parse(aiResponse);
    } catch (e) {
        await history.addUserMessage(text);
        await history.addAIMessage(aiResponse);
    }

    return aiResponse;
}


// --- CURRENCY EXTRACTION ---
const currencySystemPrompt = `You are an expert currency identifier. Your only task is to identify the official 3-letter ISO 4217 currency code from the user's text.
The user might provide the currency name (e.g., 'Naira', 'Dollars'), a symbol (e.g., '₦', '$'), or slang (e.g., 'bucks').
If you can confidently identify the currency, respond with ONLY the 3-letter code (e.g., NGN, USD, GHS).
If you cannot identify a currency, respond with the single word: UNKNOWN.`;

const currencyPrompt = ChatPromptTemplate.fromMessages([
    ["system", currencySystemPrompt],
    ["human", "{text}"],
]);

const currencyChain = currencyPrompt.pipe(llm).pipe(new StringOutputParser());

export async function extractCurrency(text) {
    try {
        const result = await currencyChain.invoke({ text });
        if (result && result.trim().toUpperCase() !== 'UNKNOWN' && result.trim().length === 3) {
            return result.trim().toUpperCase();
        }
        return null;
    } catch (error) {
        console.error("Error in extractCurrency:", error);
        return null;
    }
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
    changeWebsitePassword: authService.changeWebsitePassword,
    requestLiveChat: liveChatService.requestLiveChat,
};

const toolDescriptions = {
    logSale: "Use this to log a customer sale. You need the following details: customer name, product name, units sold, total amount, date of sale, and the sale type (cash or credit).",
    logTransaction: "Use this to log a general business expense. You need the following details: date of the expense, the expense type (e.g., transport, supplies), the total amount, and an optional description.",
    addProduct: "Use this to add a new product to the inventory. You must have all four of the following details: the *productName*, the *openingBalance* (initial quantity), the *costPrice* per unit, and the *sellingPrice* per unit.",
    getInventory: "Retrieves a list of all products in inventory as a text message.",
    getMonthlySummary: "Gets a quick text summary of finances for the current month.",
    generateSalesReport: "Generates a PDF report of all sales (income transactions). It requires a 'timeFrame' argument, such as 'today', 'yesterday', 'this week', 'last week', or 'this month'.",
    generateTransactionReport: "Generates a PDF file of all financial transactions (both income and expenses) for the current month only.",
    generateInventoryReport: "Generates a PDF file of inventory and profit for the current month.",
    generatePnLReport: "Generates a Profit and Loss (P&L) PDF statement for the current month.",
    changeWebsitePassword: "Changes the user's password for the Fynax website dashboard.",
    requestLiveChat: "Connects the user to a human support agent for help.",
};

const createMainAgentExecutor = async (collections, senderId, user) => {
    // --- NEW, SIMPLIFIED SYSTEM PROMPT ---
    const systemPrompt = `You are 'Fynax Bookkeeper', a friendly and professional AI bookkeeping assistant.
- Your main purpose is to help users manage their business finances by calling the tools you have been given.
- If you are missing information to call a tool, you MUST ask the user for the missing details in a friendly way.
- Before executing a tool that writes data (like logging a sale or adding a product), briefly summarize the details and ask for the user's confirmation.
- Use single asterisks for bolding (*bold*).
- Use relevant emojis (like ✅, 💰, 📦, 📄).`;

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
