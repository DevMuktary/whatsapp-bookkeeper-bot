import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { MongoDBChatMessageHistory } from "@langchain/mongodb";
import { DynamicTool } from "langchain/tools";
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';
// Onboarding service is no longer called from here

const llm = new ChatOpenAI({
    modelName: "deepseek-chat",
    temperature: 0,
    configuration: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
    },
});

// --- AI FUNCTIONS FOR EXTRACTION ---

const extractionFunctionSchema = {
    name: "extractOnboardingDetails",
    description: "Extracts business name and email from a user's message.",
    parameters: {
        type: "object",
        properties: {
            businessName: { type: "string", description: "The user's business name." },
            email: { type: "string", description: "The user's email address." },
        },
    },
};
const llmWithDetailsExtractor = llm.bind({ functions: [extractionFunctionSchema], function_call: { name: "extractOnboardingDetails" } });

export async function extractOnboardingDetails(text) {
    try {
        const result = await llmWithDetailsExtractor.invoke([ new HumanMessage(text) ]);
        if (result.additional_kwargs.function_call?.arguments) {
            return JSON.parse(result.additional_kwargs.function_call.arguments);
        }
        return {};
    } catch (error) { console.error("Error in extractOnboardingDetails:", error); return {}; }
}

const currencyExtractionFunctionSchema = {
    name: "extractCurrency",
    description: "Extracts a 3-letter currency code from a user's message.",
    parameters: { type: "object", properties: { currencyCode: { type: "string", description: "The standard 3-letter currency code, e.g., NGN, USD, GHS." } }, required: ["currencyCode"] },
};
const llmWithCurrencyExtractor = llm.bind({ functions: [currencyExtractionFunctionSchema], function_call: { name: "extractCurrency" } });

export async function extractCurrency(text) {
    try {
        const result = await llmWithCurrencyExtractor.invoke([ new HumanMessage(`Infer the 3-letter currency code from this text: "${text}"`) ]);
        if (result.additional_kwargs.function_call?.arguments) {
            const args = JSON.parse(result.additional_kwargs.function_call.arguments);
            return args.currencyCode || null;
        }
        return null;
    } catch (error) { console.error("Error in extractCurrency:", error); return null; }
}


// --- MAIN AI PROCESS (For Regular, Onboarded Users) ---
const availableTools = { 
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
};
const toolDescriptions = {
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
};

const createMainAgentExecutor = async (collections, senderId, user) => {
    const systemPrompt = `You are 'Fynax Bookkeeper', an expert AI assistant.
- Personality: You are friendly, professional, and confident. Use relevant emojis (like ✅, 💰, 📦, 📄).
- Formatting: Use single asterisks for bolding (*bold*).
- Rules:
1.  **Use Tools:** Your ONLY purpose is to use the tools provided.
2.  **Stay in Scope:** If a user's request cannot be handled by a tool, you MUST respond with: "I can only help with bookkeeping, inventory, and financial reports for your business. How can I assist with that?"
3.  **Live Support:** If a user asks for a 'human' or 'support', use the 'requestLiveChat' tool.`;

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
    const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
    return new AgentExecutor({ agent, tools, verbose: false });
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
