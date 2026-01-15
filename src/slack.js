import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';

dotenv.config();

const slackEnabled = process.env.SLACK_ENABLED === 'true' || (process.env.SLACK_TOKEN && process.env.SLACK_TOKEN !== 'xoxb-your-slack-bot-token-here');
const slackToken = process.env.SLACK_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL || '#balance-maintainar';


let web;
if (slackEnabled && slackToken) {
  web = new WebClient(slackToken);
}

export async function sendMessageToSlack(message) {
  if (!web) {
    console.log('Slack integration not configured - skipping notification');
    return;
  }

  try {
    await web.chat.postMessage({
      channel: slackChannel,
      text: message,
      mrkdwn: true
    });
  } catch (error) {
    console.error('Failed to send message to Slack:', error);
  }
}

/**
 * Send notification for cross-chain top-up (Base → AO)
 * @param {object} details - Top-up details
 * @param {boolean} dryRun - Whether this was a dry run
 */
export async function sendSwapNotification(details, dryRun = false) {
  const timestamp = new Date().toISOString();
  const formatNumber = (num) => num?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00';

  let message;
  if (dryRun) {
    message = `🔍 *[DRY RUN] Cross-Chain ARIO Top-up Simulation*\n\n` +
      `*Target Wallet (AO):* \`${details.targetWallet}\`\n\n` +
      `*AO ARIO Balance:*\n` +
      `• Current: ${formatNumber(details.previousArioBalance)} ARIO\n` +
      `• Target: ${formatNumber(details.targetBalance)} ARIO\n` +
      `• Needed: ${formatNumber(details.amountNeeded)} ARIO\n\n` +
      (details.recoveryAmount > 0 ?
        `*Bot Wallet Recovery (AO):*\n` +
        `• Would transfer ${formatNumber(details.recoveryAmount)} ARIO from bot wallet\n\n` : '') +
      (details.swapRequired ?
        `*Base Chain Swap:*\n` +
        `• Would swap: ${formatNumber(details.usdcAmount)} USDC → ${formatNumber(details.expectedArio)} ARIO\n` +
        `• Price: 1 ARIO = ${details.effectivePrice?.toFixed(6) || 'N/A'} USDC\n` +
        `• Price impact: ${details.priceImpact?.toFixed(3) || 'N/A'}%\n\n` +
        `*Base Chain Bridge:*\n` +
        `• Would burn: ${formatNumber(details.expectedArio)} ARIO on Base\n` +
        `• Destination: AO wallet\n\n` : '') +
      `*Base Wallet Balances:*\n` +
      `• ETH: ${details.ethBalance?.toFixed(6) || 'N/A'} ETH\n` +
      `• USDC: ${formatNumber(details.usdcBalance)} USDC\n` +
      `• ARIO: ${formatNumber(details.baseArioBalance)} ARIO\n\n` +
      `⚠️ *This is a simulation - no actual transactions were executed*\n\n` +
      `_${timestamp}_`;
  } else {
    message = `💱 *Cross-Chain ARIO Top-up Executed Successfully*\n\n` +
      `*Target Wallet (AO):* \`${details.targetWallet}\`\n\n` +
      `*AO ARIO Balance:*\n` +
      `• Before: ${formatNumber(details.previousArioBalance)} ARIO\n` +
      `• After: ${formatNumber(details.newBalance)} ARIO\n` +
      `• Target: ${formatNumber(details.targetBalance)} ARIO ✓\n\n` +
      (details.recoveryAmount > 0 ?
        `*Recovery Transfer (AO):*\n` +
        `• Transferred ${formatNumber(details.recoveryAmount)} ARIO from bot wallet\n` +
        (details.transactionIds?.recoveryTransferId ?
          `• TX: \`${details.transactionIds.recoveryTransferId}\`\n` : '') +
        `\n` : '') +
      (details.swapExecuted ?
        `*Base Chain Swap (USDC → ARIO):*\n` +
        `• Swapped: ${formatNumber(details.usdcAmount)} USDC → ${formatNumber(details.arioReceived)} ARIO\n` +
        `• Price: 1 ARIO = ${details.effectivePrice?.toFixed(6) || 'N/A'} USDC\n` +
        `• Price impact: ${details.priceImpact?.toFixed(3) || 'N/A'}%\n` +
        `• Gas used: ${details.swapGasUsed || 'N/A'}\n` +
        (details.transactionIds?.swapTxHash ?
          `• TX: \`${details.transactionIds.swapTxHash}\`\n` : '') +
        `\n` : '') +
      (details.burnExecuted ?
        `*Base Chain Bridge (Burn → AO):*\n` +
        `• Burned: ${formatNumber(details.burnAmount)} ARIO\n` +
        `• Destination: AO wallet\n` +
        `• Gas used: ${details.burnGasUsed || 'N/A'}\n` +
        (details.transactionIds?.burnTxHash ?
          `• TX: \`${details.transactionIds.burnTxHash}\`\n` : '') +
        `\n` : '') +
      (details.transferExecuted ?
        `*AO Transfer to Target:*\n` +
        `• Transferred: ${formatNumber(details.transferAmount)} ARIO\n` +
        (details.transactionIds?.transferToTargetId ?
          `• TX: \`${details.transactionIds.transferToTargetId}\`\n` : '') +
        `\n` : '') +
      `*Base Wallet Final Balances:*\n` +
      `• ETH: ${details.ethBalanceAfter?.toFixed(6) || details.ethBalance?.toFixed(6) || 'N/A'} ETH\n` +
      `• USDC: ${formatNumber(details.usdcBalanceAfter)} USDC\n\n` +
      `_${timestamp}_`;
  }

  await sendMessageToSlack(message);
}

