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
import * as onboardingService from './onboardingService.js';
import * as advisorService from './advisorService.js';

// --- 1. Initialize the AI Model ---
const llm = new ChatOpenAI({
    modelName: "deepseek-chat",
    temperature: 0, // Set to 0 for predictable extraction
    configuration: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
    },
});

// --- 2. Define Schemas for AI Extraction ---
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

const currencyExtractionFunctionSchema = {
    name: "extractCurrency",
    description: "Extracts a 3-letter currency code from a user's message.",
    parameters: {
        type: "object",
        properties: {
            currencyCode: { type: "string", description: "The standard 3-letter currency code, e.g., NGN, USD, GHS." },
        },
        required: ["currencyCode"],
    },
};

// Bind the schemas to the LLM for structured output
const llmWithDetailsExtractor = llm.bind({ functions: [extractionFunctionSchema], function_call: { name: "extractOnboardingDetails" } });
const llmWithCurrencyExtractor = llm.bind({ functions: [currencyExtractionFunctionSchema], function_call: { name: "extractCurrency" } });


// --- 3. Exported Functions for Onboarding ---
export async function extractOnboardingDetails(text) {
    try {
        const result = await llmWithDetailsExtractor.invoke([
            new SystemMessage("You are an expert at extracting business names and emails from user text. If a piece of information is not present, do not include that key in the output."),
            new HumanMessage(text),
        ]);
        if (result.additional_kwargs.function_call?.arguments) {
            return JSON.parse(result.additional_kwargs.function_call.arguments);
        }
        return {}; // Return empty object if no details found
    } catch (error) {
        console.error("Error in extractOnboardingDetails:", error);
        return {}; // Return empty on error
    }
}

export async function extractCurrency(text) {
    try {
        const result = await llmWithCurrencyExtractor.invoke([
            new SystemMessage("You are an expert at extracting a 3-letter currency code (like NGN, USD) from user text. You must infer the code from words like 'Naira' or 'Dollars'."),
            new HumanMessage(text),
        ]);
        if (result.additional_kwargs.function_call?.arguments) {
            const args = JSON.parse(result.additional_kwargs.function_call.arguments);
            return args.currencyCode || null;
        }
        return null;
    } catch (error) {
        console.error("Error in extractCurrency:", error);
        return null;
    }
}


// --- 4. Main AI Process (For Regular, Onboarded Users) ---

// A map of all our functions that the AI can call
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
    getFinancialDataForAnalysis: advisorService.getFinancialDataForAnalysis,
};

// A map of descriptions for each tool
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
    getFinancialDataForAnalysis: "Fetches a complete snapshot of the user's monthly data. Use this when asked for 'advice' or 'analysis'."
};

// Helper to create the main LangChain agent
const createMainAgentExecutor = async (collections, senderId, user) => {
    const systemPrompt = `You are 'Fynax Bookkeeper', an expert AI financial advisor.
- **Personality:** You are friendly, professional, and confident. Use relevant emojis (like ✅, 💰, 📦, 📄) where appropriate.
- **Formatting:** Use single asterisks for bolding (e.g., *this is bold*).
- **Rules:**
1.  **Use Tools:** Your ONLY purpose is to use the tools provided.
2.  **Stay in Scope:** If a user's request cannot be handled by a tool, you MUST respond with: "I can only help with bookkeeping, inventory, and financial reports for your business. How can I assist with that?"
3.  **No Explanations:** Never mention your tools or that you are an AI.
4.  **Live Support:** If a user asks for a 'human' or 'support', use the 'requestLiveChat' tool.`;

    const prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        new MessagesPlaceholder("chat_history"),
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad"),
    ]);

    const toolNames = Object.keys(availableTools); // Use all available tools

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
