export const USER_STATES = {
  // A brand new user, has sent their first message
  NEW_USER: 'NEW_USER',
  
  // Onboarding States
  ONBOARDING_AWAIT_BUSINESS_AND_EMAIL: 'ONBOARDING_AWAIT_BUSINESS_AND_EMAIL',
  ONBOARDING_AWAIT_OTP: 'ONBOARDING_AWAIT_OTP',
  ONBOARDING_AWAIT_CURRENCY: 'ONBOARDING_AWAIT_CURRENCY',

  // Core State
  IDLE: 'IDLE',

  // Task-specific states
  LOGGING_SALE: 'LOGGING_SALE',
  AWAITING_INVOICE_CONFIRMATION: 'AWAITING_INVOICE_CONFIRMATION',

  // Add other states here as we build them...
};

export const INTENTS = {
    LOG_SALE: 'LOG_SALE',
    // Add other intents like LOG_EXPENSE, ADD_PRODUCT etc. later
};
