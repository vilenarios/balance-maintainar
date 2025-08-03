import winston from 'winston';

export function validateConfig(config, logger) {
  const errors = [];
  
  // Required fields
  if (!config.targetWalletAddress) {
    errors.push('TARGET_WALLET_ADDRESS is required');
  }
  
  // Validate process IDs (must be 43 characters)
  const processIdPattern = /^[a-zA-Z0-9_-]{43}$/;
  
  if (!processIdPattern.test(config.targetToken.processId)) {
    errors.push('TARGET_TOKEN_PROCESS_ID must be a valid 43-character process ID');
  }
  
  if (!processIdPattern.test(config.sourceToken.processId)) {
    errors.push('SOURCE_TOKEN_PROCESS_ID must be a valid 43-character process ID');
  }
  
  if (!processIdPattern.test(config.permaswapPoolId)) {
    errors.push('PERMASWAP_POOL_ID must be a valid 43-character process ID');
  }
  
  // Validate decimals
  if (isNaN(config.targetToken.decimals) || config.targetToken.decimals < 0 || config.targetToken.decimals > 18) {
    errors.push('TARGET_TOKEN_DECIMALS must be a number between 0 and 18');
  }
  
  if (isNaN(config.sourceToken.decimals) || config.sourceToken.decimals < 0 || config.sourceToken.decimals > 18) {
    errors.push('SOURCE_TOKEN_DECIMALS must be a number between 0 and 18');
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
  
  // Validate cron schedule - node-cron uses standard cron format
  // We'll use a simpler validation that just checks the field count
  const cronFields = config.cronSchedule.trim().split(/\s+/);
  if (cronFields.length < 5 || cronFields.length > 6) {
    errors.push('CRON_SCHEDULE must be a valid cron expression (5 or 6 fields)');
  }
  
  // Validate Slack config if enabled (either explicitly or auto-detected)
  if (config.notifications.slack.enabled) {
    if (!config.notifications.slack.token || config.notifications.slack.token === 'xoxb-your-slack-bot-token-here') {
      errors.push('SLACK_TOKEN must be configured when Slack is enabled');
    }
    // Only validate channel if token is configured
    if (config.notifications.slack.token && config.notifications.slack.token !== 'xoxb-your-slack-bot-token-here' && !config.notifications.slack.channel) {
      errors.push('SLACK_CHANNEL must be configured when Slack is enabled');
    }
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