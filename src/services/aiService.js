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


// --- MAIN AI AGENT (UPGRADED WITH NEW TOOL) ---
const availableTools = { 
    // Accounting Tools
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
    getInventory: accountingService.getInventory, 
    getMonthlySummary: accountingService.getMonthlySummary, 
    // Report Tools
    generateSalesReport: reportService.generateSalesReport, // <-- NEW TOOL ADDED
    generateTransactionReport: reportService.generateTransactionReport, 
    generateInventoryReport: reportService.generateInventoryReport, 
    generatePnLReport: reportService.generatePnLReport,
    // Other Tools
    changeWebsitePassword: authService.changePasswordFromBot,
    requestLiveChat: liveChatService.requestLiveChat,
};

const toolDescriptions = {
    // Accounting
    logSale: "Use this to log a customer sale. You must first collect all of the following details: customer name, product name, units sold, total amount, date of sale, and the sale type (cash or credit).",
    logTransaction: "Use this to log a general business expense. You must first collect all of the following details: date of the expense, the expense type (e.g., transport, supplies), the total amount, and an optional description.",
    addProduct: "Use this to add a new product to the inventory. You must first collect all of the following details: product name, opening balance (quantity), cost price per unit, and selling price per unit.",
    getInventory: "Retrieves a list of all products in inventory.",
    getMonthlySummary: "Gets a quick text summary of finances for the current month.",
    // Reporting
    generateSalesReport: "Generates a PDF report of all sales (income transactions). It requires a 'timeFrame' argument, such as 'today', 'yesterday', 'this week', 'last week', or 'this month'.", // <-- NEW DESCRIPTION
    generateTransactionReport: "Generates a PDF file of all financial transactions (both income and expenses) for the current month only.",
    generateInventoryReport: "Generates a PDF file of inventory and profit for the current month.",
    generatePnLReport: "Generates a Profit and Loss (P&L) PDF statement for the current month.",
    // Other
    changeWebsitePassword: "Changes the user's password for the Fynax website dashboard.",
    requestLiveChat: "Connects the user to a human support agent.",
};

const createMainAgentExecutor = async (collections, senderId, user) => {
    const systemPrompt = `You are 'Fynax Bookkeeper', a friendly and expert AI assistant.
- Your primary goal is to help users log transactions or add inventory by having a natural conversation to collect the necessary details.
- Formatting: Use single asterisks for bolding (*bold*). Do not use double asterisks.
- Personality: Be friendly, professional, and confident. Use relevant emojis (like ✅, 💰, 📦, 📄).

**Your Core Workflow (CRITICAL):**
1.  **Initiate:** When a user expresses intent (e.g., "log a sale"), start a conversation by asking for the information required by the corresponding tool.
2.  **Collect:** Gather the details from the user's responses. They might provide it all at once or one piece at a time. Handle this gracefully.
3.  **Confirm:** Once you believe you have all the necessary details for a tool, you MUST summarize them clearly for the user and ask for their confirmation with a direct question (e.g., "Is this all correct?", "Should I go ahead and log this?").
4.  **Correct:** If the user says no or corrects a detail, update the information you have and re-confirm the new details.
5.  **Execute:** ONLY after getting a clear confirmation (e.g., "yes", "correct", "proceed") should you call the appropriate tool with the collected information.
6.  **Stay in Scope:** If a user's request cannot be handled by a tool, you MUST respond with: "I can only help with bookkeeping, inventory, and financial reports. How can I assist with that?"
7.  **Live Support:** If a user asks for a 'human' or 'support', use the 'requestLiveChat' tool immediately.`;

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
