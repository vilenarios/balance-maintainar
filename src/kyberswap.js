import { ethers } from 'ethers';

// KyberSwap Aggregator API endpoints
const KYBERSWAP_API_BASE = 'https://aggregator-api.kyberswap.com';
const CHAIN_NAME = 'base';

// Default contract addresses on Base mainnet
const DEFAULT_CONTRACTS = {
  ARIO: '0x138746adfA52909E5920def027f5a8dc1C7EfFb6',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

// Minimal ERC20 ABI for approvals
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export class KyberSwapDEX {
  constructor(provider, wallet, logger, config = {}) {
    this.provider = provider;
    this.wallet = wallet;
    this.logger = logger;

    // Token addresses
    this.usdcAddress = config.usdcContract || DEFAULT_CONTRACTS.USDC;
    this.arioAddress = config.arioContract || DEFAULT_CONTRACTS.ARIO;

    // Token decimals
    this.usdcDecimals = 6;
    this.arioDecimals = 6;

    // USDC contract for approvals
    this.usdcContract = new ethers.Contract(this.usdcAddress, ERC20_ABI, this.wallet);

    // Client ID for KyberSwap API
    this.clientId = 'balance-maintainar-bot';
  }

  /**
   * Get swap route from KyberSwap Aggregator API
   * @param {number} amountIn - Amount of USDC to swap (in token units, not smallest)
   * @returns {Promise<object>} Route data including expected output and router address
   */
  async getSwapRoute(amountIn) {
    try {
      // Round to max 6 decimals (USDC precision) to avoid parseUnits errors
      const amountInRounded = Math.floor(amountIn * 1e6) / 1e6;
      // Convert to smallest units
      const amountInSmallest = ethers.parseUnits(amountInRounded.toString(), this.usdcDecimals).toString();

      const url = new URL(`${KYBERSWAP_API_BASE}/${CHAIN_NAME}/api/v1/routes`);
      url.searchParams.append('tokenIn', this.usdcAddress);
      url.searchParams.append('tokenOut', this.arioAddress);
      url.searchParams.append('amountIn', amountInSmallest);
      url.searchParams.append('saveGas', 'false');
      url.searchParams.append('gasInclude', 'true');

      this.logger.info(`Fetching swap route from KyberSwap...`);
      this.logger.info(`├─ Token In: USDC (${this.usdcAddress})`);
      this.logger.info(`├─ Token Out: ARIO (${this.arioAddress})`);
      this.logger.info(`└─ Amount In: ${amountIn} USDC`);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-client-id': this.clientId,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`KyberSwap API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (data.code !== 0 || !data.data?.routeSummary) {
        throw new Error(`KyberSwap route not found: ${data.message || 'No route available'}`);
      }

      const routeSummary = data.data.routeSummary;
      const routerAddress = data.data.routerAddress; // routerAddress is at data.data level, not in routeSummary
      const amountOut = parseFloat(ethers.formatUnits(routeSummary.amountOut, this.arioDecimals));
      const amountInFormatted = parseFloat(ethers.formatUnits(routeSummary.amountIn, this.usdcDecimals));

      // Calculate effective price and slippage
      const effectivePrice = amountInFormatted / amountOut; // USDC per ARIO
      const expectedPrice = amountIn / amountOut;
      const priceImpact = parseFloat(routeSummary.priceImpact || '0');

      this.logger.info(`📊 Route found:`);
      this.logger.info(`├─ Expected output: ${amountOut.toFixed(2)} ARIO`);
      this.logger.info(`├─ Effective price: 1 ARIO = ${effectivePrice.toFixed(6)} USDC`);
      this.logger.info(`├─ Price impact: ${priceImpact.toFixed(3)}%`);
      this.logger.info(`└─ Router: ${routerAddress}`);

      return {
        routeSummary,
        amountIn: amountInFormatted,
        amountInSmallest: routeSummary.amountIn,
        amountOut,
        amountOutSmallest: routeSummary.amountOut,
        effectivePrice,
        priceImpact,
        routerAddress,
        gas: routeSummary.gas,
      };
    } catch (error) {
      this.logger.error('Failed to get swap route:', error);
      throw error;
    }
  }

  /**
   * Encode swap data for execution
   * @param {object} routeSummary - Route summary from getSwapRoute
   * @param {number} slippageTolerance - Slippage tolerance in basis points (e.g., 50 = 0.5%)
   * @returns {Promise<object>} Encoded transaction data
   */
  async encodeSwapData(routeSummary, slippageTolerance = 50) {
    try {
      const url = `${KYBERSWAP_API_BASE}/${CHAIN_NAME}/api/v1/route/build`;

      const requestBody = {
        routeSummary,
        sender: this.wallet.address,
        recipient: this.wallet.address,
        slippageTolerance, // in basis points (50 = 0.5%)
        deadline: Math.floor(Date.now() / 1000) + 1200, // 20 minutes from now
        source: this.clientId,
      };

      this.logger.info(`Encoding swap transaction...`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': this.clientId,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`KyberSwap encode error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (data.code !== 0 || !data.data) {
        throw new Error(`KyberSwap encode failed: ${data.message || 'Unknown error'}`);
      }

      return {
        encodedData: data.data.data,
        routerAddress: data.data.routerAddress,
        amountIn: data.data.amountIn,
        amountOut: data.data.amountOut,
        gas: data.data.gas,
      };
    } catch (error) {
      this.logger.error('Failed to encode swap data:', error);
      throw error;
    }
  }

  /**
   * Check and approve USDC allowance if needed
   * @param {string} spenderAddress - Router address
   * @param {string} amountNeeded - Amount needed in smallest units
   * @param {boolean} dryRun - If true, simulate without executing
   * @returns {Promise<{approved: boolean, txHash: string | null}>}
   */
  async ensureAllowance(spenderAddress, amountNeeded, dryRun = false) {
    try {
      const currentAllowance = await this.usdcContract.allowance(
        this.wallet.address,
        spenderAddress
      );

      if (currentAllowance >= BigInt(amountNeeded)) {
        this.logger.info(`USDC allowance sufficient: ${ethers.formatUnits(currentAllowance, this.usdcDecimals)} USDC`);
        return { approved: true, txHash: null, alreadyApproved: true };
      }

      if (dryRun) {
        this.logger.info(`[DRY RUN] Would approve USDC for ${spenderAddress}`);
        return { approved: true, txHash: null, dryRun: true };
      }

      this.logger.info(`Approving USDC for KyberSwap router...`);

      // Approve max amount to avoid repeated approvals
      const tx = await this.usdcContract.approve(spenderAddress, ethers.MaxUint256);
      const receipt = await tx.wait();

      this.logger.info(`USDC approval confirmed: ${receipt.hash}`);

      return { approved: true, txHash: receipt.hash };
    } catch (error) {
      this.logger.error('Failed to ensure USDC allowance:', error);
      throw error;
    }
  }

  /**
   * Execute swap: USDC → ARIO on Base via KyberSwap
   * @param {number} amountIn - Amount of USDC to swap (in token units)
   * @param {number} maxSlippage - Maximum allowed slippage percentage (e.g., 1 = 1%)
   * @param {boolean} dryRun - If true, simulate without executing
   * @returns {Promise<object>} Swap result with transaction details
   */
  async executeSwap(amountIn, maxSlippage = 1, dryRun = false) {
    try {
      this.logger.info(`═══════════════════════════════════════════════`);
      this.logger.info(`🔄 Initiating swap: ${amountIn} USDC → ARIO`);
      this.logger.info(`═══════════════════════════════════════════════`);

      // Step 1: Get route
      const route = await this.getSwapRoute(amountIn);

      // Check slippage/price impact
      if (route.priceImpact > maxSlippage) {
        this.logger.warn(`⚠️ Price impact (${route.priceImpact.toFixed(3)}%) exceeds max slippage (${maxSlippage}%)`);
        return {
          success: false,
          aborted: true,
          reason: 'Price impact too high',
          priceImpact: route.priceImpact,
          maxSlippage,
          route,
        };
      }

      if (dryRun) {
        this.logger.info(`[DRY RUN] Swap simulation complete`);
        this.logger.info(`├─ Would swap: ${amountIn} USDC → ${route.amountOut.toFixed(2)} ARIO`);
        this.logger.info(`├─ Price impact: ${route.priceImpact.toFixed(3)}%`);
        this.logger.info(`└─ Router: ${route.routerAddress}`);

        return {
          success: true,
          dryRun: true,
          amountIn,
          expectedAmountOut: route.amountOut,
          priceImpact: route.priceImpact,
          effectivePrice: route.effectivePrice,
          route,
        };
      }

      // Step 2: Ensure USDC allowance
      const allowanceResult = await this.ensureAllowance(
        route.routerAddress,
        route.amountInSmallest,
        dryRun
      );

      // Step 3: Encode swap data
      const slippageBps = Math.floor(maxSlippage * 100); // Convert percentage to basis points
      const encodedSwap = await this.encodeSwapData(route.routeSummary, slippageBps);

      // Step 4: Execute swap transaction
      this.logger.info(`Executing swap transaction...`);

      const tx = await this.wallet.sendTransaction({
        to: encodedSwap.routerAddress,
        data: encodedSwap.encodedData,
        gasLimit: BigInt(encodedSwap.gas) * 12n / 10n, // Add 20% buffer
      });

      this.logger.info(`Swap transaction submitted: ${tx.hash}`);

      // Wait for confirmation
      const receipt = await tx.wait();

      this.logger.info(`✅ Swap confirmed in block ${receipt.blockNumber}`);
      this.logger.info(`├─ Transaction hash: ${receipt.hash}`);
      this.logger.info(`├─ Gas used: ${receipt.gasUsed.toString()}`);
      this.logger.info(`└─ Status: ${receipt.status === 1 ? 'Success' : 'Failed'}`);

      if (receipt.status !== 1) {
        throw new Error('Swap transaction failed');
      }

      return {
        success: true,
        txHash: receipt.hash,
        amountIn,
        expectedAmountOut: route.amountOut,
        priceImpact: route.priceImpact,
        effectivePrice: route.effectivePrice,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
        approvalTxHash: allowanceResult.txHash,
      };
    } catch (error) {
      this.logger.error('Failed to execute swap:', error);
      throw error;
    }
  }

  /**
   * Get current price (USDC per ARIO) by querying a small route
   * @returns {Promise<{price: number, timestamp: number}>}
   */
  async getPrice() {
    try {
      // Query route for a small amount to get current price
      const testAmount = 100; // 100 USDC
      const route = await this.getSwapRoute(testAmount);

      return {
        price: route.effectivePrice,
        priceImpact: route.priceImpact,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error('Failed to get price:', error);
      throw error;
    }
  }

  /**
   * Calculate how much USDC is needed for a target ARIO amount
   * @param {number} targetArioAmount - Desired ARIO output
   * @returns {Promise<{usdcNeeded: number, expectedArio: number, priceImpact: number}>}
   */
  async calculateUsdcNeeded(targetArioAmount) {
    try {
      // Get current price
      const priceInfo = await this.getPrice();
      const estimatedUsdc = targetArioAmount * priceInfo.price;

      // Add buffer for slippage (10%)
      const usdcWithBuffer = estimatedUsdc * 1.1;

      // Get actual route to verify
      const route = await this.getSwapRoute(usdcWithBuffer);

      // Binary search to find optimal USDC amount
      // For now, use simple estimation with the route's effective price
      const adjustedUsdc = targetArioAmount * route.effectivePrice * 1.02; // 2% buffer

      this.logger.info(`💰 USDC calculation for ${targetArioAmount.toFixed(2)} ARIO:`);
      this.logger.info(`├─ Current price: 1 ARIO = ${priceInfo.price.toFixed(6)} USDC`);
      this.logger.info(`├─ Estimated USDC needed: ${adjustedUsdc.toFixed(2)} USDC`);
      this.logger.info(`└─ Expected output: ~${(adjustedUsdc / route.effectivePrice).toFixed(2)} ARIO`);

      return {
        usdcNeeded: adjustedUsdc,
        expectedArio: adjustedUsdc / route.effectivePrice,
        priceImpact: route.priceImpact,
        effectivePrice: route.effectivePrice,
      };
    } catch (error) {
      this.logger.error('Failed to calculate USDC needed:', error);
      throw error;
    }
  }
}
