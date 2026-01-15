import { createWriteStream, existsSync, readFileSync, copyFileSync, statSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class CSVTransactionLogger {
  constructor(filename = 'transactions.csv') {
    this.filename = filename;
    this.filepath = join(process.cwd(), filename);
    this.backupDir = join(process.cwd(), 'transaction-backups');
    this.headers = [
      'timestamp',
      'transaction_type',
      'chain',
      'from_token',
      'from_amount',
      'to_token',
      'to_amount',
      'exchange_rate',
      'slippage_percent',
      'from_wallet',
      'to_wallet',
      'tx_id',
      'base_tx_hash',
      'ao_destination',
      'gas_used',
      'order_id',
      'settlement_id',
      'notes'
    ];

    this.ensureFileExists();
    this.createBackupIfNeeded();
  }

  ensureFileExists() {
    if (!existsSync(this.filepath)) {
      const stream = createWriteStream(this.filepath, { flags: 'w' });
      stream.write(this.headers.join(',') + '\n');
      stream.end();
    } else {
      try {
        const content = readFileSync(this.filepath, 'utf-8');
        if (!content || content.trim().length === 0) {
          const stream = createWriteStream(this.filepath, { flags: 'w' });
          stream.write(this.headers.join(',') + '\n');
          stream.end();
        }
      } catch (error) {
        console.error('Error reading CSV file, creating new one:', error);
        const stream = createWriteStream(this.filepath, { flags: 'w' });
        stream.write(this.headers.join(',') + '\n');
        stream.end();
      }
    }
  }

  createBackupIfNeeded() {
    try {
      if (!existsSync(this.backupDir)) {
        mkdirSync(this.backupDir, { recursive: true });
      }

      if (existsSync(this.filepath)) {
        const stats = statSync(this.filepath);
        if (stats.size > this.headers.join(',').length + 2) {
          const date = new Date();
          const backupName = `transactions_${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2,'0')}${date.getDate().toString().padStart(2,'0')}_${date.getHours().toString().padStart(2,'0')}${date.getMinutes().toString().padStart(2,'0')}.csv`;
          const backupPath = join(this.backupDir, backupName);

          if (!existsSync(backupPath)) {
            copyFileSync(this.filepath, backupPath);
            console.log(`Created backup: ${backupName}`);
            this.cleanOldBackups();
          }
        }
      }
    } catch (error) {
      console.error('Backup creation failed:', error);
    }
  }

  cleanOldBackups() {
    try {
      const files = readdirSync(this.backupDir);
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

      files.forEach(file => {
        if (file.startsWith('transactions_') && file.endsWith('.csv')) {
          const filePath = join(this.backupDir, file);
          const stats = statSync(filePath);
          if (stats.mtime.getTime() < thirtyDaysAgo) {
            unlinkSync(filePath);
            console.log(`Deleted old backup: ${file}`);
          }
        }
      });
    } catch (error) {
      console.error('Failed to clean old backups:', error);
    }
  }

  escapeCSV(value) {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  /**
   * Log a swap transaction on AO (legacy - kept for backwards compatibility)
   */
  async logSwap(data) {
    this.createBackupIfNeeded();

    const record = {
      timestamp: new Date().toISOString(),
      transaction_type: 'SWAP',
      chain: 'ao',
      from_token: data.fromToken,
      from_amount: data.fromAmount,
      to_token: data.toToken,
      to_amount: data.toAmount,
      exchange_rate: data.exchangeRate,
      slippage_percent: data.slippage,
      from_wallet: data.fromWallet,
      to_wallet: data.fromWallet,
      tx_id: data.transferToSettleId || '',
      base_tx_hash: '',
      ao_destination: '',
      gas_used: '',
      order_id: data.orderId || '',
      settlement_id: data.settlementId || '',
      notes: data.notes || ''
    };

    await this.writeRecord(record);
  }

  /**
   * Log a swap transaction on Base chain (USDC → ARIO)
   */
  async logBaseSwap(data) {
    this.createBackupIfNeeded();

    const record = {
      timestamp: new Date().toISOString(),
      transaction_type: 'BASE_SWAP',
      chain: 'base',
      from_token: data.fromToken,
      from_amount: data.fromAmount,
      to_token: data.toToken,
      to_amount: data.toAmount,
      exchange_rate: data.exchangeRate,
      slippage_percent: data.priceImpact || '0',
      from_wallet: data.baseWallet,
      to_wallet: data.baseWallet,
      tx_id: '',
      base_tx_hash: data.txHash || '',
      ao_destination: '',
      gas_used: data.gasUsed || '',
      order_id: '',
      settlement_id: '',
      notes: data.notes || 'KyberSwap aggregator swap on Base'
    };

    await this.writeRecord(record);
  }

  /**
   * Log a burn transaction on Base (bridge to AO)
   */
  async logBaseBurn(data) {
    this.createBackupIfNeeded();

    const record = {
      timestamp: new Date().toISOString(),
      transaction_type: 'BASE_BURN',
      chain: 'base',
      from_token: data.token,
      from_amount: data.amount,
      to_token: data.token,
      to_amount: data.amount,
      exchange_rate: '1',
      slippage_percent: '0',
      from_wallet: data.baseWallet,
      to_wallet: data.aoDestination,
      tx_id: '',
      base_tx_hash: data.txHash || '',
      ao_destination: data.aoDestination,
      gas_used: data.gasUsed || '',
      order_id: '',
      settlement_id: '',
      notes: data.notes || 'Burn on Base to bridge to AO'
    };

    await this.writeRecord(record);
  }

  /**
   * Log a transfer on AO
   */
  async logTransfer(data) {
    this.createBackupIfNeeded();

    const record = {
      timestamp: new Date().toISOString(),
      transaction_type: 'TRANSFER',
      chain: 'ao',
      from_token: data.token,
      from_amount: data.amount,
      to_token: data.token,
      to_amount: data.amount,
      exchange_rate: '1',
      slippage_percent: '0',
      from_wallet: data.fromWallet,
      to_wallet: data.toWallet,
      tx_id: data.txId || '',
      base_tx_hash: '',
      ao_destination: '',
      gas_used: '',
      order_id: '',
      settlement_id: '',
      notes: data.notes || ''
    };

    await this.writeRecord(record);
  }

  /**
   * Log a recovery transfer (ARIO from bot wallet to target)
   */
  async logRecovery(data) {
    this.createBackupIfNeeded();

    const record = {
      timestamp: new Date().toISOString(),
      transaction_type: 'RECOVERY_TRANSFER',
      chain: 'ao',
      from_token: data.token,
      from_amount: data.amount,
      to_token: data.token,
      to_amount: data.amount,
      exchange_rate: '1',
      slippage_percent: '0',
      from_wallet: data.fromWallet,
      to_wallet: data.toWallet,
      tx_id: data.txId || '',
      base_tx_hash: '',
      ao_destination: '',
      gas_used: '',
      order_id: '',
      settlement_id: '',
      notes: 'Recovery from previous bot run or bridge'
    };

    await this.writeRecord(record);
  }

  async writeRecord(record) {
    const values = this.headers.map(header => this.escapeCSV(record[header]));
    const line = values.join(',') + '\n';

    return new Promise((resolve, reject) => {
      const stream = createWriteStream(this.filepath, { flags: 'a' });

      stream.on('error', (error) => {
        console.error('Failed to write to CSV:', error);
        reject(error);
      });

      stream.write(line, (err) => {
        if (err) {
          console.error('Write error:', err);
          reject(err);
        } else {
          stream.end();
          resolve();
        }
      });
    });
  }

  async verifyIntegrity() {
    try {
      const content = readFileSync(this.filepath, 'utf-8');
      const lines = content.trim().split('\n');

      if (lines.length === 0) {
        return { valid: false, error: 'File is empty' };
      }

      const headerLine = lines[0];
      const expectedHeader = this.headers.join(',');

      if (headerLine !== expectedHeader) {
        return { valid: false, error: 'Header mismatch' };
      }

      for (let i = 1; i < lines.length; i++) {
        const fieldCount = lines[i].split(',').length;
        if (fieldCount < this.headers.length) {
          return { valid: false, error: `Line ${i + 1} has ${fieldCount} fields, expected ${this.headers.length}` };
        }
      }

      return { valid: true, lineCount: lines.length - 1 };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  async getTransactionSummary() {
    if (!existsSync(this.filepath)) {
      return { totalSwaps: 0, totalBaseSwaps: 0, totalBurns: 0, totalTransfers: 0, totalRecoveries: 0 };
    }

    const content = readFileSync(this.filepath, 'utf-8');
    const lines = content.trim().split('\n').slice(1);

    let totalSwaps = 0;
    let totalBaseSwaps = 0;
    let totalBurns = 0;
    let totalTransfers = 0;
    let totalRecoveries = 0;

    lines.forEach(line => {
      const [, type] = line.split(',');
      if (type === 'SWAP') totalSwaps++;
      else if (type === 'BASE_SWAP') totalBaseSwaps++;
      else if (type === 'BASE_BURN') totalBurns++;
      else if (type === 'TRANSFER') totalTransfers++;
      else if (type === 'RECOVERY_TRANSFER') totalRecoveries++;
    });

    return { totalSwaps, totalBaseSwaps, totalBurns, totalTransfers, totalRecoveries };
  }
}
