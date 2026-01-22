import { connect, message, result, createDataItemSigner } from '@permaweb/aoconnect';
import Arweave from 'arweave';
import { ethers } from 'ethers';
import cron from 'node-cron';
import winston from 'winston';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { BaseBridge } from './src/baseBridge.js';
import { KyberSwapDEX } from './src/kyberswap.js';
import { sendSwapNotification, sendMessageToSlack } from './src/slack.js';
import { validateConfig, validateWallet } from './src/validator.js';
import { CSVTransactionLogger } from './src/csvLogger.js';
import { verifyBridgeCredit, waitForBridgeCredit } from './src/bridgeVerifier.js';

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

// Initialize Arweave for wallet operations
const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

// Configure AO connection for ARIO token (using ardrive CU for better compatibility)
const aoArdrive = connect({
  CU_URL: 'https://cu.ardrive.io',
  MU_URL: 'https://mu.ao-testnet.xyz',
  GATEWAY_URL: 'https://arweave.net:443'
});

const { dryrun: dryrunArdrive } = aoArdrive;

// Configuration
const config = {
  // Arweave wallet for AO operations
  walletPath: process.env.WALLET_PATH || './wallet.json',
  targetWalletAddress: process.env.TARGET_WALLET_ADDRESS,

  // ARIO token on AO
  targetToken: {
    processId: process.env.TARGET_TOKEN_PROCESS_ID || 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
    symbol: process.env.TARGET_TOKEN_SYMBOL || 'ARIO',
    decimals: parseInt(process.env.TARGET_TOKEN_DECIMALS || '6')
  },

  // Base chain configuration
  base: {
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    privateKey: process.env.BASE_PRIVATE_KEY,
    arioContract: process.env.ARIO_BASE_CONTRACT || '0x138746adfA52909E5920def027f5a8dc1C7EfFb6',
    usdcContract: process.env.USDC_BASE_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    minEthBalance: parseFloat(process.env.MIN_ETH_BALANCE || '0.001'),
  },

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

// Global instances
let arweaveWallet;
let baseBridge;
let kyberSwap;
let csvLogger;

/**
 * Load and initialize all wallets and services
 */
async function initialize() {
  try {
    // Load Arweave wallet for AO operations
    const walletData = readFileSync(config.walletPath, 'utf-8');
    arweaveWallet = JSON.parse(walletData);

    if (!validateWallet(arweaveWallet, logger)) {
      throw new Error('Invalid Arweave wallet format');
    }

    logger.info('Arweave wallet loaded successfully');

    // Initialize Base chain components (shared provider/wallet for efficiency)
    const baseProvider = new ethers.JsonRpcProvider(config.base.rpcUrl);
    const baseWallet = new ethers.Wallet(config.base.privateKey, baseProvider);

    baseBridge = new BaseBridge(config.base, logger, baseProvider, baseWallet);
    kyberSwap = new KyberSwapDEX(baseProvider, baseWallet, logger, config.base);

    logger.info(`Base wallet initialized: ${baseWallet.address}`);

    // Initialize CSV logger
    csvLogger = new CSVTransactionLogger('transactions.csv');
    logger.info('CSV transaction logger initialized');

  } catch (error) {
    logger.error('Failed to initialize:', error);
    throw error;
  }
}

/**
 * Check ARIO balance on target AO wallet
 */
async function checkTargetArioBalance() {
  try {
    const balanceResult = await dryrunArdrive({
      process: config.targetToken.processId,
      tags: [
        { name: 'Action', value: 'Balance' },
        { name: 'Target', value: config.targetWalletAddress }
      ]
    });

    const balanceInSmallestUnit = parseFloat(balanceResult.Messages?.[0]?.Data || '0');
    const divisor = Math.pow(10, config.targetToken.decimals);
    const balanceInTokens = balanceInSmallestUnit / divisor;

    logger.info(`Target wallet ARIO balance: ${balanceInTokens.toLocaleString()} ARIO`);
    return balanceInTokens;
  } catch (error) {
    logger.error('Failed to check target ARIO balance:', error);
    throw error;
  }
}

/**
 * Check ARIO balance in bot's AO wallet
 */
async function checkBotAoArioBalance() {
  try {
    const walletAddress = await arweave.wallets.jwkToAddress(arweaveWallet);

    const balanceResult = await dryrunArdrive({
      process: config.targetToken.processId,
      tags: [
        { name: 'Action', value: 'Balance' },
        { name: 'Target', value: walletAddress }
      ]
    });

    const balanceInSmallestUnit = parseFloat(balanceResult.Messages?.[0]?.Data || '0');
    const divisor = Math.pow(10, config.targetToken.decimals);
    const balanceInTokens = balanceInSmallestUnit / divisor;

    logger.info(`Bot AO wallet ARIO balance: ${balanceInTokens.toLocaleString()} ARIO`);
    return {
      address: walletAddress,
      balance: balanceInTokens,
      balanceRaw: balanceInSmallestUnit
    };
  } catch (error) {
    logger.error('Failed to check bot AO ARIO balance:', error);
    throw error;
  }
}

/**
 * Transfer ARIO from bot's AO wallet to target wallet
 */
async function transferArioOnAO(amount, isRecovery = false) {
  try {
    const walletAddress = await arweave.wallets.jwkToAddress(arweaveWallet);

    if (config.dryRun) {
      logger.info(`[DRY RUN] Would transfer ${amount.toFixed(2)} ARIO to ${config.targetWalletAddress}`);
      return { success: true, dryRun: true, amount };
    }

    // Verify balance before transfer
    const botBalance = await checkBotAoArioBalance();
    if (botBalance.balance < amount) {
      throw new Error(`Insufficient ARIO balance. Have: ${botBalance.balance.toFixed(2)}, Need: ${amount.toFixed(2)}`);
    }

    logger.info(`Transferring ${amount.toFixed(2)} ARIO to target wallet...`);

    const transferMessage = await message({
      process: config.targetToken.processId,
      signer: createDataItemSigner(arweaveWallet),
      tags: [
        { name: 'Action', value: 'Transfer' },
        { name: 'Recipient', value: config.targetWalletAddress },
        { name: 'Quantity', value: Math.floor(amount * Math.pow(10, config.targetToken.decimals)).toString() }
      ]
    });

    const transferResult = await result({
      message: transferMessage,
      process: config.targetToken.processId
    });

    logger.info(`Transfer completed: ${transferMessage}`);

    // Log to CSV
    if (csvLogger) {
      if (isRecovery) {
        await csvLogger.logRecovery({
          token: 'ARIO',
          amount,
          fromWallet: walletAddress,
          toWallet: config.targetWalletAddress,
          txId: transferMessage
        });
      } else {
        await csvLogger.logTransfer({
          token: 'ARIO',
          amount,
          fromWallet: walletAddress,
          toWallet: config.targetWalletAddress,
          txId: transferMessage,
          notes: 'Post-bridge transfer to target wallet'
        });
      }
    }

    return {
      success: true,
      messageId: transferMessage,
      amount,
      isRecovery
    };
  } catch (error) {
    logger.error('Failed to transfer ARIO on AO:', error);
    throw error;
  }
}

/**
 * Main top-up flow
 */
async function performTopUp() {
  try {
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('                    ARIO TOP-UP BOT - CROSS-CHAIN              ');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`Configuration:`, {
      minBalance: `${config.minBalance.toLocaleString()} ARIO`,
      targetBalance: `${config.targetBalance.toLocaleString()} ARIO`,
      targetWallet: config.targetWalletAddress,
      dryRun: config.dryRun
    });

    if (config.dryRun) {
      logger.info('🔍 [DRY RUN MODE] - No actual transactions will be executed');
    }

    // Step 1: Check target wallet ARIO balance on AO
    logger.info('📊 Step 1: Checking target wallet ARIO balance on AO...');
    const currentBalance = await checkTargetArioBalance();

    if (currentBalance >= config.minBalance) {
      logger.info(`✅ Balance sufficient: ${currentBalance.toLocaleString()} ARIO`);
      logger.info('═══════════════════════════════════════════════════════════════');
      return;
    }

    const amountNeeded = config.targetBalance - currentBalance;
    logger.info('⚠️  Balance below minimum threshold');
    logger.info(`├─ Current: ${currentBalance.toLocaleString()} ARIO`);
    logger.info(`├─ Target: ${config.targetBalance.toLocaleString()} ARIO`);
    logger.info(`└─ Need: ${amountNeeded.toLocaleString()} ARIO`);

    // Check minimum transfer threshold
    if (amountNeeded < config.minTransferAmount) {
      logger.info(`⚠️  Amount needed (${amountNeeded.toFixed(2)} ARIO) below minimum (${config.minTransferAmount} ARIO)`);
      logger.info('Skipping - will check again at next interval');
      return;
    }

    // Step 2: Check bot's AO wallet for existing ARIO (recovery)
    logger.info('📊 Step 2: Checking bot AO wallet for existing ARIO...');
    const botAoBalance = await checkBotAoArioBalance();

    let remainingNeeded = amountNeeded;
    let recoveryTransferResult = null;

    if (botAoBalance.balance > 0) {
      const transferAmount = Math.min(botAoBalance.balance, amountNeeded);
      logger.info(`📦 Found ${botAoBalance.balance.toFixed(2)} ARIO in bot AO wallet`);
      logger.info(`🔄 Transferring ${transferAmount.toFixed(2)} ARIO to target (recovery)...`);

      try {
        recoveryTransferResult = await transferArioOnAO(transferAmount, true);
        remainingNeeded -= transferAmount;
        logger.info(`✅ Recovery transfer complete. Still need: ${remainingNeeded.toFixed(2)} ARIO`);
      } catch (error) {
        logger.error('Recovery transfer failed, continuing with swap:', error);
      }
    }

    if (remainingNeeded <= 0) {
      logger.info('✅ Top-up complete using existing ARIO');
      logger.info('═══════════════════════════════════════════════════════════════');
      return;
    }

    // Step 3: Check Base wallet balances
    logger.info('📊 Step 3: Checking Base chain wallet balances...');
    const baseBalances = await baseBridge.getAllBalances();

    logger.info(`Base wallet: ${baseBalances.address}`);
    logger.info(`├─ ETH: ${baseBalances.eth.balanceFormatted.toFixed(6)} ETH`);
    logger.info(`├─ USDC: ${baseBalances.usdc.balanceFormatted.toFixed(2)} USDC`);
    logger.info(`└─ ARIO: ${baseBalances.ario.balanceFormatted.toFixed(2)} ARIO`);

    // Check ETH for gas
    if (baseBalances.eth.balanceFormatted < config.base.minEthBalance) {
      logger.warn(`⚠️  LOW ETH BALANCE - Gas may be insufficient`);
      logger.warn(`├─ Current: ${baseBalances.eth.balanceFormatted.toFixed(6)} ETH`);
      logger.warn(`└─ Minimum: ${config.base.minEthBalance} ETH`);

      await sendMessageToSlack(
        `⚠️ *Low ETH Balance Warning*\n\n` +
        `Base wallet ETH balance is low:\n` +
        `• Current: ${baseBalances.eth.balanceFormatted.toFixed(6)} ETH\n` +
        `• Minimum: ${config.base.minEthBalance} ETH\n\n` +
        `Please fund the Base wallet with ETH for gas.\n` +
        `*Base Wallet:* \`${baseBridge.getWalletAddress()}\``
      );
    }

    // Step 3.5: Check for existing ARIO on Base (recovery from failed burn)
    if (baseBalances.ario.balanceFormatted > 0) {
      logger.info(`📦 Found ${baseBalances.ario.balanceFormatted.toFixed(2)} ARIO on Base (from previous swap/failed burn)`);
      // Burn directly to target wallet (Turbo wallet)
      const aoDestinationForRecovery = config.targetWalletAddress;

      if (config.dryRun) {
        logger.info(`[DRY RUN] Would burn ${baseBalances.ario.balanceFormatted.toFixed(2)} ARIO to Turbo wallet: ${aoDestinationForRecovery}`);
      } else {
        try {
          logger.info(`🔥 Burning existing ARIO on Base to recover...`);
          const recoveryBurnResult = await baseBridge.burnToAO(
            baseBalances.ario.balanceFormatted,
            aoDestinationForRecovery,
            false
          );

          if (csvLogger) {
            await csvLogger.logBaseBurn({
              token: 'ARIO',
              amount: baseBalances.ario.balanceFormatted,
              baseWallet: baseBridge.getWalletAddress(),
              aoDestination: aoDestinationForRecovery,
              txHash: recoveryBurnResult.txHash,
              gasUsed: recoveryBurnResult.gasUsed,
              notes: 'Recovery burn from previous failed burn'
            });
          }

          logger.info(`✅ Recovery burn complete: ${recoveryBurnResult.txHash}`);

          // Verify bridge credit arrived on AO
          logger.info('⏳ Waiting for bridge Credit-Notice on AO...');
          const verifyResult = await waitForBridgeCredit(
            config.targetWalletAddress,
            baseBalances.ario.balanceFormatted,
            {
              maxWaitMs: 30 * 60 * 1000, // Wait up to 30 minutes
              pollIntervalMs: 60 * 1000, // Poll every 1 minute
              onPoll: ({ attempt, elapsedMs }) => {
                logger.info(`├─ Checking for Credit-Notice (attempt ${attempt}, ${Math.round(elapsedMs/1000)}s elapsed)...`);
              }
            }
          );

          if (verifyResult.success) {
            logger.info(`✅ Bridge verified! Credit-Notice received on AO`);
            logger.info(`├─ TX: ${verifyResult.transaction.id}`);
            logger.info(`├─ Amount: ${verifyResult.transaction.quantityArio.toFixed(2)} ARIO`);
            logger.info(`└─ Wait time: ${Math.round(verifyResult.waitTimeMs/1000)}s`);
          } else {
            logger.warn(`⚠️ Could not verify bridge Credit-Notice within timeout`);
            logger.warn(`└─ The bridge may still be processing. Check manually.`);
          }

          // Update remaining needed (ARIO will arrive on AO via bridge)
          remainingNeeded = Math.max(0, remainingNeeded - baseBalances.ario.balanceFormatted);
          logger.info(`└─ Updated remaining needed: ${remainingNeeded.toFixed(2)} ARIO`);

          if (remainingNeeded <= 0) {
            logger.info('✅ Recovery burn fulfilled the needed amount');

            if (verifyResult.success) {
              // Success - bridge verified
              await sendMessageToSlack(
                `✅ *ARIO Recovery Burn Complete*\n\n` +
                `Found and burned ${baseBalances.ario.balanceFormatted.toFixed(2)} ARIO from Base wallet.\n\n` +
                `*Burn TX:* \`${recoveryBurnResult.txHash}\`\n` +
                `*Destination:* Turbo wallet\n` +
                `*Bridge Credit:* \`${verifyResult.transaction.id}\`\n` +
                `*Amount Received:* ${verifyResult.transaction.quantityArio.toFixed(2)} ARIO ✅`
              );
            } else {
              // Alert - bridge not verified within timeout
              await sendMessageToSlack(
                `⚠️ *ALERT: ARIO Burn Succeeded But Bridge Unverified*\n\n` +
                `The burn transaction completed on Base, but we could not verify the Credit-Notice on AO within 30 minutes.\n\n` +
                `*Burn TX:* \`${recoveryBurnResult.txHash}\`\n` +
                `*Amount Burned:* ${baseBalances.ario.balanceFormatted.toFixed(2)} ARIO\n` +
                `*Destination:* \`${config.targetWalletAddress}\`\n\n` +
                `⚠️ Please verify manually that the ARIO arrived on AO.`
              );
            }
            logger.info('═══════════════════════════════════════════════════════════════');
            return;
          }
        } catch (recoveryBurnError) {
          logger.error('Failed to burn existing ARIO on Base:', recoveryBurnError);
          // Continue with swap - the ARIO will be picked up next cycle
        }
      }
    }

    // Step 4: Calculate USDC needed for swap
    logger.info('📊 Step 4: Calculating swap details...');
    const swapCalc = await kyberSwap.calculateUsdcNeeded(remainingNeeded);

    logger.info(`💱 Swap calculation:`);
    logger.info(`├─ ARIO needed: ${remainingNeeded.toFixed(2)} ARIO`);
    logger.info(`├─ USDC required: ${swapCalc.usdcNeeded.toFixed(2)} USDC`);
    logger.info(`├─ Price: 1 ARIO = ${swapCalc.effectivePrice.toFixed(6)} USDC`);
    logger.info(`└─ Price impact: ${swapCalc.priceImpact.toFixed(3)}%`);

    // Check slippage
    if (swapCalc.priceImpact > config.maxSlippage) {
      logger.error(`❌ PRICE IMPACT TOO HIGH - ABORTING`);
      logger.error(`├─ Current: ${swapCalc.priceImpact.toFixed(3)}%`);
      logger.error(`└─ Maximum: ${config.maxSlippage}%`);

      await sendMessageToSlack(
        `⚠️ *ARIO Top-up Aborted - High Price Impact*\n\n` +
        `*Target Wallet:* \`${config.targetWalletAddress}\`\n` +
        `*Current Balance:* ${currentBalance.toLocaleString()} ARIO\n` +
        `*Needs:* ${amountNeeded.toLocaleString()} ARIO\n\n` +
        `*Price Impact Protection:*\n` +
        `• Current impact: ${swapCalc.priceImpact.toFixed(3)}%\n` +
        `• Maximum allowed: ${config.maxSlippage}%\n\n` +
        `The bot will retry at the next scheduled interval.`
      );
      return;
    }

    // Check USDC balance
    if (baseBalances.usdc.balanceFormatted < swapCalc.usdcNeeded) {
      logger.error(`❌ INSUFFICIENT USDC`);
      logger.error(`├─ Have: ${baseBalances.usdc.balanceFormatted.toFixed(2)} USDC`);
      logger.error(`├─ Need: ${swapCalc.usdcNeeded.toFixed(2)} USDC`);
      logger.error(`└─ Shortfall: ${(swapCalc.usdcNeeded - baseBalances.usdc.balanceFormatted).toFixed(2)} USDC`);

      await sendMessageToSlack(
        `⚠️ *Insufficient USDC Balance*\n\n` +
        `*Target Wallet:* \`${config.targetWalletAddress}\`\n` +
        `*Current Balance:* ${currentBalance.toLocaleString()} ARIO\n` +
        `*Needs:* ${amountNeeded.toLocaleString()} ARIO\n\n` +
        `*USDC Shortage:*\n` +
        `• Have: ${baseBalances.usdc.balanceFormatted.toFixed(2)} USDC\n` +
        `• Need: ${swapCalc.usdcNeeded.toFixed(2)} USDC\n` +
        `• Shortfall: ${(swapCalc.usdcNeeded - baseBalances.usdc.balanceFormatted).toFixed(2)} USDC\n\n` +
        `Please fund the Base wallet with USDC.\n` +
        `*Base Wallet:* \`${baseBridge.getWalletAddress()}\``
      );
      return;
    }

    // Step 5: Execute swap on Base (USDC → ARIO)
    logger.info('📊 Step 5: Executing swap on Base chain...');
    const swapResult = await kyberSwap.executeSwap(
      swapCalc.usdcNeeded,
      config.maxSlippage,
      config.dryRun
    );

    if (!swapResult.success) {
      logger.error('❌ Swap failed or aborted:', swapResult.reason);
      return;
    }

    // Log swap to CSV
    if (!config.dryRun && csvLogger) {
      await csvLogger.logBaseSwap({
        fromToken: 'USDC',
        fromAmount: swapCalc.usdcNeeded,
        toToken: 'ARIO',
        toAmount: swapResult.expectedAmountOut,
        exchangeRate: swapCalc.effectivePrice,
        priceImpact: swapResult.priceImpact,
        baseWallet: baseBridge.getWalletAddress(),
        txHash: swapResult.txHash,
        gasUsed: swapResult.gasUsed,
      });
    }

    if (config.dryRun) {
      logger.info(`[DRY RUN] Would receive ~${swapResult.expectedAmountOut.toFixed(2)} ARIO from swap`);
    }

    // Step 6: Burn ARIO on Base to bridge to AO
    logger.info('📊 Step 6: Burning ARIO on Base to bridge to AO...');

    // Wait a few seconds for RPC node to fully update nonce state after swap
    // This prevents "replacement transaction underpriced" errors
    logger.info('⏳ Waiting 5 seconds for network state to settle...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get updated ARIO balance on Base after swap
    let postSwapArioBalance;
    try {
      postSwapArioBalance = config.dryRun
        ? swapResult.expectedAmountOut
        : (await baseBridge.getArioBalance()).balanceFormatted;
    } catch (balanceError) {
      logger.error('Failed to get ARIO balance after swap:', balanceError);
      logger.error('⚠️ SWAP SUCCEEDED but balance check failed. ARIO may be on Base wallet.');
      logger.error(`Check Base wallet: ${baseBridge.getWalletAddress()}`);
      await sendMessageToSlack(
        `⚠️ *Swap Succeeded But Balance Check Failed*\n\n` +
        `The USDC→ARIO swap completed but we couldn't verify the balance.\n\n` +
        `*Swap TX:* \`${swapResult.txHash}\`\n` +
        `*Base Wallet:* \`${baseBridge.getWalletAddress()}\`\n\n` +
        `Please check the Base wallet manually and retry the burn.`
      );
      return;
    }

    const burnAmount = Math.min(postSwapArioBalance, remainingNeeded);
    // Burn directly to target wallet (Turbo wallet)
    const aoDestination = config.targetWalletAddress;

    logger.info(`🔥 Burning ${burnAmount.toFixed(2)} ARIO on Base`);
    logger.info(`└─ Destination (Turbo wallet): ${aoDestination}`);

    let burnResult;
    try {
      burnResult = await baseBridge.burnToAO(burnAmount, aoDestination, config.dryRun);
    } catch (burnError) {
      logger.error('Failed to burn ARIO on Base:', burnError);
      logger.error('⚠️ SWAP SUCCEEDED but BURN FAILED. ARIO is on Base wallet.');
      logger.error(`Base wallet: ${baseBridge.getWalletAddress()}`);
      logger.error(`ARIO on Base: ~${postSwapArioBalance.toFixed(2)} ARIO`);
      await sendMessageToSlack(
        `⚠️ *CRITICAL: Swap Succeeded But Burn Failed*\n\n` +
        `The USDC→ARIO swap completed but the burn to AO failed!\n\n` +
        `*ARIO stuck on Base:* ~${postSwapArioBalance.toFixed(2)} ARIO\n` +
        `*Swap TX:* \`${swapResult.txHash}\`\n` +
        `*Base Wallet:* \`${baseBridge.getWalletAddress()}\`\n` +
        `*Error:* ${burnError.message}\n\n` +
        `The bot will attempt to burn on the next cycle (ARIO detected on Base).`
      );
      return;
    }

    // Log burn to CSV
    if (!config.dryRun && csvLogger) {
      await csvLogger.logBaseBurn({
        token: 'ARIO',
        amount: burnAmount,
        baseWallet: baseBridge.getWalletAddress(),
        aoDestination,
        txHash: burnResult.txHash,
        gasUsed: burnResult.gasUsed,
      });
    }

    if (config.dryRun) {
      logger.info(`[DRY RUN] Would burn ${burnAmount.toFixed(2)} ARIO to ${aoDestination}`);
      logger.info(`[DRY RUN] ARIO would arrive on AO after bridge processing`);

      // Send dry run notification
      await sendSwapNotification({
        amountNeeded,
        usdcAmount: swapCalc.usdcNeeded,
        expectedArio: swapResult.expectedAmountOut,
        effectivePrice: swapCalc.effectivePrice,
        priceImpact: swapResult.priceImpact,
        swapRequired: true,
        targetBalance: config.targetBalance,
        targetWallet: config.targetWalletAddress,
        previousArioBalance: currentBalance,
        usdcBalance: baseBalances.usdc.balanceFormatted,
        ethBalance: baseBalances.eth.balanceFormatted,
        baseArioBalance: baseBalances.ario.balanceFormatted,
        recoveryAmount: botAoBalance.balance,
      }, true);

      logger.info('═══════════════════════════════════════════════════════════════');
      logger.info('                    [DRY RUN] SIMULATION COMPLETE              ');
      logger.info('═══════════════════════════════════════════════════════════════');
      return;
    }

    // Step 7: Verify bridge Credit-Notice on AO
    logger.info('📊 Step 7: Verifying bridge Credit-Notice on AO...');
    logger.info('⏳ Waiting for bridge to process...');

    const bridgeVerifyResult = await waitForBridgeCredit(
      config.targetWalletAddress,
      burnAmount,
      {
        maxWaitMs: 30 * 60 * 1000, // Wait up to 30 minutes
        pollIntervalMs: 60 * 1000, // Poll every 1 minute
        onPoll: ({ attempt, elapsedMs }) => {
          logger.info(`├─ Checking for Credit-Notice (attempt ${attempt}, ${Math.round(elapsedMs/1000)}s elapsed)...`);
        }
      }
    );

    if (bridgeVerifyResult.success) {
      logger.info(`✅ Bridge verified! Credit-Notice received on AO`);
      logger.info(`├─ TX: ${bridgeVerifyResult.transaction.id}`);
      logger.info(`├─ Amount: ${bridgeVerifyResult.transaction.quantityArio.toFixed(2)} ARIO`);
      logger.info(`└─ Wait time: ${Math.round(bridgeVerifyResult.waitTimeMs/1000)}s`);
    } else {
      logger.warn(`⚠️ Could not verify bridge Credit-Notice within timeout`);
      logger.warn(`└─ The bridge may still be processing. Check manually.`);
    }

    // Get final balances for notification
    const finalBaseBalances = await baseBridge.getAllBalances();

    // Send appropriate notification based on bridge verification
    if (bridgeVerifyResult.success) {
      // Success - everything worked
      await sendMessageToSlack(
        `✅ *ARIO Top-up Complete*\n\n` +
        `*Swap:* ${swapCalc.usdcNeeded.toFixed(2)} USDC → ${swapResult.expectedAmountOut.toFixed(2)} ARIO\n` +
        `*Swap TX:* \`${swapResult.txHash}\`\n\n` +
        `*Burn:* ${burnAmount.toFixed(2)} ARIO → Turbo wallet\n` +
        `*Burn TX:* \`${burnResult.txHash}\`\n\n` +
        `*Bridge Credit:* \`${bridgeVerifyResult.transaction.id}\`\n` +
        `*Amount Received:* ${bridgeVerifyResult.transaction.quantityArio.toFixed(2)} ARIO ✅\n\n` +
        `*Target Wallet:* \`${config.targetWalletAddress}\`\n` +
        `*New Balance:* ~${(currentBalance + burnAmount).toLocaleString()} ARIO`
      );
    } else {
      // Alert - swap and burn worked but bridge not verified
      await sendMessageToSlack(
        `⚠️ *ALERT: Swap & Burn Succeeded But Bridge Unverified*\n\n` +
        `The swap and burn completed, but we could not verify the Credit-Notice on AO within 30 minutes.\n\n` +
        `*Swap:* ${swapCalc.usdcNeeded.toFixed(2)} USDC → ${swapResult.expectedAmountOut.toFixed(2)} ARIO ✅\n` +
        `*Swap TX:* \`${swapResult.txHash}\`\n\n` +
        `*Burn:* ${burnAmount.toFixed(2)} ARIO ✅\n` +
        `*Burn TX:* \`${burnResult.txHash}\`\n\n` +
        `*Bridge:* ⚠️ UNVERIFIED\n` +
        `*Destination:* \`${config.targetWalletAddress}\`\n\n` +
        `⚠️ Please verify manually that the ARIO arrived on AO.`
      );
    }

    logger.info('✅ Cross-chain top-up completed');
    logger.info('├─ Swap: Complete');
    logger.info('├─ Burn: Complete');
    logger.info(`└─ Bridge: ${bridgeVerifyResult.success ? `Verified (TX: ${bridgeVerifyResult.transaction.id})` : 'UNVERIFIED - check manually'}`);
    logger.info('═══════════════════════════════════════════════════════════════');

  } catch (error) {
    logger.error('❌ Top-up failed:', error);

    await sendMessageToSlack(
      `❌ *ARIO Top-up Failed*\n\n` +
      `*Error:* ${error.message}\n\n` +
      `Please check the logs for details.`
    );
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    logger.info('Starting ARIO Balance Maintainer (Cross-Chain Edition)');

    // Validate configuration
    if (!validateConfig(config, logger)) {
      logger.error('Configuration validation failed');
      process.exit(1);
    }

    // Initialize wallets and services
    await initialize();

    // Run once on startup
    await performTopUp();

    // Schedule regular checks
    cron.schedule(config.cronSchedule, async () => {
      logger.info('Running scheduled top-up check');
      await performTopUp();
    });

    logger.info(`Bot started. Schedule: ${config.cronSchedule}`);
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
