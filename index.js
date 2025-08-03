import { connect, message, result, dryrun, createDataItemSigner } from '@permaweb/aoconnect';
import Arweave from 'arweave';
import cron from 'node-cron';
import winston from 'winston';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { PermaswapDEX } from './src/permaswap.js';
import { sendSwapNotification, sendMessageToSlack } from './src/slack.js';
import { validateConfig, validateWallet } from './src/validator.js';

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'topup-bot.log' })
  ]
});

const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

const config = {
  walletPath: process.env.WALLET_PATH || './wallet.json',
  turboWalletAddress: process.env.TURBO_WALLET_ADDRESS,
  targetWalletAddress: process.env.TARGET_WALLET_ADDRESS,
  
  // Token configuration - flexible for any token pair
  targetToken: {
    processId: process.env.TARGET_TOKEN_PROCESS_ID || process.env.ARIO_PROCESS_ID || 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
    symbol: process.env.TARGET_TOKEN_SYMBOL || 'ARIO',
    decimals: parseInt(process.env.TARGET_TOKEN_DECIMALS || '6')
  },
  sourceToken: {
    processId: process.env.SOURCE_TOKEN_PROCESS_ID || process.env.WUSDC_PROCESS_ID || '7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ',
    symbol: process.env.SOURCE_TOKEN_SYMBOL || 'wUSDC',
    decimals: parseInt(process.env.SOURCE_TOKEN_DECIMALS || '6')
  },
  
  // Legacy support for old env vars
  arioProcessId: process.env.TARGET_TOKEN_PROCESS_ID || process.env.ARIO_PROCESS_ID || 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
  wusdcProcessId: process.env.SOURCE_TOKEN_PROCESS_ID || process.env.WUSDC_PROCESS_ID || '7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ',
  
  // DEX configuration
  permaswapPoolId: process.env.PERMASWAP_POOL_ID || 'V7yzKBtzmY_MacDF-czrb1RY06xfidcGVrOjnhthMWM',
  
  // Balance and trading configuration
  minBalance: parseFloat(process.env.MIN_BALANCE || '400000'),
  targetBalance: parseFloat(process.env.TARGET_BALANCE || '400000'),
  maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '20'),
  minTransferAmount: parseFloat(process.env.MIN_TRANSFER_AMOUNT || '500'),
  cronSchedule: process.env.CRON_SCHEDULE || '0 */6 * * *',
  dryRun: process.env.DRY_RUN === 'true',
  
  // Notification configuration
  notifications: {
    slack: {
      enabled: process.env.SLACK_ENABLED === 'true' || (process.env.SLACK_TOKEN && process.env.SLACK_TOKEN !== 'xoxb-your-slack-bot-token-here'),
      token: process.env.SLACK_TOKEN,
      channel: process.env.SLACK_CHANNEL
    }
  }
};

let wallet;
let permaswap;

async function loadWallet() {
  try {
    const walletData = readFileSync(config.walletPath, 'utf-8');
    wallet = JSON.parse(walletData);
    
    // Validate wallet format
    if (!validateWallet(wallet, logger)) {
      throw new Error('Invalid wallet format');
    }
    
    logger.info('Wallet loaded successfully');
    
    // Initialize Permaswap DEX
    const signer = createDataItemSigner(wallet);
    permaswap = new PermaswapDEX(config.permaswapPoolId, signer, logger, config.arioProcessId, config.wusdcProcessId);
    
  } catch (error) {
    logger.error('Failed to load wallet:', error);
    throw error;
  }
}

async function checkTargetTokenBalance() {
  try {
    const balanceResult = await dryrun({
      process: config.targetToken.processId,
      tags: [
        { name: 'Action', value: 'Balance' },
        { name: 'Target', value: config.targetWalletAddress }
      ]
    });
    
    // Balance is returned in smallest units, convert to token units
    const balanceInSmallestUnit = parseFloat(balanceResult.Messages[0]?.Data || '0');
    const divisor = Math.pow(10, config.targetToken.decimals);
    const balanceInTokens = balanceInSmallestUnit / divisor;
    logger.info(`${config.targetToken.symbol} balance for ${config.targetWalletAddress}: ${balanceInTokens} ${config.targetToken.symbol} (${balanceInSmallestUnit} smallest unit)`);
    return balanceInTokens;
  } catch (error) {
    logger.error(`Failed to check ${config.targetToken.symbol} balance:`, error);
    throw error;
  }
}

