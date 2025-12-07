// A central place for all configuration.
const config = {
  port: process.env.PORT || 3000,
  mongoURI: process.env.MONGO_URI,
  // [UPDATED] Support Multiple Admins (Split by comma)
  adminPhones: process.env.ADMIN_PHONE ? process.env.ADMIN_PHONE.split(',').map(p => p.trim()) : [],
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET, // [NEW] Required for Webhook Security
    onboardingFlowId: process.env.WHATSAPP_ONBOARDING_FLOW_ID || process.env.WHATSAPP_FLOW_ID, 
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
  paystack: {
    publicKey: process.env.PAYSTACK_PUBLIC_KEY,
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET,
    prices: {
        ngnMonthly: 7500,
        usdMonthly: 5 
    }
  },
  redis: {
    url: process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    options: {
        maxRetriesPerRequest: null, 
        tls: (process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || '').startsWith('rediss') 
             ? { rejectUnauthorized: false } 
             : undefined
    }
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

if (!config.mongoURI || !config.whatsapp.token) {
  console.error("FATAL ERROR: Missing critical environment variables.");
  process.exit(1);
}

export default config;
