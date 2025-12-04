// A central place for all configuration.
const config = {
  port: process.env.PORT || 3000,
  mongoURI: process.env.MONGO_URI,
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    // [UPDATED] Separate Flow IDs
    onboardingFlowId: process.env.WHATSAPP_ONBOARDING_FLOW_ID || process.env.WHATSAPP_FLOW_ID, // Fallback to old name
    bankFlowId: process.env.WHATSAPP_BANK_FLOW_ID 
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY 
  },
  brevo: {
    apiKey: process.env.BREVO_API_KEY
  },
  // Robust Redis Config for Railway
  redis: {
    // Railway provides REDIS_URL (Public) or REDIS_PRIVATE_URL (Private). 
    url: process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    options: {
        maxRetriesPerRequest: null, 
        // Auto-enable TLS for 'rediss://' URLs
        tls: (process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || '').startsWith('rediss') 
             ? { rejectUnauthorized: false } 
             : undefined
    }
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Basic validation
if (!config.mongoURI || !config.whatsapp.token) {
  console.error("FATAL ERROR: Missing critical environment variables.");
  process.exit(1);
}

export default config;