// Legacy function name for backwards compatibility
const checkArioBalance = checkTargetTokenBalance;

async function getWalletBalances() {
  try {
    const walletAddress = await arweave.wallets.jwkToAddress(wallet);
    
    // Check AR balance
    const arBalance = await arweave.wallets.getBalance(walletAddress);
    const arBalanceInAr = parseFloat(arweave.ar.winstonToAr(arBalance));
    
    // Check wUSDC balance
    const wusdcResult = await dryrun({
      process: config.wusdcProcessId,
      tags: [
        { name: 'Action', value: 'Balance' },
        { name: 'Target', value: walletAddress }
      ]
    });
    
    const wusdcBalanceRaw = parseFloat(wusdcResult.Messages[0]?.Data || '0');
    const wusdcBalance = wusdcBalanceRaw / 1_000_000; // Convert from smallest unit
    
    // Check ARIO balance
    const arioResult = await dryrun({
      process: config.arioProcessId,
      tags: [
        { name: 'Action', value: 'Balance' },
        { name: 'Target', value: walletAddress }
      ]
    });
    
    const arioBalanceRaw = parseFloat(arioResult.Messages[0]?.Data || '0');
    const arioBalance = arioBalanceRaw / 1_000_000; // Convert from mARIO to ARIO
    
    logger.info(`Wallet ${walletAddress} balances:`, {
      AR: arBalanceInAr,
      wUSDC: wusdcBalance,
      ARIO: arioBalance
    });
    
    return {
      address: walletAddress,
      arBalance: arBalanceInAr,
      wusdcBalance,
      wusdcBalanceRaw,
      arioBalance,
      arioBalanceRaw
    };
  } catch (error) {
    logger.error('Failed to get wallet balances:', error);
    throw error;
  }
}

async function calculateSwapDetails(amountNeeded, botWalletArio = 0) {
  try {
    // Calculate actual swap amount needed after considering bot wallet balance
    const actualSwapNeeded = Math.max(0, amountNeeded - botWalletArio);
    
    if (actualSwapNeeded === 0) {
      logger.info(`Bot wallet has sufficient ${config.targetToken.symbol} balance, no swap needed`);
      return {
        amountNeeded,
        actualSwapNeeded: 0,
        botWalletContribution: amountNeeded,
        usdcRequired: 0,
        usdcRequiredRaw: 0,
        expectedArio: 0,
        expectedArioRaw: 0,
        slippage: 0,
        currentPrice: 0,
        swapRequired: false
      };
    }
    
    // Get current price from Permaswap
    const priceInfo = await permaswap.getPrice();
    
    // Price is source token per target token
    const usdcPerArio = parseFloat(priceInfo.price);
    const usdcNeeded = actualSwapNeeded * usdcPerArio;
    
    // Calculate expected output using Permaswap's GetAmountOut
    const swapResult = await permaswap.calculateSwapOutput(
      config.wusdcProcessId,  // TokenIn: wUSDC
      Math.ceil(usdcNeeded * 1_000_000) // AmountIn: convert to smallest unit (6 decimals)
    );
    
    const expectedArio = parseFloat(swapResult.amountOut) / 1_000_000;
    const slippage = ((actualSwapNeeded - expectedArio) / actualSwapNeeded) * 100;
    
    return {
      amountNeeded,
      actualSwapNeeded,
      botWalletContribution: botWalletArio,
      usdcRequired: usdcNeeded,
      usdcRequiredRaw: Math.ceil(usdcNeeded * 1_000_000),
      expectedArio,
      expectedArioRaw: swapResult.amountOut,
      slippage,
      currentPrice: usdcPerArio,
      priceInfo,
      swapRequired: true
    };
  } catch (error) {
    logger.error('Failed to calculate swap details:', error);
    throw error;
  }
}

