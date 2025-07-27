# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
# Run the bot
npm start

# Run with file watching (development mode)
npm run dev

# Dry run mode (simulate without executing trades)
DRY_RUN=true npm start
```

### Important Notes
- No test suite exists - tests need to be written
- No linting configured - consider adding ESLint
- No build process required - runs directly with Node.js

## Architecture Overview

This is an automated bot that maintains ARIO token balance by swapping wUSDC on Permaswap DEX. The system monitors a target wallet and executes swaps when balance falls below threshold.

### Core Components

1. **index.js** - Main orchestrator
   - Loads Arweave wallet and initializes connections
   - Implements balance checking and swap execution logic
   - Handles recovery transfers from previous runs
   - Includes slippage protection (aborts if > MAX_SLIPPAGE)
   - Manages cron scheduling for periodic checks

2. **permaswap.js** - DEX integration
   - PermaswapDEX class handles all swap operations
   - Uses constant product formula for price calculations
   - Manages order creation, token transfers, and settlement
   - Includes 60-second settlement wait period

3. **slack.js** - Notification system
   - Sends detailed swap reports to Slack (optional)
   - Formats transaction IDs and balance changes

### Critical Flow

1. Check target wallet ARIO balance
2. If balance < MIN_BALANCE:
   - Transfer any existing ARIO from bot wallet (recovery)
   - Calculate swap details including slippage
   - Abort if slippage > MAX_SLIPPAGE (default 20%)
   - Execute swap on Permaswap
   - Wait 60 seconds for settlement
   - Check actual received amount (not expected)
   - Transfer only available balance to target wallet
3. Send Slack notification with transaction IDs

### Key Safety Features

- **Slippage Protection**: Aborts trades if slippage exceeds MAX_SLIPPAGE
- **Balance Verification**: Always checks actual balance before transfers
- **Recovery Mechanism**: Transfers existing bot wallet ARIO before swapping
- **Dry Run Mode**: Test without executing real transactions

## Configuration

All configuration via environment variables (see .env.example):
- Process IDs are hardcoded defaults for ARIO/wUSDC/Permaswap
- Balances in whole tokens (not smallest units)
- Critical: WALLET_PATH and TARGET_WALLET_ADDRESS required

## Known Issues & Edge Cases

1. **Insufficient Balance Error**: Fixed - now checks actual received amount after swap
2. **No Concurrency Protection**: Multiple instances could cause issues
3. **Settlement Only Time-Based**: Waits 60s without verifying completion
4. **Precision Loss**: Uses Math.floor() which truncates decimals

## Development Tips

- Always test with DRY_RUN=true first
- Monitor logs in topup-bot.log for detailed execution
- Transaction IDs can be verified on ViewBlock
- Bot continues on recovery transfer failures
- Slack notifications are optional but recommended for production