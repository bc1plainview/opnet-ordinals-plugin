import { Pool } from 'pg';
import { JSONRpcProvider, type Block } from 'opnet';
import { networks, type Network } from '@btc-vision/bitcoin';
import { Logger } from '@btc-vision/logger';
import { InscriptionDatabase } from './database.js';
import { OrdinalsParser } from './parser.js';
import { OrdinalsAPI } from './api.js';
import { CollectionRegistry } from './collection.js';
import { BridgeDatabase } from './bridge-database.js';
import { BridgeService, type DetectedBurn } from './bridge.js';
import { BridgeAPI } from './bridge-api.js';
import type { BridgeConfig, Inscription, OrdinalsPluginConfig } from './types.js';

/**
 * OPNet Ordinals Indexer Plugin
 *
 * Indexes Ordinals inscriptions on the OPNet blockchain by fetching blocks
 * via JSON-RPC, scanning transaction witness data for inscription envelopes,
 * storing them in PostgreSQL, and exposing a REST API.
 *
 * When a bridge config is provided, also monitors for inscription burns
 * to the configured burn address and manages the Ordinals-to-OP721 bridge.
 */
export class OrdinalsIndexerPlugin {
    private readonly config: OrdinalsPluginConfig;
    private readonly provider: JSONRpcProvider;
    private readonly db: InscriptionDatabase;
    private readonly logger: Logger = new Logger();
    private readonly network: Network;
    private api: OrdinalsAPI | null = null;

    // Bridge components (optional)
    private readonly bridgeConfig: BridgeConfig | null;
    private bridge: BridgeService | null = null;
    private bridgeDb: BridgeDatabase | null = null;
    private bridgeApi: BridgeAPI | null = null;
    private collection: CollectionRegistry | null = null;

    private currentHeight: number;
    private lastBlockHash: string = '';
    private inscriptionCounter: number = 0;
    private isRunning: boolean = false;
    private isSyncing: boolean = false;

    public constructor(config: OrdinalsPluginConfig, bridgeConfig?: BridgeConfig) {
        this.config = config;
        this.bridgeConfig = bridgeConfig ?? null;
        this.currentHeight = config.startHeight;
        this.network = this.getNetwork(config.network);
        this.provider = new JSONRpcProvider(config.rpcUrl, this.network);
        this.db = new InscriptionDatabase(config.databaseUrl);

        this.logger.info('Ordinals Indexer Plugin initialized');
    }

    /**
     * Initialize the plugin: set up database, resume counter, start API,
     * and optionally initialize the bridge.
     */
    public async initialize(): Promise<void> {
        await this.db.initialize();

        this.inscriptionCounter = await this.db.getCount();

        this.logger.info(`Plugin initialized at height ${this.currentHeight}`);
        this.logger.info(`Total inscriptions indexed: ${this.inscriptionCounter}`);

        // Initialize bridge if configured
        if (this.bridgeConfig !== null) {
            await this.initializeBridge(this.bridgeConfig);
        }

        if (this.config.enableApi) {
            this.api = new OrdinalsAPI(this.db, this.config.apiPort);

            // Register bridge API routes if bridge is active
            if (this.bridge !== null) {
                this.bridgeApi = new BridgeAPI(this.bridge);
                this.bridgeApi.registerRoutes(this.api.getApp());
            }

            this.api.start();
        }
    }

    /**
     * Start the block processing loop.
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('Indexer is already running');
            return;
        }

        this.isRunning = true;
        this.logger.info(`Starting indexer from block ${this.currentHeight}`);

        while (this.isRunning) {
            try {
                await this.processNextBlock();
            } catch (error) {
                this.logger.error(`Error processing block ${this.currentHeight}: ${String(error)}`);
                await this.sleep(5000);
            }
        }
    }

    /**
     * Stop the indexer and close resources.
     */
    public async stop(): Promise<void> {
        this.logger.info('Stopping indexer...');
        this.isRunning = false;
        await this.db.close();
    }

