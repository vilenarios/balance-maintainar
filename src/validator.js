/**
 * Configuration and wallet validation for the balance maintainer bot
 */

/**
 * Validate the main configuration object
 * @param {object} config - Configuration object
 * @param {object} logger - Winston logger instance
 * @returns {boolean} True if valid, false otherwise
 */
export function validateConfig(config, logger) {
  const errors = [];

  // Required: Target wallet address
  if (!config.targetWalletAddress) {
    errors.push('TARGET_WALLET_ADDRESS is required');
  }

  // Validate AO process ID (must be 43 characters)
  const processIdPattern = /^[a-zA-Z0-9_-]{43}$/;

  if (!processIdPattern.test(config.targetToken.processId)) {
    errors.push('TARGET_TOKEN_PROCESS_ID must be a valid 43-character process ID');
  }

  // Validate token decimals
  if (isNaN(config.targetToken.decimals) || config.targetToken.decimals < 0 || config.targetToken.decimals > 18) {
    errors.push('TARGET_TOKEN_DECIMALS must be a number between 0 and 18');
  }

  // Validate Base chain configuration
  if (!config.base.privateKey) {
    errors.push('BASE_PRIVATE_KEY is required');
  } else if (!isValidPrivateKey(config.base.privateKey)) {
    errors.push('BASE_PRIVATE_KEY must be a valid hex string (with or without 0x prefix)');
  }

  if (config.base.rpcUrl && !isValidUrl(config.base.rpcUrl)) {
    errors.push('BASE_RPC_URL must be a valid URL');
  }

  // Validate contract addresses (Ethereum addresses are 42 chars with 0x prefix)
  const ethAddressPattern = /^0x[a-fA-F0-9]{40}$/;

  if (config.base.arioContract && !ethAddressPattern.test(config.base.arioContract)) {
    errors.push('ARIO_BASE_CONTRACT must be a valid Ethereum address');
  }

  if (config.base.usdcContract && !ethAddressPattern.test(config.base.usdcContract)) {
    errors.push('USDC_BASE_CONTRACT must be a valid Ethereum address');
  }

  // Validate min ETH balance
  if (isNaN(config.base.minEthBalance) || config.base.minEthBalance < 0) {
    errors.push('MIN_ETH_BALANCE must be a positive number');
  }

  // Validate balances
  if (config.minBalance <= 0) {
    errors.push('MIN_BALANCE must be greater than 0');
  }

  if (config.targetBalance <= 0) {
    errors.push('TARGET_BALANCE must be greater than 0');
  }

  if (config.targetBalance < config.minBalance) {
    errors.push('TARGET_BALANCE must be greater than or equal to MIN_BALANCE');
  }

  // Validate slippage
  if (config.maxSlippage <= 0 || config.maxSlippage > 100) {
    errors.push('MAX_SLIPPAGE must be between 0 and 100');
  }

  // Validate min transfer amount
  if (config.minTransferAmount < 0) {
    errors.push('MIN_TRANSFER_AMOUNT must be a non-negative number');
  }

  // Validate cron schedule (5 or 6 fields)
  const cronFields = config.cronSchedule.trim().split(/\s+/);
  if (cronFields.length < 5 || cronFields.length > 6) {
    errors.push('CRON_SCHEDULE must be a valid cron expression (5 or 6 fields)');
  }

  // Validate Slack config if enabled
  if (config.notifications?.slack?.enabled) {
    if (!config.notifications.slack.token || config.notifications.slack.token === 'xoxb-your-slack-bot-token-here') {
      errors.push('SLACK_TOKEN must be configured when Slack is enabled');
    }
    // Note: SLACK_CHANNEL has a default in slack.js (#balance-maintainar), so it's optional
  }

  // Log validation results
  if (errors.length > 0) {
    logger.error('Configuration validation failed:');
    errors.forEach(error => logger.error(`  - ${error}`));
    return false;
  }

  logger.info('Configuration validation passed');
  return true;
}

/**
 * Validate Arweave JWK wallet format
 * @param {object} wallet - Wallet object
 * @param {object} logger - Winston logger instance
 * @returns {boolean} True if valid, false otherwise
 */
export function validateWallet(wallet, logger) {
  try {
    // Check if wallet has required RSA key properties
    const requiredFields = ['d', 'dp', 'dq', 'e', 'kty', 'n', 'p', 'q', 'qi'];
    const missingFields = requiredFields.filter(field => !wallet[field]);

    if (missingFields.length > 0) {
      logger.error(`Invalid wallet format. Missing fields: ${missingFields.join(', ')}`);
      return false;
    }

    if (wallet.kty !== 'RSA') {
      logger.error('Invalid wallet type. Expected RSA key');
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Failed to validate wallet:', error);
    return false;
  }
}

/**
 * Validate a private key format
 * @param {string} key - Private key string
 * @returns {boolean} True if valid hex format
 */
function isValidPrivateKey(key) {
  if (!key) return false;

  // Remove 0x prefix if present
  const cleanKey = key.startsWith('0x') ? key.slice(2) : key;

  // Private key should be 64 hex characters (32 bytes)
  const hexPattern = /^[a-fA-F0-9]{64}$/;
  return hexPattern.test(cleanKey);
}

/**
 * Validate a URL format
 * @param {string} url - URL string
 * @returns {boolean} True if valid URL
 */
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
