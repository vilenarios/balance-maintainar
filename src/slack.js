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

export async function sendSwapNotification(swapDetails, dryRun = false) {
  const timestamp = new Date().toISOString();
  const formatNumber = (num) => num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  
  // Use configured token symbols, defaulting to ARIO/wUSDC for backwards compatibility
  const targetSymbol = swapDetails.targetTokenSymbol || 'ARIO';
  const sourceSymbol = swapDetails.sourceTokenSymbol || 'wUSDC';
  
  let message;
  if (dryRun) {
    message = `🔍 *[DRY RUN] ${targetSymbol} Top-up Simulation*\n\n` +
      `*Target Wallet:* ${swapDetails.targetWallet}\n\n` +
      `*${targetSymbol} Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousArioBalance)} ${targetSymbol}\n` +
      `• Target: ${formatNumber(swapDetails.targetBalance)} ${targetSymbol}\n` +
      `• Needed: ${formatNumber(swapDetails.amountNeeded)} ${targetSymbol}\n\n` +
      (swapDetails.botWalletArioUsed > 0 ? 
        `*Bot Wallet Recovery:*\n` +
        `• Would use ${formatNumber(swapDetails.botWalletArioUsed)} ${targetSymbol} from bot wallet\n\n` : '') +
      (swapDetails.swapRequired ? 
        `*Swap Details:*\n` +
        `• Would swap: ${formatNumber(swapDetails.usdcRequired)} ${sourceSymbol} → ${formatNumber(swapDetails.expectedArio)} ${targetSymbol}\n` +
        `• Price: 1 ${targetSymbol} = ${swapDetails.currentPrice.toFixed(6)} ${sourceSymbol}\n` +
        `• Expected slippage: ${swapDetails.slippage.toFixed(3)}%\n\n` :
        `*No Swap Required:*\n` +
        `• Bot wallet has sufficient ${targetSymbol} balance\n\n`) +
      `*${sourceSymbol} Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousWusdcBalance)} ${sourceSymbol}\n` +
      `• After: ${formatNumber(swapDetails.wusdcBalanceAfter)} ${sourceSymbol}\n\n` +
      `⚠️ *This is a simulation - no actual transactions were executed*\n\n` +
      `_${timestamp}_`;
  } else {
    message = `💱 *${targetSymbol} Top-up Executed Successfully*\n\n` +
      `*Target Wallet:* ${swapDetails.targetWallet}\n\n` +
      `*${targetSymbol} Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousArioBalance)} ${targetSymbol}\n` +
      `• After: ${formatNumber(swapDetails.newBalance || swapDetails.targetBalance)} ${targetSymbol}\n` +
      `• Target: ${formatNumber(swapDetails.targetBalance)} ${targetSymbol} ✓\n\n` +
      (swapDetails.botWalletArioUsed > 0 ? 
        `*Recovery Transfer:*\n` +
        `• Used ${formatNumber(swapDetails.botWalletArioUsed)} ${targetSymbol} from bot wallet (previous run)\n\n` : '') +
      (swapDetails.swapRequired ? 
        `*Swap Executed:*\n` +
        `• Swapped: ${formatNumber(swapDetails.usdcRequired)} ${sourceSymbol} → ${formatNumber(swapDetails.expectedArio)} ${targetSymbol}\n` +
        `• Price: 1 ${targetSymbol} = ${swapDetails.currentPrice.toFixed(6)} ${sourceSymbol}\n` +
        `• Slippage: ${swapDetails.slippage.toFixed(3)}%\n\n` :
        `*No Swap Required:*\n` +
        `• Bot wallet had sufficient ${targetSymbol} balance\n\n`) +
      `*${sourceSymbol} Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousWusdcBalance)} ${sourceSymbol}\n` +
      `• After: ${formatNumber(swapDetails.wusdcBalanceAfter)} ${sourceSymbol}\n\n` +
      (swapDetails.transactionIds ? 
        `*Transaction IDs:*\n` +
        (swapDetails.transactionIds.recoveryTransferId ? 
          `• Recovery Transfer: \`${swapDetails.transactionIds.recoveryTransferId}\`\n` : '') +
        (swapDetails.transactionIds.orderMessageId ? 
          `• Order: \`${swapDetails.transactionIds.orderMessageId}\`\n` : '') +
        (swapDetails.transactionIds.noteId ? 
          `• Note: \`${swapDetails.transactionIds.noteId}\`\n` : '') +
        (swapDetails.transactionIds.transferToSettleId ? 
          `• Transfer to Settle: \`${swapDetails.transactionIds.transferToSettleId}\`\n` : '') +
        (swapDetails.transactionIds.transferToTargetId ? 
          `• Transfer to Target: \`${swapDetails.transactionIds.transferToTargetId}\`\n` : '') +
        `\n` : '') +
      `_${timestamp}_`;
  }

  await sendMessageToSlack(message);
}