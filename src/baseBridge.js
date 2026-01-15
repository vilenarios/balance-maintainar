import { ethers } from 'ethers';

// Minimal ABI for ERC20 token interactions
const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// ARIO token ABI with burn function
const ARIO_ABI = [
  ...ERC20_ABI,
  'function burn(uint256 amount, string memory arweaveAddress) public',
  'event Burn(address from, uint256 amount, string arweaveAddress)',
];

// Default contract addresses on Base mainnet
const DEFAULT_CONTRACTS = {
  ARIO: '0x138746adfA52909E5920def027f5a8dc1C7EfFb6',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

export class BaseBridge {
  constructor(config, logger, provider = null, wallet = null) {
    this.logger = logger;
    this.config = config;

    // Use provided provider/wallet or create new ones
    this.provider = provider || new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = wallet || new ethers.Wallet(config.privateKey, this.provider);

    // Contract addresses
    this.arioAddress = config.arioContract || DEFAULT_CONTRACTS.ARIO;
    this.usdcAddress = config.usdcContract || DEFAULT_CONTRACTS.USDC;

    // Initialize contract instances
    this.arioContract = new ethers.Contract(this.arioAddress, ARIO_ABI, this.wallet);
    this.usdcContract = new ethers.Contract(this.usdcAddress, ERC20_ABI, this.wallet);

    // Token decimals (both ARIO and USDC are 6 decimals on Base)
    this.arioDecimals = 6;
    this.usdcDecimals = 6;
  }

  /**
   * Get the wallet address
   */
  getWalletAddress() {
    return this.wallet.address;
  }

  /**
   * Get ETH balance for gas monitoring
   * @returns {Promise<{balance: string, balanceFormatted: string}>}
   */
  async getEthBalance() {
    try {
      const balance = await this.provider.getBalance(this.wallet.address);
      const balanceFormatted = ethers.formatEther(balance);

      this.logger.info(`Base wallet ETH balance: ${balanceFormatted} ETH`);

      return {
        balance: balance.toString(),
        balanceFormatted: parseFloat(balanceFormatted),
      };
    } catch (error) {
      this.logger.error('Failed to get ETH balance:', error);
      throw error;
    }
  }

  /**
   * Get USDC balance on Base
   * @returns {Promise<{balance: string, balanceFormatted: number}>}
   */
  async getUsdcBalance() {
    try {
      const balance = await this.usdcContract.balanceOf(this.wallet.address);
      const balanceFormatted = parseFloat(ethers.formatUnits(balance, this.usdcDecimals));

      this.logger.info(`Base wallet USDC balance: ${balanceFormatted.toFixed(2)} USDC`);

      return {
        balance: balance.toString(),
        balanceFormatted,
      };
    } catch (error) {
      this.logger.error('Failed to get USDC balance:', error);
      throw error;
    }
  }

  /**
   * Get ARIO balance on Base
   * @returns {Promise<{balance: string, balanceFormatted: number}>}
   */
  async getArioBalance() {
    try {
      const balance = await this.arioContract.balanceOf(this.wallet.address);
      const balanceFormatted = parseFloat(ethers.formatUnits(balance, this.arioDecimals));

      this.logger.info(`Base wallet ARIO balance: ${balanceFormatted.toFixed(2)} ARIO`);

      return {
        balance: balance.toString(),
        balanceFormatted,
      };
    } catch (error) {
      this.logger.error('Failed to get ARIO balance:', error);
      throw error;
    }
  }

  /**
   * Get all Base wallet balances
   * @returns {Promise<{address: string, eth: object, usdc: object, ario: object}>}
   */
  async getAllBalances() {
    const [eth, usdc, ario] = await Promise.all([
      this.getEthBalance(),
      this.getUsdcBalance(),
      this.getArioBalance(),
    ]);

    return {
      address: this.wallet.address,
      eth,
      usdc,
      ario,
    };
  }

  /**
   * Check USDC allowance for a spender (e.g., KyberSwap router)
   * @param {string} spenderAddress - Address to check allowance for
   * @returns {Promise<{allowance: string, allowanceFormatted: number}>}
   */
  async checkUsdcAllowance(spenderAddress) {
    try {
      const allowance = await this.usdcContract.allowance(this.wallet.address, spenderAddress);
      const allowanceFormatted = parseFloat(ethers.formatUnits(allowance, this.usdcDecimals));

      return {
        allowance: allowance.toString(),
        allowanceFormatted,
      };
    } catch (error) {
      this.logger.error('Failed to check USDC allowance:', error);
      throw error;
    }
  }

  /**
   * Approve USDC spending for a spender (e.g., KyberSwap router)
   * @param {string} spenderAddress - Address to approve
   * @param {string} amount - Amount in smallest units (or 'max' for unlimited)
   * @param {boolean} dryRun - If true, simulate without executing
   * @returns {Promise<{txHash: string, gasUsed: string}>}
   */
  async approveUsdc(spenderAddress, amount, dryRun = false) {
    try {
      const approvalAmount = amount === 'max'
        ? ethers.MaxUint256
        : BigInt(amount);

      if (dryRun) {
        this.logger.info(`[DRY RUN] Would approve ${amount === 'max' ? 'unlimited' : ethers.formatUnits(approvalAmount, this.usdcDecimals)} USDC for ${spenderAddress}`);
        return {
          success: true,
          dryRun: true,
          txHash: null,
        };
      }

      this.logger.info(`Approving USDC spending for ${spenderAddress}...`);

      const tx = await this.usdcContract.approve(spenderAddress, approvalAmount);
      const receipt = await tx.wait();

      this.logger.info(`USDC approval confirmed: ${receipt.hash}`);

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      this.logger.error('Failed to approve USDC:', error);
      throw error;
    }
  }

  /**
   * Burn ARIO on Base to bridge to AO
   * @param {number} amount - Amount in ARIO tokens (not smallest units)
   * @param {string} aoDestinationAddress - Destination wallet address on AO
   * @param {boolean} dryRun - If true, simulate without executing
   * @returns {Promise<{txHash: string, amount: number, aoDestination: string, gasUsed: string}>}
   */
  async burnToAO(amount, aoDestinationAddress, dryRun = false) {
    try {
      // Round to max 6 decimals (ARIO precision) to avoid parseUnits errors
      const amountRounded = Math.floor(amount * 1e6) / 1e6;
      // Convert to smallest units (6 decimals)
      const amountInSmallestUnit = ethers.parseUnits(amountRounded.toString(), this.arioDecimals);

      this.logger.info(`Burning ${amountRounded.toFixed(6)} ARIO on Base to bridge to AO`);
      this.logger.info(`├─ Amount (smallest unit): ${amountInSmallestUnit.toString()}`);
      this.logger.info(`└─ AO Destination: ${aoDestinationAddress}`);

      if (dryRun) {
        this.logger.info(`[DRY RUN] Would burn ${amountRounded.toFixed(6)} ARIO to ${aoDestinationAddress}`);
        return {
          success: true,
          dryRun: true,
          amount,
          aoDestination: aoDestinationAddress,
          txHash: null,
        };
      }

      // Check we have enough ARIO
      const balance = await this.getArioBalance();
      if (balance.balanceFormatted < amount) {
        throw new Error(`Insufficient ARIO balance. Have: ${balance.balanceFormatted.toFixed(2)}, Need: ${amount.toFixed(2)}`);
      }

      // Execute burn
      const tx = await this.arioContract.burn(amountInSmallestUnit, aoDestinationAddress);
      this.logger.info(`Burn transaction submitted: ${tx.hash}`);

      // Wait for confirmation
      const receipt = await tx.wait();

      this.logger.info(`Burn confirmed in block ${receipt.blockNumber}`);
      this.logger.info(`├─ Transaction hash: ${receipt.hash}`);
      this.logger.info(`├─ Gas used: ${receipt.gasUsed.toString()}`);
      this.logger.info(`└─ Status: ${receipt.status === 1 ? 'Success' : 'Failed'}`);

      if (receipt.status !== 1) {
        throw new Error('Burn transaction failed');
      }

      return {
        success: true,
        txHash: receipt.hash,
        amount,
        aoDestination: aoDestinationAddress,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      this.logger.error('Failed to burn ARIO:', error);
      throw error;
    }
  }

  /**
   * Estimate gas for burn transaction
   * @param {number} amount - Amount in ARIO tokens
   * @param {string} aoDestinationAddress - Destination on AO
   * @returns {Promise<{gasEstimate: string, gasCost: string}>}
   */
  async estimateBurnGas(amount, aoDestinationAddress) {
    try {
      const amountRounded = Math.floor(amount * 1e6) / 1e6;
      const amountInSmallestUnit = ethers.parseUnits(amountRounded.toString(), this.arioDecimals);

      const gasEstimate = await this.arioContract.burn.estimateGas(
        amountInSmallestUnit,
        aoDestinationAddress
      );

      const feeData = await this.provider.getFeeData();
      const gasCost = gasEstimate * feeData.gasPrice;

      return {
        gasEstimate: gasEstimate.toString(),
        gasCostWei: gasCost.toString(),
        gasCostEth: ethers.formatEther(gasCost),
      };
    } catch (error) {
      this.logger.error('Failed to estimate burn gas:', error);
      throw error;
    }
  }
}
