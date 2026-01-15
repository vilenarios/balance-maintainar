import https from 'https';

// The Base bridge's AO wallet address (sends Credit-Notice when bridging)
const BASE_BRIDGE_AO_ADDRESS = 'mFRKcHsO6Tlv2E2wZcrcbv3mmzxzD7vYPbyybI3KCVA';
const ARIO_PROCESS_ID = 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE';

/**
 * Query Arweave GraphQL for Credit-Notice transactions
 * @param {string} query - GraphQL query
 * @returns {Promise<object>} Query result
 */
function queryGraphQL(query) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });

    const options = {
      hostname: 'arweave.net',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse GraphQL response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Verify that a bridge Credit-Notice was received
 * @param {string} recipientWallet - The AO wallet that should receive the credit
 * @param {number} expectedAmount - Expected amount in ARIO (not mARIO)
 * @param {object} options - Optional settings
 * @param {number} options.tolerancePercent - Amount tolerance percentage (default 1%)
 * @param {number} options.maxAgeMinutes - Max age of transaction to consider (default 30)
 * @returns {Promise<{found: boolean, transaction: object|null, details: string}>}
 */
export async function verifyBridgeCredit(recipientWallet, expectedAmount, options = {}) {
  const { tolerancePercent = 1, maxAgeMinutes = 30 } = options;

  // Convert to mARIO (smallest units)
  const expectedMario = Math.floor(expectedAmount * 1e6);
  const toleranceMario = Math.floor(expectedMario * (tolerancePercent / 100));
  const minAmount = expectedMario - toleranceMario;
  const maxAmount = expectedMario + toleranceMario;

  const query = `
    query {
      transactions(
        recipients: ["${recipientWallet}"]
        tags: [
          { name: "Action", values: ["Credit-Notice"] }
          { name: "From-Process", values: ["${ARIO_PROCESS_ID}"] }
          { name: "Sender", values: ["${BASE_BRIDGE_AO_ADDRESS}"] }
        ]
        first: 10
        sort: HEIGHT_DESC
      ) {
        edges {
          node {
            id
            tags {
              name
              value
            }
            block {
              timestamp
            }
          }
        }
      }
    }
  `;

  const result = await queryGraphQL(query);
  const edges = result.data?.transactions?.edges || [];

  if (edges.length === 0) {
    return {
      found: false,
      transaction: null,
      details: 'No Credit-Notice found from Base bridge'
    };
  }

  // Look for matching amount
  const now = Math.floor(Date.now() / 1000);
  const maxAge = maxAgeMinutes * 60;

  for (const edge of edges) {
    const tags = edge.node.tags;
    const quantityTag = tags.find(t => t.name === 'Quantity');
    const quantity = quantityTag ? parseInt(quantityTag.value) : 0;

    // Check if amount matches within tolerance
    if (quantity >= minAmount && quantity <= maxAmount) {
      // Check age if block timestamp available
      const blockTimestamp = edge.node.block?.timestamp;
      if (blockTimestamp && (now - blockTimestamp) > maxAge) {
        continue; // Too old, skip
      }

      return {
        found: true,
        transaction: {
          id: edge.node.id,
          quantity: quantity,
          quantityArio: quantity / 1e6,
          sender: BASE_BRIDGE_AO_ADDRESS,
          recipient: recipientWallet,
          blockTimestamp
        },
        details: `Found matching Credit-Notice: ${quantity / 1e6} ARIO (TX: ${edge.node.id})`
      };
    }
  }

  // Found credit notices but none matched amount
  const latestQuantity = edges[0]?.node?.tags?.find(t => t.name === 'Quantity')?.value;
  return {
    found: false,
    transaction: null,
    details: `Credit-Notice found but amount mismatch. Expected: ~${expectedAmount} ARIO, Latest: ${latestQuantity ? (parseInt(latestQuantity) / 1e6).toFixed(2) : 'unknown'} ARIO`
  };
}

/**
 * Wait for bridge credit with polling
 * @param {string} recipientWallet - The AO wallet that should receive the credit
 * @param {number} expectedAmount - Expected amount in ARIO
 * @param {object} options - Polling options
 * @param {number} options.maxWaitMs - Maximum wait time in ms (default 5 minutes)
 * @param {number} options.pollIntervalMs - Poll interval in ms (default 30 seconds)
 * @param {function} options.onPoll - Callback on each poll attempt
 * @returns {Promise<{success: boolean, transaction: object|null, waitTimeMs: number}>}
 */
export async function waitForBridgeCredit(recipientWallet, expectedAmount, options = {}) {
  const {
    maxWaitMs = 5 * 60 * 1000,
    pollIntervalMs = 30 * 1000,
    onPoll = null
  } = options;

  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempts++;

    if (onPoll) {
      onPoll({ attempt: attempts, elapsedMs: Date.now() - startTime });
    }

    const result = await verifyBridgeCredit(recipientWallet, expectedAmount);

    if (result.found) {
      return {
        success: true,
        transaction: result.transaction,
        waitTimeMs: Date.now() - startTime,
        attempts
      };
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return {
    success: false,
    transaction: null,
    waitTimeMs: Date.now() - startTime,
    attempts
  };
}

/**
 * Get recent bridge credits to a wallet
 * @param {string} recipientWallet - The AO wallet to check
 * @param {number} limit - Max number of results (default 5)
 * @returns {Promise<Array>} List of recent credit notices
 */
export async function getRecentBridgeCredits(recipientWallet, limit = 5) {
  const query = `
    query {
      transactions(
        recipients: ["${recipientWallet}"]
        tags: [
          { name: "Action", values: ["Credit-Notice"] }
          { name: "From-Process", values: ["${ARIO_PROCESS_ID}"] }
          { name: "Sender", values: ["${BASE_BRIDGE_AO_ADDRESS}"] }
        ]
        first: ${limit}
        sort: HEIGHT_DESC
      ) {
        edges {
          node {
            id
            tags {
              name
              value
            }
            block {
              timestamp
              height
            }
          }
        }
      }
    }
  `;

  const result = await queryGraphQL(query);
  const edges = result.data?.transactions?.edges || [];

  return edges.map(edge => {
    const tags = edge.node.tags;
    const quantity = tags.find(t => t.name === 'Quantity')?.value;

    return {
      txId: edge.node.id,
      quantity: quantity ? parseInt(quantity) : 0,
      quantityArio: quantity ? parseInt(quantity) / 1e6 : 0,
      blockHeight: edge.node.block?.height,
      blockTimestamp: edge.node.block?.timestamp
    };
  });
}

export { BASE_BRIDGE_AO_ADDRESS };