/**
 * Send alert for low ETH balance on Base
 * @param {number} ethBalance - Current ETH balance
 * @param {number} minEthBalance - Minimum required ETH balance
 */
export async function sendLowEthAlert(ethBalance, minEthBalance) {
  const timestamp = new Date().toISOString();

  const message = `⚠️ *Low ETH Balance Alert*\n\n` +
    `Base wallet ETH balance is low!\n\n` +
    `• Current: ${ethBalance.toFixed(6)} ETH\n` +
    `• Minimum: ${minEthBalance.toFixed(6)} ETH\n\n` +
    `Please top up the Base wallet to ensure swaps can continue.\n\n` +
    `_${timestamp}_`;

  await sendMessageToSlack(message);
}

/**
 * Send alert for insufficient USDC balance
 * @param {number} usdcBalance - Current USDC balance
 * @param {number} usdcNeeded - USDC needed for swap
 */
export async function sendInsufficientUsdcAlert(usdcBalance, usdcNeeded) {
  const timestamp = new Date().toISOString();

  const message = `⚠️ *Insufficient USDC Alert*\n\n` +
    `Base wallet does not have enough USDC for the required swap!\n\n` +
    `• Current: ${usdcBalance.toFixed(2)} USDC\n` +
    `• Needed: ${usdcNeeded.toFixed(2)} USDC\n` +
    `• Shortfall: ${(usdcNeeded - usdcBalance).toFixed(2)} USDC\n\n` +
    `Please top up the Base wallet with USDC.\n\n` +
    `_${timestamp}_`;

  await sendMessageToSlack(message);
}

/**
 * Send alert when slippage is too high
 * @param {number} priceImpact - Actual price impact percentage
 * @param {number} maxSlippage - Maximum allowed slippage percentage
 * @param {number} amountIn - USDC amount that was attempted
 */
export async function sendHighSlippageAlert(priceImpact, maxSlippage, amountIn) {
  const timestamp = new Date().toISOString();

  const message = `⚠️ *High Slippage Alert - Swap Aborted*\n\n` +
    `Swap was aborted due to excessive price impact.\n\n` +
    `• Price impact: ${priceImpact.toFixed(3)}%\n` +
    `• Max allowed: ${maxSlippage.toFixed(1)}%\n` +
    `• Swap amount: ${amountIn.toFixed(2)} USDC\n\n` +
    `The swap will be retried on the next cycle. Consider:\n` +
    `• Splitting into smaller amounts\n` +
    `• Increasing MAX_SLIPPAGE setting\n` +
    `• Waiting for better liquidity\n\n` +
    `_${timestamp}_`;

  await sendMessageToSlack(message);
}

/**
 * Send notification for recovery-only operation (no swap needed)
 * @param {object} details - Recovery details
 */
export async function sendRecoveryOnlyNotification(details) {
  const timestamp = new Date().toISOString();
  const formatNumber = (num) => num?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00';

  const message = `🔄 *ARIO Recovery Transfer Completed*\n\n` +
    `*Target Wallet (AO):* \`${details.targetWallet}\`\n\n` +
    `Transferred existing ARIO from bot wallet to target.\n\n` +
    `*Transfer Details:*\n` +
    `• Amount: ${formatNumber(details.recoveryAmount)} ARIO\n` +
    `• Target balance before: ${formatNumber(details.previousBalance)} ARIO\n` +
    `• Target balance after: ${formatNumber(details.newBalance)} ARIO\n` +
    (details.transactionId ?
      `• TX: \`${details.transactionId}\`\n` : '') +
    `\n` +
    `_${timestamp}_`;

  await sendMessageToSlack(message);
}

/**
 * Send error notification
 * @param {string} operation - What operation failed
 * @param {Error} error - The error that occurred
 */
export async function sendErrorNotification(operation, error) {
  const timestamp = new Date().toISOString();

  const message = `❌ *Error in Balance Maintainer*\n\n` +
    `*Operation:* ${operation}\n\n` +
    `*Error:* ${error.message || String(error)}\n\n` +
    `Please check the logs for more details.\n\n` +
    `_${timestamp}_`;

  await sendMessageToSlack(message);
}
