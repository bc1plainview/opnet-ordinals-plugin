import { OrdinalsIndexerPlugin } from './plugin.js';
import type { BridgeConfig, OrdinalsPluginConfig } from './types.js';

/**
 * Main entry point for the OPNet Ordinals Indexer Plugin
 */

// Load configuration from environment variables
const config: OrdinalsPluginConfig = {
    rpcUrl: process.env.OPNET_RPC_URL || 'https://regtest.opnet.org',
    network: (process.env.NETWORK as 'mainnet' | 'testnet' | 'regtest') || 'regtest',
    databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost/ordinals',
    apiPort: parseInt(process.env.API_PORT || '3002', 10),
    startHeight: parseInt(process.env.START_HEIGHT || '0', 10),
    enableApi: process.env.ENABLE_API !== 'false',
};

// Load optional bridge configuration from environment variables
function loadBridgeConfig(): BridgeConfig | undefined {
    const burnAddress = process.env.BRIDGE_BURN_ADDRESS;
    const collectionFile = process.env.BRIDGE_COLLECTION_FILE;

    if (!burnAddress || !collectionFile) {
        return undefined;
    }

    return {
        burnAddress,
        collectionFile,
        collectionName: process.env.BRIDGE_COLLECTION_NAME || 'Ordinals Collection',
        collectionSymbol: process.env.BRIDGE_COLLECTION_SYMBOL || 'ORD',
        confirmations: parseInt(process.env.BRIDGE_CONFIRMATIONS || '6', 10),
    };
}

/**
 * Mask credentials in a connection URL for safe logging.
 */
function maskUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.password) {
            parsed.password = '****';
        }
        return parsed.toString();
    } catch {
        return '***masked***';
    }
}

// Create and start the plugin
async function main(): Promise<void> {
    const bridgeConfig = loadBridgeConfig();

    console.log('Starting OPNet Ordinals Indexer Plugin');
    console.log(`Network: ${config.network}`);
    console.log(`RPC URL: ${config.rpcUrl}`);
    console.log(`Database: ${maskUrl(config.databaseUrl)}`);
    console.log(`API Port: ${config.apiPort}`);
    console.log(`Start Height: ${config.startHeight}`);

    if (bridgeConfig !== undefined) {
        console.log(`Bridge: ENABLED`);
        console.log(`  Burn Address: ${bridgeConfig.burnAddress}`);
        console.log(`  Collection: ${bridgeConfig.collectionName} (${bridgeConfig.collectionSymbol})`);
        console.log(`  Collection File: ${bridgeConfig.collectionFile}`);
        console.log(`  Confirmations: ${bridgeConfig.confirmations}`);
    } else {
        console.log('Bridge: DISABLED (set BRIDGE_BURN_ADDRESS and BRIDGE_COLLECTION_FILE to enable)');
    }
    console.log('');

    const plugin = new OrdinalsIndexerPlugin(config, bridgeConfig);

    // Initialize plugin
    await plugin.initialize();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nShutting down gracefully...');
        await plugin.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\nShutting down gracefully...');
        await plugin.stop();
        process.exit(0);
    });

    // Start indexing
    await plugin.start();
}

// Run the plugin
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});

// Export for use as a module
export { OrdinalsIndexerPlugin };
export { CollectionRegistry } from './collection.js';
export { BridgeService } from './bridge.js';
export { BridgeDatabase } from './bridge-database.js';
export { BridgeAPI } from './bridge-api.js';
export type {
    OrdinalsPluginConfig,
    Inscription,
    BurnClaim,
    BurnClaimStatus,
    BridgeConfig,
} from './types.js';
export type { CollectionItem, IndexedCollectionItem } from './collection.js';
export type { DetectedBurn } from './bridge.js';
export {
    ORDINALS_BRIDGE_NFT_ABI,
    type IOrdinalsBridgeNFTContract,
    type AttestBurnResult,
    type IsInscriptionClaimedResult,
    type AttestCountResult,
    type InscriptionBridgedEvent,
} from './bridge-abi.js';