async function swapOnPermaswap(amountToSwap, swapDetails) {
  try {
    logger.info(`Initiating swap for ${amountToSwap} ${config.targetToken.symbol} tokens on Permaswap`);
    
    if (config.dryRun) {
      logger.info('[DRY RUN] Swap details:', {
        arioNeeded: swapDetails.actualSwapNeeded || swapDetails.amountNeeded,
        usdcRequired: swapDetails.usdcRequired.toFixed(2),
        expectedArio: swapDetails.expectedArio.toFixed(2),
        slippage: swapDetails.slippage.toFixed(2) + '%',
        currentPrice: `1 ${config.targetToken.symbol} = ${swapDetails.currentPrice.toFixed(6)} ${config.sourceToken.symbol}`
      });
    }
    
    // Execute the swap (dry run or real)
    const result = await permaswap.executeSwap(
      config.wusdcProcessId,  // tokenIn: wUSDC
      swapDetails.usdcRequiredRaw,  // amountIn in smallest unit
      config.arioProcessId,  // tokenOut: ARIO
      config.dryRun
    );
    
    if (config.dryRun) {
      const expectedArioReceived = parseFloat(result.expectedOut) / 1_000_000;
      logger.info(`[DRY RUN] Would receive approximately ${expectedArioReceived.toFixed(2)} ARIO`);
    }
    
    return result;
    
  } catch (error) {
    logger.error('Failed to swap on Permaswap:', error);
    throw error;
  }
}

async function transferToTargetWallet(amountArio, isRecovery = false) {
  try {
    if (config.dryRun) {
      logger.info(`[DRY RUN] Would transfer ${amountArio.toFixed(2)} ${config.targetToken.symbol} to target wallet: ${config.targetWalletAddress}${isRecovery ? ' (recovery from previous run)' : ''}`);
      return {
        success: true,
        dryRun: true,
        amount: amountArio,
        isRecovery
      };
    }
    
    // Safety check: verify we have sufficient balance before attempting transfer
    const currentBalances = await getWalletBalances();
    if (currentBalances.arioBalance < amountArio) {
      logger.error(`❌ Insufficient ${config.targetToken.symbol} balance for transfer`);
      logger.error(`├─ Available: ${currentBalances.arioBalance.toFixed(2)} ${config.targetToken.symbol}`);
      logger.error(`└─ Requested: ${amountArio.toFixed(2)} ${config.targetToken.symbol}`);
      throw new Error(`Insufficient ${config.targetToken.symbol} balance. Available: ${currentBalances.arioBalance.toFixed(2)}, Requested: ${amountArio.toFixed(2)}`);
    }
    
    logger.info(`Transferring ${amountArio.toFixed(2)} ${config.targetToken.symbol} to target wallet: ${config.targetWalletAddress}${isRecovery ? ' (recovery from previous run)' : ''}`);
    
    const transferMessage = await message({
      process: config.arioProcessId,
      signer: createDataItemSigner(wallet),
      tags: [
        { name: 'Action', value: 'Transfer' },
        { name: 'Recipient', value: config.targetWalletAddress },
        { name: 'Quantity', value: Math.floor(amountArio * 1_000_000).toString() } // Convert to mARIO
      ]
    });
    
    const transferResult = await result({
      message: transferMessage,
      process: config.arioProcessId
    });
    
    logger.info('Transfer completed:', transferResult);
    return {
      ...transferResult,
      messageId: transferMessage,
      isRecovery
    };
  } catch (error) {
    logger.error('Failed to transfer to target wallet:', error);
    throw error;
  }
}

