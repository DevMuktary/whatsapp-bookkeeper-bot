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

// --- ONBOARDING CONVERSATIONAL AI (FINAL VERSION w/ FIX) ---

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


// --- CURRENCY EXTRACTION and MAIN AI AGENT ---

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
    const agent = await createOpenAIFunctionsAgent({ llm: llm.bind({ temperature: 0 }), tools, prompt });
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
