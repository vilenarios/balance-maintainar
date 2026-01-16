// Configuration constants and defaults
export const DEFAULTS = {
  // Token decimals
  TOKEN_DECIMALS: 6,
  
  // Balance thresholds
  MIN_BALANCE: 400000,
  TARGET_BALANCE: 400000,
  MIN_TRANSFER_AMOUNT: 500,
  
  // Trading parameters
  MAX_SLIPPAGE: 20, // percentage
  
  // Scheduling
  CRON_SCHEDULE: '0 */6 * * *', // every 6 hours
  
  // Process IDs (ARIO/wUSDC defaults)
  ARIO_PROCESS_ID: 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
  WUSDC_PROCESS_ID: '7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ',
  PERMASWAP_POOL_ID: 'V7yzKBtzmY_MacDF-czrb1RY06xfidcGVrOjnhthMWM',
  
  // Timeouts
  SETTLEMENT_WAIT_TIME: 60000, // 60 seconds
  STATE_UPDATE_WAIT_TIME: 30000, // 30 seconds
  ORDER_PROCESSING_WAIT_TIME: 30000, // 30 seconds
};

// Arweave gateway configuration
export const ARWEAVE_CONFIG = {
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
};

// AO Connect configuration
export const AO_CONFIG = {
  CU_URL: 'https://cu.ao-testnet.xyz',
  MU_URL: 'https://mu.ao-testnet.xyz',
  GATEWAY_URL: 'https://arweave.net:443'
};