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
- No build process required - runs directly with Node.js (ES modules)

## Architecture Overview

This is an automated bot that maintains ARIO token balance on AO via cross-chain operations. The system monitors a target AO wallet and when balance falls below threshold, it:
1. Swaps USDC → ARIO on Base chain (via KyberSwap Aggregator)
2. Burns ARIO on Base to bridge to AO
3. Transfers ARIO to the target wallet on AO

### Cross-Chain Flow

```
┌─ BASE CHAIN ─────────────────────────────────────────────────────┐
│  1. Monitor: ETH balance (gas alerts), USDC balance              │
│  2. Swap: USDC → ARIO via KyberSwap Aggregator                   │
│  3. Bridge: burn(amount, aoDestinationAddress)                   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼ Bridge mints ARIO on AO
┌─ AO CHAIN ───────────────────────────────────────────────────────┐
│  4. Receive: ARIO arrives in bot's AO wallet                     │
│  5. Verify: Check balance increase                               │
│  6. Transfer: Send to target wallet                              │
└──────────────────────────────────────────────────────────────────┘
```

### Contract Addresses

| Token/Contract | Chain | Address |
|----------------|-------|---------|
| ARIO | Base | `0x138746adfA52909E5920def027f5a8dc1C7EfFb6` |
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| ARIO | AO | `qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE` |

### Core Components

1. **index.js** - Main orchestrator
   - Loads Arweave wallet (JWK) for AO and EVM wallet for Base
   - Initializes AO connection via ardrive CU
   - Orchestrates the cross-chain top-up flow
   - Manages cron-based scheduling for periodic checks
   - Handles recovery transfers from previous runs (bot wallet cleanup)
   - Includes slippage protection (aborts if price impact > MAX_SLIPPAGE)

2. **src/baseBridge.js** - Base chain operations (BaseBridge class)
   - EVM wallet management via ethers.js
   - Token balance queries (ETH, USDC, ARIO)
   - USDC approval for KyberSwap router
   - ARIO burn function for bridging to AO
   - Gas estimation for burn transactions

3. **src/kyberswap.js** - DEX integration (KyberSwapDEX class)
   - KyberSwap Aggregator API integration
   - Three-step swap: GET route → POST encode → Execute tx
   - Automatic USDC allowance management
   - Price impact checking
   - Dry-run simulation support

4. **src/slack.js** - Notification system
   - Cross-chain operation notifications
   - Low ETH balance alerts
   - Insufficient USDC alerts
   - High slippage alerts
   - Error notifications
   - Auto-enabled if SLACK_TOKEN is set

5. **src/validator.js** - Configuration validation
   - Validates Arweave wallet (JWK structure)
   - Validates Base private key (64 hex characters)
   - Validates AO process IDs (43-character format)
   - Pre-flight checks before bot execution

6. **src/csvLogger.js** - Tax accounting (CSVTransactionLogger class)
   - Logs BASE_SWAP, BASE_BURN, TRANSFER, RECOVERY_TRANSFER
   - Tracks chain (base/ao), transaction hashes, gas used
   - Automatic backup creation (hourly to transaction-backups/)
   - Auto-cleanup of backups older than 30 days

### Critical Flow (performTopUp)

1. Check target wallet ARIO balance on AO
2. If balance < MIN_BALANCE:
   - Check bot's AO wallet for existing ARIO (recovery transfer)
   - Check Base wallet balances (ETH for gas, USDC, ARIO)
   - Alert if ETH balance low (but continue if possible)
   - Calculate USDC needed for swap
   - Abort if price impact > MAX_SLIPPAGE
   - Execute swap: USDC → ARIO on Base via KyberSwap
   - Burn ARIO on Base with AO destination address
   - Wait for bridge (configurable, default 2 minutes)
   - Verify ARIO arrived in bot's AO wallet
   - Transfer to target wallet on AO
3. Log all transactions to CSV
4. Send Slack notification

### Key Safety Features

- **Slippage Protection**: Aborts swaps if price impact exceeds MAX_SLIPPAGE
- **Gas Monitoring**: Alerts when Base wallet ETH is low
- **Balance Verification**: Always checks actual balance before operations
- **Recovery Mechanism**: Transfers existing bot wallet ARIO before swapping
- **Dry Run Mode**: Full simulation without executing transactions

## Configuration

All configuration via environment variables (see .env.example):

### Required
- `WALLET_PATH` - Path to Arweave JWK wallet file
- `BASE_PRIVATE_KEY` - EVM private key for Base chain (0x prefixed)
- `TARGET_WALLET_ADDRESS` - AO wallet to maintain balance for

### Optional
- `BASE_RPC_URL` - Base chain RPC (default: https://mainnet.base.org)
- `MIN_ETH_BALANCE` - ETH threshold for alerts (default: 0.001)
- `MIN_BALANCE` - ARIO threshold to trigger top-up (default: 400000)
- `TARGET_BALANCE` - ARIO amount to top up to (default: 400000)
- `MAX_SLIPPAGE` - Max allowed price impact % (default: 20)
- `MIN_TRANSFER_AMOUNT` - Minimum ARIO to transfer (default: 500)
- `BRIDGE_WAIT_TIME` - Seconds to wait for bridge (default: 120)
- `CRON_SCHEDULE` - When to check balances (default: 0 */6 * * *)
- `DRY_RUN` - Simulate without executing (default: false)
- `SLACK_*` - Slack notification settings

## Known Issues & Edge Cases

1. **Bridge Timing**: The burn→credit bridge is fire-and-forget; CSV logs allow manual reconciliation
2. **No Concurrency Protection**: Multiple bot instances could cause issues
3. **Token Decimals**: Both ARIO and USDC use 6 decimals on Base

## Development Tips

- Always test with DRY_RUN=true first
- Monitor logs in topup-bot.log for detailed execution
- Base transactions viewable on BaseScan
- AO transactions viewable on ao.link
- Keep Base wallet funded with ETH for gas and USDC for swaps
- Slack notifications recommended for production monitoring
