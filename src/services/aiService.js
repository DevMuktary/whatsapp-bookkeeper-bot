import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "langchain/tools";
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { MongoDBChatMessageHistory } from "@langchain/mongodb";
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';
import * as onboardingService from './onboardingService.js';
import * as advisorService from './advisorService.js';

// --- 1. Initialize the AI Model ---
const llm = new ChatOpenAI({
    modelName: "deepseek-chat",
    temperature: 0,
    configuration: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
    },
});

// --- 2. Define All Available Tools for LangChain ---

// A map of all our functions that the AI can call
const availableTools = { 
    onboardUser: onboardingService.onboardUser,
    verifyEmailOTP: onboardingService.verifyEmailOTP,
    setCurrency: onboardingService.setCurrency,
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
    getInventory: accountingService.getInventory, 
    getMonthlySummary: accountingService.getMonthlySummary, 
    generateTransactionReport: reportService.generateTransactionReport, 
    generateInventoryReport: reportService.generateInventoryReport, 
    generatePnLReport: reportService.generatePnLReport,
    changeWebsitePassword: authService.changePasswordFromBot,
    requestLiveChat: liveChatService.requestLiveChat,
    getFinancialDataForAnalysis: advisorService.getFinancialDataForAnalysis,
};

// A map of descriptions for each tool, which the AI uses to decide which one to call
const toolDescriptions = {
    onboardUser: "Saves a new user's business name and email address. Generates and sends a 6-digit OTP to their email for verification.",
    verifyEmailOTP: "Verifies the 6-digit OTP that the user provides from their email.",
    setCurrency: "Sets the user's preferred currency. Infer the standard 3-letter currency code (e.g., NGN for Naira, USD for Dollar).",
    logSale: "Logs a sale of a product from inventory.",
    logTransaction: "Logs a generic income or expense (not a product sale).",
    addProduct: "Adds new products to inventory or sets opening balance.",
    getInventory: "Retrieves a list of all products in inventory.",
    getMonthlySummary: "Gets a quick text summary of finances for the current month.",
    generateTransactionReport: "Generates a PDF file of all financial transactions.",
    generateInventoryReport: "Generates a PDF file of inventory and profit.",
    generatePnLReport: "Generates a Profit and Loss (P&L) PDF statement.",
    changeWebsitePassword: "Changes the user's password for the Fynax website dashboard.",
    requestLiveChat: "Connects the user to a human support agent.",
    getFinancialDataForAnalysis: "Fetches a complete snapshot of the user's monthly data. Use this when asked for 'advice' or 'analysis'."
};

// Helper to create a LangChain agent with a specific prompt and set of tools
const createAgentExecutor = async (systemPrompt, toolNames, collections, senderId, user) => {
    const prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        new MessagesPlaceholder("chat_history"),
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad"),
    ]);

    // Create LangChain tool objects only from the names we need
    const tools = toolNames.map(name => new DynamicTool({
        name,
        description: toolDescriptions[name],
        // The 'func' for LangChain needs to be an async function that takes a string argument
        func: async (argsString) => {
            // LangChain sometimes sends an empty string for tools with no arguments
            const args = argsString ? JSON.parse(argsString) : {};
            // Call our actual service function with all the context it needs
            const result = await availableTools[name](args, collections, senderId, user);
            // Return the result as a string for the AI
            return JSON.stringify(result);
        }
    }));

    const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
    
    return new AgentExecutor({ agent, tools, verbose: false });
};

// --- ONBOARDING AI PROCESS ---
export async function processOnboardingMessage(text, collections, senderId, user) {
    const systemPrompt = `You are Fynax Bookkeeper's onboarding assistant. Your ONLY job is to guide a new user through setup. You MUST follow these steps in order, using your tools at each step.
1.  **Welcome & Collect Info:** Greet the user warmly. Ask for their business name and email address in the same message.
2.  **Use 'onboardUser' tool:** Once you have both their business name and email, you MUST call the \`onboardUser\` tool.
3.  **Ask for OTP:** After the tool is called, tell the user to check their email and ask them to provide the 6-digit code.
4.  **Use 'verifyEmailOTP' tool:** When the user provides the OTP, you MUST call the \`verifyEmailOTP\` tool.
5.  **Ask for Currency:** After the email is verified, ask the user for their primary currency (e.g., Naira, Dollars, Cedis).
6.  **Use 'setCurrency' tool:** When the user provides a currency, infer the 3-letter code (e.g., NGN, USD, GHS) and you MUST call the \`setCurrency\` tool.
7.  **Complete:** After the currency is set, congratulate them and tell them they are ready to start logging transactions.

Handle one step at a time. If a user gives you an invalid email, the tool will fail. Politely ask them for a correct one. If they say something off-topic, gently guide them back to the current step.`;
    
    const toolNames = ['onboardUser', 'verifyEmailOTP', 'setCurrency'];
    
    const agentExecutor = await createAgentExecutor(systemPrompt, toolNames, collections, senderId, user);
    const history = new MongoDBChatMessageHistory({ collection: collections.conversationsCollection, sessionId: senderId });

    const result = await agentExecutor.invoke({
        input: text,
        chat_history: await history.getMessages(),
    });

    await history.addUserMessage(text);
    await history.addAIMessage(result.output);

    return result.output;
}

// --- MAIN AI PROCESS ---
export async function processMessageWithAI(text, collections, senderId, user) {
    const systemPrompt = `You are 'Fynax Bookkeeper', an expert AI financial advisor. Your rules are absolute and you must never deviate.
1.  **Strictly Use Tools:** Your ONLY purpose is to use the tools provided. You do not have opinions or knowledge outside of these tools.
2.  **Stay in Scope:** If the user asks for anything that cannot be answered or performed by one of your tools, you MUST respond with: "I can only help with bookkeeping, inventory, and financial reports for your business. How can I assist with that?" Do not answer any other questions.
3.  **No Explanations:** Never mention your tools, that you are an AI, or how you work. Just perform the action.
4.  **Live Support:** If the user asks for a 'human', 'support', 'accountant', or seems very stuck, you MUST use the 'requestLiveChat' tool.
5.  **Financial Advisor Role:** If a user asks for 'advice', 'analysis', or 'how to improve', you MUST use the \`getFinancialDataForAnalysis\` tool. When you get data back from this tool, analyze it and provide 3-5 short, clear, actionable bullet points. Start your reply with "Here's my analysis of your month so far:"`;

    const toolNames = [
        'logSale', 'logTransaction', 'addProduct', 'getInventory', 'getMonthlySummary',
        'generateTransactionReport', 'generateInventoryReport', 'generatePnLReport',
        'changeWebsitePassword', 'requestLiveChat', 'getFinancialDataForAnalysis'
    ];
    
    const agentExecutor = await createAgentExecutor(systemPrompt, toolNames, collections, senderId, user);
    const history = new MongoDBChatMessageHistory({ collection: collections.conversationsCollection, sessionId: senderId });

    const result = await agentExecutor.invoke({
        input: text,
        chat_history: await history.getMessages(),
    });

    await history.addUserMessage(text);
    await history.addAIMessage(result.output);

    return result.output;
}
