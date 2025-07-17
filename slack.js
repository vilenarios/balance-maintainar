import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';

dotenv.config();

const slackToken = process.env.SLACK_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL || '#balance-maintainar';


let web;
if (slackToken) {
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
  
  let message;
  if (dryRun) {
    message = `🔍 *[DRY RUN] ARIO Top-up Simulation*\n\n` +
      `*Target Wallet:* ${swapDetails.targetWallet}\n\n` +
      `*ARIO Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousArioBalance)} ARIO\n` +
      `• Target: ${formatNumber(swapDetails.targetBalance)} ARIO\n` +
      `• Needed: ${formatNumber(swapDetails.amountNeeded)} ARIO\n\n` +
      (swapDetails.botWalletArioUsed > 0 ? 
        `*Bot Wallet Recovery:*\n` +
        `• Would use ${formatNumber(swapDetails.botWalletArioUsed)} ARIO from bot wallet\n\n` : '') +
      (swapDetails.swapRequired ? 
        `*Swap Details:*\n` +
        `• Would swap: ${formatNumber(swapDetails.usdcRequired)} wUSDC → ${formatNumber(swapDetails.expectedArio)} ARIO\n` +
        `• Price: 1 ARIO = ${swapDetails.currentPrice.toFixed(6)} wUSDC\n` +
        `• Expected slippage: ${swapDetails.slippage.toFixed(3)}%\n\n` :
        `*No Swap Required:*\n` +
        `• Bot wallet has sufficient ARIO balance\n\n`) +
      `*wUSDC Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousWusdcBalance)} wUSDC\n` +
      `• After: ${formatNumber(swapDetails.wusdcBalanceAfter)} wUSDC\n\n` +
      `⚠️ *This is a simulation - no actual transactions were executed*\n\n` +
      `_${timestamp}_`;
  } else {
    message = `💱 *ARIO Top-up Executed Successfully*\n\n` +
      `*Target Wallet:* ${swapDetails.targetWallet}\n\n` +
      `*ARIO Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousArioBalance)} ARIO\n` +
      `• After: ${formatNumber(swapDetails.newBalance || swapDetails.targetBalance)} ARIO\n` +
      `• Target: ${formatNumber(swapDetails.targetBalance)} ARIO ✓\n\n` +
      (swapDetails.botWalletArioUsed > 0 ? 
        `*Recovery Transfer:*\n` +
        `• Used ${formatNumber(swapDetails.botWalletArioUsed)} ARIO from bot wallet (previous run)\n\n` : '') +
      (swapDetails.swapRequired ? 
        `*Swap Executed:*\n` +
        `• Swapped: ${formatNumber(swapDetails.usdcRequired)} wUSDC → ${formatNumber(swapDetails.expectedArio)} ARIO\n` +
        `• Price: 1 ARIO = ${swapDetails.currentPrice.toFixed(6)} wUSDC\n` +
        `• Slippage: ${swapDetails.slippage.toFixed(3)}%\n\n` :
        `*No Swap Required:*\n` +
        `• Bot wallet had sufficient ARIO balance\n\n`) +
      `*wUSDC Balance:*\n` +
      `• Before: ${formatNumber(swapDetails.previousWusdcBalance)} wUSDC\n` +
      `• After: ${formatNumber(swapDetails.wusdcBalanceAfter)} wUSDC\n\n` +
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