async function performTopUp() {
  try {
    logger.info('================== ARIO TOP-UP BOT STARTING ==================');
    logger.info(`Configuration:`, {
      minBalance: `${config.minBalance.toLocaleString()} ARIO`,
      targetBalance: `${config.targetBalance.toLocaleString()} ARIO`,
      targetWallet: config.targetWalletAddress,
      dryRun: config.dryRun
    });
    
    if (config.dryRun) {
      logger.info('🔍 [DRY RUN MODE] - No actual transactions will be executed');
    }
    
    // Check current target token balance
    logger.info(`📊 Checking ${config.targetToken.symbol} balance...`);
    const currentBalance = await checkArioBalance();
    
    if (currentBalance < config.minBalance) {
      const amountNeeded = config.targetBalance - currentBalance;
      logger.info('⚠️  Balance below minimum threshold');
      logger.info(`Current balance: ${currentBalance.toLocaleString()} ${config.targetToken.symbol}`);
      logger.info(`Target balance: ${config.targetBalance.toLocaleString()} ${config.targetToken.symbol}`);
      logger.info(`Need to acquire: ${amountNeeded.toLocaleString()} ${config.targetToken.symbol}`);
      
      // Check if amount needed is below minimum transfer threshold
      if (amountNeeded < config.minTransferAmount) {
        logger.info(`⚠️  Amount needed (${amountNeeded.toFixed(2)} ${config.targetToken.symbol}) is below minimum transfer threshold (${config.minTransferAmount} ${config.targetToken.symbol})`);
        logger.info('Skipping top-up - will check again at next scheduled interval');
        logger.info('================== TOP-UP SKIPPED - AMOUNT TOO SMALL ==================');
        return;
      }
      
      // Get wallet balances
      logger.info('💰 Checking wallet balances...');
      const walletBalances = await getWalletBalances();
      
      // Check if bot wallet has any target token balance from previous runs
      if (walletBalances.arioBalance > 0) {
        logger.info(`📦 Bot wallet has ${walletBalances.arioBalance.toLocaleString()} ${config.targetToken.symbol} from previous run`);
      }
      
      // Calculate and show swap details
      logger.info('🧮 Calculating swap details...');
      const swapDetails = await calculateSwapDetails(amountNeeded, walletBalances.arioBalance);
      
      logger.info('💱 SWAP CALCULATION SUMMARY:');
      logger.info(`├─ Total ${config.targetToken.symbol} needed: ${swapDetails.amountNeeded.toLocaleString()} ${config.targetToken.symbol}`);
      if (walletBalances.arioBalance > 0) {
        logger.info(`├─ Bot wallet can provide: ${walletBalances.arioBalance.toLocaleString()} ${config.targetToken.symbol}`);
        logger.info(`├─ Need to swap for: ${swapDetails.actualSwapNeeded.toLocaleString()} ${config.targetToken.symbol}`);
      }
      if (swapDetails.swapRequired) {
        logger.info(`├─ Current price: 1 ${config.targetToken.symbol} = ${swapDetails.currentPrice.toFixed(6)} ${config.sourceToken.symbol}`);
        logger.info(`├─ ${config.sourceToken.symbol} required: ${swapDetails.usdcRequired.toFixed(2)} ${config.sourceToken.symbol} (${swapDetails.usdcRequiredRaw.toLocaleString()} smallest unit)`);
        logger.info(`├─ Expected ${config.targetToken.symbol} output: ${swapDetails.expectedArio.toFixed(2)} ${config.targetToken.symbol}`);
        logger.info(`└─ Expected slippage: ${swapDetails.slippage.toFixed(3)}%`);
        
        // Check if slippage exceeds maximum allowed
        if (swapDetails.slippage > config.maxSlippage) {
          logger.error(`❌ SLIPPAGE TOO HIGH - ABORTING SWAP`);
          logger.error(`├─ Current slippage: ${swapDetails.slippage.toFixed(3)}%`);
          logger.error(`├─ Maximum allowed: ${config.maxSlippage}%`);
          logger.error(`└─ Price impact too severe, waiting for better market conditions`);
          
          // Send notification about high slippage
          await sendMessageToSlack(
            `⚠️ *ARIO Top-up Aborted - High Slippage*\n\n` +
            `*Target Wallet:* \`${config.targetWalletAddress}\`\n` +
            `*Current Balance:* ${currentBalance.toLocaleString()} ${config.targetToken.symbol}\n` +
            `*Needs:* ${amountNeeded.toLocaleString()} ${config.targetToken.symbol}\n\n` +
            `*Slippage Protection:*\n` +
            `• Expected slippage: ${swapDetails.slippage.toFixed(3)}%\n` +
            `• Maximum allowed: ${config.maxSlippage}%\n` +
            `• Status: Swap aborted to prevent excessive loss\n\n` +
            `The bot will retry at the next scheduled interval.`
          );
          
          logger.info('================== TOP-UP ABORTED DUE TO HIGH SLIPPAGE ==================');
          return;
        }
      } else {
        logger.info(`└─ No swap required - bot wallet has sufficient ${config.targetToken.symbol}`);
      }
      
      // Step 1: Transfer any existing target token from bot wallet first
      let recoveryTransferResult = null;
      if (walletBalances.arioBalance > 0) {
        const transferAmount = Math.min(walletBalances.arioBalance, amountNeeded);
        logger.info(`🔄 Transferring existing ${transferAmount.toLocaleString()} ${config.targetToken.symbol} from bot wallet...`);
        
        try {
          recoveryTransferResult = await transferToTargetWallet(transferAmount, true);
          logger.info(`✅ Successfully transferred ${transferAmount.toLocaleString()} ${config.targetToken.symbol} from previous run`);
        } catch (error) {
          logger.error(`❌ Failed to transfer existing ${config.targetToken.symbol} from bot wallet:`, error);
          logger.error(`Bot will continue with swap process to acquire additional ${config.targetToken.symbol}`);
        }
      }
      
      // Step 2: Check if we still need to swap
      if (swapDetails.swapRequired) {
        // Check if we have enough source token
        if (walletBalances.wusdcBalance < swapDetails.usdcRequired) {
          const shortfall = swapDetails.usdcRequired - walletBalances.wusdcBalance;
          logger.error('❌ INSUFFICIENT FUNDS');
          logger.error(`├─ Have: ${walletBalances.wusdcBalance.toFixed(2)} ${config.sourceToken.symbol}`);
          logger.error(`├─ Need: ${swapDetails.usdcRequired.toFixed(2)} ${config.sourceToken.symbol}`);
          logger.error(`└─ Shortfall: ${shortfall.toFixed(2)} ${config.sourceToken.symbol}`);
          
          if (config.dryRun) {
            logger.info(`[DRY RUN] Would need to acquire more ${config.sourceToken.symbol} before swapping`);
          }
          return;
        }
        
        logger.info(`✅ Sufficient ${config.sourceToken.symbol} balance confirmed`);
        logger.info(`├─ Available: ${walletBalances.wusdcBalance.toFixed(2)} ${config.sourceToken.symbol}`);
        logger.info(`├─ Required: ${swapDetails.usdcRequired.toFixed(2)} ${config.sourceToken.symbol}`);
        logger.info(`└─ Remaining after swap: ${(walletBalances.wusdcBalance - swapDetails.usdcRequired).toFixed(2)} ${config.sourceToken.symbol}`);
        
        // Execute swap
        logger.info('🔄 Executing swap on Permaswap...');
        const swapResult = await swapOnPermaswap(swapDetails.actualSwapNeeded, swapDetails);
        
        if (!config.dryRun) {
          // Wait for swap to fully settle
          logger.info('⏳ Waiting for swap to fully settle (60 seconds)...');
          await new Promise(resolve => setTimeout(resolve, 60000));
          
          // Check bot wallet balance after swap to get actual amount received
          const postSwapBalances = await getWalletBalances();
          const arioReceivedFromSwap = postSwapBalances.arioBalance;
          
          logger.info(`📊 Bot wallet ${config.targetToken.symbol} balance after swap: ${postSwapBalances.arioBalance.toFixed(2)} ${config.targetToken.symbol}`);
          logger.info(`📈 Expected from swap: ${swapDetails.expectedArio.toFixed(2)} ${config.targetToken.symbol}`);
          
          // Safety check: only transfer what we actually have
          const amountToTransfer = Math.min(
            arioReceivedFromSwap,
            swapDetails.actualSwapNeeded  // Don't transfer more than what was needed
          );
          
          if (amountToTransfer <= 0) {
            logger.error(`❌ No ${config.targetToken.symbol} available to transfer after swap`);
            throw new Error('Swap failed - no ARIO available to transfer');
          }
          
          logger.info(`✅ Transferring ${amountToTransfer.toFixed(2)} ${config.targetToken.symbol} to target wallet (available: ${arioReceivedFromSwap.toFixed(2)} ${config.targetToken.symbol}`);
          
          // Transfer swapped tokens to target wallet
          logger.info(`💸 Transferring newly swapped ${config.targetToken.symbol} to target wallet...`);
          const transferResult = await transferToTargetWallet(amountToTransfer);
          
          // Wait for blockchain state to update
          logger.info('⏳ Waiting for blockchain state to update (30 seconds)...');
          await new Promise(resolve => setTimeout(resolve, 30000));
          
          // Check new balance of target wallet
          logger.info(`📊 Checking new target wallet ${config.targetToken.symbol} balance...`);
          const newBalance = await checkArioBalance();
          logger.info(`New target wallet balance: ${newBalance.toLocaleString()} ARIO`);
          
          // Get updated balances
          const updatedWalletBalances = await getWalletBalances();
          
          // Send Slack notification for successful swap
          await sendSwapNotification({
            ...swapDetails,
            targetBalance: config.targetBalance,
            targetWallet: config.targetWalletAddress,
            targetTokenSymbol: config.targetToken.symbol,
            sourceTokenSymbol: config.sourceToken.symbol,
            previousArioBalance: currentBalance,
            previousWusdcBalance: walletBalances.wusdcBalance,
            newBalance,
            wusdcBalanceAfter: updatedWalletBalances.wusdcBalance,
            botWalletArioUsed: walletBalances.arioBalance,
            transactionIds: {
              recoveryTransferId: recoveryTransferResult?.messageId || null,
              orderMessageId: swapResult.orderMessageId,
              noteId: swapResult.noteId,
              transferToSettleId: swapResult.transferMessageId,
              transferToTargetId: transferResult.messageId
            }
          });
        } else {
          // Show what would happen in dry run
          logger.info(`[DRY RUN] Would transfer ${swapDetails.expectedArio.toFixed(2)} ${config.targetToken.symbol} to target wallet`);
          
          // Send Slack notification for dry run
          await sendSwapNotification({
            ...swapDetails,
            targetBalance: config.targetBalance,
            targetWallet: config.targetWalletAddress,
            targetTokenSymbol: config.targetToken.symbol,
            sourceTokenSymbol: config.sourceToken.symbol,
            previousArioBalance: currentBalance,
            previousWusdcBalance: walletBalances.wusdcBalance,
            wusdcBalanceAfter: walletBalances.wusdcBalance - swapDetails.usdcRequired,
            botWalletArioUsed: walletBalances.arioBalance
          }, true);
        }
      } else {
        // No swap needed, just used existing ARIO
        if (config.dryRun) {
          logger.info(`[DRY RUN] Would complete top-up using only existing ${config.targetToken.symbol} from bot wallet`);
          
          // Send dry run notification for recovery-only transfer
          await sendSwapNotification({
            ...swapDetails,
            targetBalance: config.targetBalance,
            targetWallet: config.targetWalletAddress,
            targetTokenSymbol: config.targetToken.symbol,
            sourceTokenSymbol: config.sourceToken.symbol,
            previousArioBalance: currentBalance,
            previousWusdcBalance: walletBalances.wusdcBalance,
            wusdcBalanceAfter: walletBalances.wusdcBalance,
            botWalletArioUsed: walletBalances.arioBalance
          }, true);
        } else {
          logger.info(`✅ Top-up completed using only existing ${config.targetToken.symbol} from bot wallet`);
          
          // Wait for blockchain state to update
          logger.info('⏳ Waiting for blockchain state to update (30 seconds)...');
          await new Promise(resolve => setTimeout(resolve, 30000));
          
          // Check new balance
          const newBalance = await checkArioBalance();
          logger.info(`New target wallet balance: ${newBalance.toLocaleString()} ARIO`);
          
          // Send notification for recovery-only transfer
          await sendSwapNotification({
            ...swapDetails,
            targetBalance: config.targetBalance,
            targetWallet: config.targetWalletAddress,
            targetTokenSymbol: config.targetToken.symbol,
            sourceTokenSymbol: config.sourceToken.symbol,
            previousArioBalance: currentBalance,
            previousWusdcBalance: walletBalances.wusdcBalance,
            newBalance,
            wusdcBalanceAfter: walletBalances.wusdcBalance,
            botWalletArioUsed: walletBalances.arioBalance,
            transactionIds: {
              recoveryTransferId: recoveryTransferResult?.messageId || null
            }
          });
        }
      }
      
      logger.info('✅ Top-up completed successfully');
    } else {
      logger.info(`✅ Balance sufficient: ${currentBalance.toLocaleString()} ${config.targetToken.symbol}`);
    }
    
    logger.info('================== TOP-UP CHECK COMPLETE ==================');
  } catch (error) {
    logger.error('❌ Top-up failed:', error);
  }
}

async function main() {
  try {
    // Validate configuration first
    if (!validateConfig(config, logger)) {
      logger.error('Please fix the configuration errors and try again');
      process.exit(1);
    }
    
    await loadWallet();
    
    // Run once on startup
    await performTopUp();
    
    // Schedule regular checks
    cron.schedule(config.cronSchedule, async () => {
      logger.info('Running scheduled top-up check');
      await performTopUp();
    });
    
    logger.info(`Bot started. Will check balance on schedule: ${config.cronSchedule}`);
    logger.info(`Dry run mode: ${config.dryRun}`);
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Bot shutting down...');
  process.exit(0);
});

main();