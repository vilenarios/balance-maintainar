# ARIO Balance Maintainer Bot

An automated bot that maintains ARIO token balance for a specified wallet by swapping wUSDC tokens on Permaswap DEX when the balance falls below a configured threshold.

## Features

- 🔄 Automatic balance monitoring and top-up
- 💱 Integration with Permaswap DEX for token swaps
- 📊 Configurable balance thresholds
- 🔔 Slack notifications for successful swaps
- 🧪 Dry run mode for testing
- ⏰ Cron-based scheduling
- 📝 Comprehensive logging
- 🆔 Transaction ID tracking

## Prerequisites

- Node.js v16 or higher
- npm or yarn
- An Arweave wallet with wUSDC balance
- Access to ARIO and wUSDC tokens on AO

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/ario-balance-maintainer.git
cd ario-balance-maintainer
```

2. Install dependencies:
```bash
npm install
```

3. Create your `.env` file:
```bash
cp .env.example .env
```

4. Configure your `.env` file with your settings:
   - `WALLET_PATH`: Path to your Arweave wallet JSON file
   - `TARGET_WALLET_ADDRESS`: The wallet address to maintain balance for
   - `MIN_BALANCE`: Minimum ARIO balance threshold (triggers top-up)
   - `TARGET_BALANCE`: Target ARIO balance to maintain
   - `SLACK_TOKEN` and `SLACK_CHANNEL`: Optional Slack integration

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WALLET_PATH` | Path to Arweave wallet JSON | `./wallet.json` |
| `TARGET_WALLET_ADDRESS` | Wallet to maintain balance for | Required |
| `ARIO_PROCESS_ID` | ARIO token process ID | `qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE` |
| `PERMASWAP_POOL_ID` | ARIO/wUSDC pool ID | `V7yzKBtzmY_MacDF-czrb1RY06xfidcGVrOjnhthMWM` |
| `WUSDC_PROCESS_ID` | wUSDC token process ID | `7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ` |
| `MIN_BALANCE` | Minimum ARIO balance | `400000` |
| `TARGET_BALANCE` | Target ARIO balance | `400000` |
| `MAX_SLIPPAGE` | Maximum allowed slippage % | `20` |
| `CRON_SCHEDULE` | Cron schedule pattern | `0 */6 * * *` (every 6 hours) |
| `DRY_RUN` | Enable dry run mode | `false` |
| `SLACK_TOKEN` | Slack bot token | Optional |
| `SLACK_CHANNEL` | Slack channel name | Optional |

### Balance Configuration

- Balances are specified in ARIO tokens (not mARIO)
- Example: `400000` = 400,000 ARIO tokens
- The bot will trigger when balance < `MIN_BALANCE`
- It will swap enough wUSDC to bring balance to `TARGET_BALANCE`

### Slippage Protection

- The bot calculates expected slippage before executing swaps
- If slippage exceeds `MAX_SLIPPAGE`, the swap is aborted
- Default maximum slippage is 20%
- This protects against executing swaps during high volatility or low liquidity
- Aborted swaps are notified via Slack and will retry on next schedule

## Usage

### Running the Bot

Start the bot:
```bash
npm start
```

The bot will:
1. Check the target wallet's ARIO balance immediately
2. If balance < MIN_BALANCE, execute a swap on Permaswap
3. Transfer the swapped ARIO to the target wallet
4. Send a Slack notification (if configured)
5. Continue monitoring based on the cron schedule

### Dry Run Mode

Test the bot without executing real transactions:
```bash
DRY_RUN=true npm start
```

### Slack Notifications

When configured, the bot sends detailed notifications including:
- Previous and current balances
- Swap details (amount, price, slippage)
- Transaction IDs for tracking
- Timestamp

Example notification:
```
💱 ARIO Top-up Executed Successfully

Target Wallet: ZeRVUPflKvdOP1Ow_AMYmTggZr33Ofbe_Ud8_alpRIU

ARIO Balance:
• Before: 350,000.00 ARIO
• After: 400,000.00 ARIO
• Target: 400,000.00 ARIO ✓

Swap Executed:
• Swapped: 885.00 wUSDC → 50,000.00 ARIO
• Price: 1 ARIO = 0.017700 wUSDC
• Slippage: 0.125%

wUSDC Balance:
• Before: 1,000.00 wUSDC
• After: 115.00 wUSDC

Transaction IDs:
• Order: `abc123...`
• Note: `def456...`
• Transfer to Settle: `ghi789...`
• Transfer to Target: `jkl012...`

2024-01-15T10:30:45.123Z
```

## How It Works

1. **Balance Check**: The bot checks the target wallet's ARIO balance
2. **Swap Calculation**: If balance is low, it calculates the required wUSDC amount
3. **Permaswap Execution**: 
   - Requests order from Permaswap pool
   - Transfers wUSDC to the settle contract
   - Waits 60 seconds for settlement
4. **Transfer**: Transfers the received ARIO to the target wallet
5. **Notification**: Sends success notification with all transaction details

## Logging

The bot uses Winston for logging:
- Console output with timestamps
- File logging to `topup-bot.log`
- Structured JSON format for easy parsing

## Development

### Project Structure
```
.
├── index.js          # Main bot logic
├── permaswap.js      # Permaswap DEX integration
├── slack.js          # Slack notification handler
├── package.json      # Dependencies
├── .env.example      # Example configuration
└── README.md         # This file
```

### Testing

1. Set up a test environment with small amounts
2. Use `DRY_RUN=true` to simulate operations
3. Monitor logs for detailed execution flow
4. Verify transaction IDs on [ViewBlock](https://viewblock.io/arweave)

## Security Considerations

- Never commit your `.env` file or wallet JSON
- Keep your wallet file secure with proper permissions
- Use a dedicated wallet for the bot with only necessary funds
- Monitor the bot's activity regularly
- Consider using a hardware wallet for production

## Troubleshooting

### Common Issues

1. **"Insufficient funds"**: Ensure your wallet has enough wUSDC
2. **"Channel not found"**: Verify Slack bot is added to the channel
3. **"Pool info missing"**: Check if Permaswap pool ID is correct
4. **Settlement delays**: The bot waits 60 seconds for settlement

### Debug Mode

Enable detailed logging:
```bash
LOG_LEVEL=debug npm start
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built on [AO](https://ao.ar.io/) and [Arweave](https://www.arweave.org/)
- Uses [Permaswap](https://permaswap.network/) for decentralized token swaps
- Powered by [@permaweb/aoconnect](https://www.npmjs.com/package/@permaweb/aoconnect)