    /**
     * Handle blockchain reorg by deleting inscriptions from the reorged height.
     */
    public async handleReorg(newHeight: number): Promise<void> {
        this.logger.warn(`Blockchain reorg detected! Rolling back to height ${newHeight}`);

        const deletedCount = await this.db.deleteFromHeight(newHeight);
        this.currentHeight = newHeight;
        this.inscriptionCounter = await this.db.getCount();

        this.logger.info(`Reorg handled: deleted ${deletedCount} inscriptions, reset to height ${newHeight}`);

        // Also handle reorg for the bridge
        if (this.bridge !== null) {
            await this.bridge.handleReorg(newHeight);
        }
    }

    /**
     * Get current indexer status.
     */
    public getStatus(): {
        currentHeight: number;
        totalInscriptions: number;
        isRunning: boolean;
        isSyncing: boolean;
        bridgeActive: boolean;
    } {
        return {
            currentHeight: this.currentHeight,
            totalInscriptions: this.inscriptionCounter,
            isRunning: this.isRunning,
            isSyncing: this.isSyncing,
            bridgeActive: this.bridge !== null,
        };
    }

    /**
     * Get the bridge service (if active).
     */
    public getBridge(): BridgeService | null {
        return this.bridge;
    }

    private async initializeBridge(bridgeConfig: BridgeConfig): Promise<void> {
        this.logger.info('Initializing Ordinals-to-OP721 bridge...');

        // Load collection
        this.collection = new CollectionRegistry(
            bridgeConfig.collectionName,
            bridgeConfig.collectionSymbol,
        );
        this.collection.loadFromFile(bridgeConfig.collectionFile);

        // Create bridge database using the same connection pool
        const pool = new Pool({
            connectionString: this.config.databaseUrl,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
        this.bridgeDb = new BridgeDatabase(pool);
        await this.bridgeDb.initialize();

        // Create bridge service
        this.bridge = new BridgeService(
            this.collection,
            this.bridgeDb,
            bridgeConfig.burnAddress,
            bridgeConfig.confirmations,
        );

        this.logger.info(
            `Bridge initialized: ${this.collection.size} items in collection, ` +
            `burn address: ${bridgeConfig.burnAddress}, ` +
            `confirmations: ${bridgeConfig.confirmations}`,
        );
    }

    private getNetwork(network: 'mainnet' | 'testnet' | 'regtest'): Network {
        switch (network) {
            case 'mainnet':
                return networks.bitcoin;
            case 'testnet':
                return networks.testnet;
            case 'regtest':
                return networks.regtest;
            default:
                throw new Error(`Unknown network: ${String(network)}`);
        }
    }

    /**
     * Fetch and process the next block.
     */
    private async processNextBlock(): Promise<void> {
        try {
            this.isSyncing = true;

            const block: Block = await this.provider.getBlock(
                BigInt(this.currentHeight),
                true,
            );

            // Detect reorgs by checking parent hash continuity
            if (this.lastBlockHash !== '' && block.previousBlockHash !== this.lastBlockHash) {
                this.isSyncing = false;
                await this.handleReorg(this.currentHeight);
                return;
            }

            const transactions = block.transactions;

            this.logger.info(
                `Processing block ${this.currentHeight} (${transactions.length} txs)`,
            );

            let foundInscriptions = 0;

            for (const tx of transactions) {
                const count = await this.processTransaction(tx, block);
                foundInscriptions += count;
            }

            if (foundInscriptions > 0) {
                this.logger.info(
                    `  Found ${foundInscriptions} inscription(s) in block ${this.currentHeight}`,
                );
            }

            // After processing the block, confirm any pending bridge claims
            if (this.bridge !== null) {
                const confirmed = await this.bridge.confirmPendingClaims(this.currentHeight);
                if (confirmed > 0) {
                    this.logger.info(
                        `  Confirmed ${confirmed} bridge claim(s) at height ${this.currentHeight}`,
                    );
                }
            }

            this.lastBlockHash = block.hash;
            this.currentHeight++;
            this.isSyncing = false;
        } catch (error: unknown) {
            this.isSyncing = false;

            if (error instanceof Error && error.message.includes('not found')) {
                this.logger.debug(`Block ${this.currentHeight} not found, waiting...`);
                await this.sleep(10000);
            } else {
                throw error;
            }
        }
    }

    /**
     * Process a single transaction, scanning each input's witness stack
     * for inscription envelopes. Also checks outputs for burns to the
     * bridge burn address.
     */
    private async processTransaction(
        tx: Block['transactions'][number],
        block: Block,
    ): Promise<number> {
        let foundCount = 0;
        let inscriptionIndex = 0;

        // Derive the first output address (inscription owner / recipient)
        let firstOutputAddress = '';
        if (tx.outputs.length > 0) {
            const firstOutput = tx.outputs[0];
            const spk = firstOutput.scriptPubKey;
            firstOutputAddress = spk.address || (spk.addresses?.[0] ?? '');
        }

        for (let inputIdx = 0; inputIdx < tx.inputs.length; inputIdx++) {
            const input = tx.inputs[inputIdx];
            const witnessHexItems = input.transactionInWitness;

            if (!witnessHexItems || witnessHexItems.length === 0) {
                continue;
            }

            // Convert hex strings to Buffers
            const witnessBuffers: Buffer[] = witnessHexItems.map((hex) =>
                Buffer.from(hex, 'hex'),
            );

            const envelope = OrdinalsParser.parseInscription(witnessBuffers);

            if (envelope !== null) {
                // Inscription ID uses the official format: {txid}i{index}
                const inscriptionId = `${tx.hash}i${inscriptionIndex}`;

                const inscription: Inscription = {
                    id: inscriptionId,
                    contentType: envelope.contentType,
                    content: envelope.content,
                    blockHeight: this.currentHeight,
                    blockHash: block.hash,
                    txid: tx.hash,
                    vout: 0,
                    owner: firstOutputAddress,
                    timestamp: block.time,
                    inscriptionNumber: this.inscriptionCounter++,
                };

                await this.db.save(inscription);

                this.logger.info(
                    `  Inscription #${inscription.inscriptionNumber}: ${inscription.id} ` +
                    `(${inscription.contentType}, ${inscription.content.length} bytes)`,
                );

                foundCount++;
                inscriptionIndex++;
            }
        }

        // Check if this transaction sends to the burn address (bridge detection)
        if (this.bridge !== null) {
            await this.checkForBurn(tx, block, firstOutputAddress);
        }

        return foundCount;
    }

    /**
     * Check if a transaction sends an inscription to the burn address.
     *
     * In Ordinals, the inscription is attached to the first output (vout 0).
     * If that output's address matches the burn address, it means the
     * inscription is being burned.
     *
     * We look at the input's previous outpoint to find the inscription ID
     * that was transferred.
     */
    private async checkForBurn(
        tx: Block['transactions'][number],
        block: Block,
        firstOutputAddress: string,
    ): Promise<void> {
        if (this.bridge === null) return;

        const burnAddress = this.bridge.getBurnAddress();

        // Check if first output goes to the burn address
        if (firstOutputAddress !== burnAddress) {
            return;
        }

        // The inscription being burned is identified by the input's previous
        // outpoint. For ordinals, this is typically the first input.
        // The inscription ID is {prev_txid}i{prev_vout}.
        if (tx.inputs.length === 0) return;

        const firstInput = tx.inputs[0];
        const prevTxid = firstInput.originalTransactionId;
        const prevVout = firstInput.outputTransactionIndex;

        if (!prevTxid) return;

        const inscriptionId = `${prevTxid}i${prevVout}`;

        // Only process if this inscription belongs to our collection
        if (!this.bridge.isInCollection(inscriptionId)) {
            return;
        }

        // Derive sender address from the input (if available from witness/script)
        // In practice, the sender is whoever owned the UTXO being spent.
        // We use the second output (change address) as a proxy for the sender,
        // or fall back to empty string.
        let senderAddress = '';
        if (tx.outputs.length > 1) {
            const changeOutput = tx.outputs[1];
            const spk = changeOutput.scriptPubKey;
            senderAddress = spk.address || (spk.addresses?.[0] ?? '');
        }

        const burn: DetectedBurn = {
            txid: tx.hash,
            inscriptionId,
            senderAddress,
            blockHeight: this.currentHeight,
            blockHash: block.hash,
        };

        await this.bridge.processBurn(burn);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
