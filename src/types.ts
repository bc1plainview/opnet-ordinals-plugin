/**
 * Ordinals inscription data structure
 */
export interface Inscription {
    readonly id: string;
    readonly contentType: string;
    readonly content: Buffer;
    readonly blockHeight: number;
    readonly blockHash: string;
    readonly txid: string;
    readonly vout: number;
    readonly owner: string;
    readonly timestamp: number;
    readonly inscriptionNumber: number;
}

/**
 * Parsed inscription envelope from witness data
 *
 * Follows the official ord specification:
 * OP_FALSE OP_IF PUSH("ord") [tag value]... PUSH_EMPTY [body chunks]... OP_ENDIF
 */
export interface InscriptionEnvelope {
    readonly content: Buffer;
    readonly contentType: string;
    readonly pointer?: Buffer;
    readonly parent?: Buffer;
    readonly metadata?: Buffer;
    readonly metaprotocol?: string;
    readonly contentEncoding?: string;
    readonly delegate?: Buffer;
}

/**
 * Plugin configuration
 */
export interface OrdinalsPluginConfig {
    readonly rpcUrl: string;
    readonly network: 'mainnet' | 'testnet' | 'regtest';
    readonly databaseUrl: string;
    readonly apiPort: number;
    readonly startHeight: number;
    readonly enableApi: boolean;
}

/**
 * Database row shape returned by pg for inscriptions table
 */
export interface InscriptionRow {
    readonly id: string;
    readonly content_type: string;
    readonly content: Buffer;
    readonly block_height: number;
    readonly block_hash: string;
    readonly txid: string;
    readonly vout: number;
    readonly owner: string;
    readonly timestamp: string;
    readonly inscription_number: number;
}

/**
 * Status of a burn claim in the bridge pipeline.
 */
export type BurnClaimStatus =
    | 'detected'
    | 'confirmed'
    | 'attested'
    | 'failed';

/**
 * A burn claim tracks an ordinal inscription sent to the burn address.
 */
export interface BurnClaim {
    readonly inscriptionId: string;
    readonly collectionName: string;
    readonly tokenId: number;
    readonly senderAddress: string;
    readonly burnTxid: string;
    readonly burnBlockHeight: number;
    readonly burnBlockHash: string;
    readonly status: BurnClaimStatus;
    readonly attestTxid: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/**
 * Database row shape for burn_claims table
 */
export interface BurnClaimRow {
    readonly inscription_id: string;
    readonly collection_name: string;
    readonly token_id: number;
    readonly sender_address: string;
    readonly burn_txid: string;
    readonly burn_block_height: number;
    readonly burn_block_hash: string;
    readonly status: string;
    readonly attest_txid: string | null;
    readonly created_at: string;
    readonly updated_at: string;
}

/**
 * Bridge configuration extending the base plugin config.
 */
export interface BridgeConfig {
    readonly burnAddress: string;
    readonly collectionFile: string;
    readonly collectionName: string;
    readonly collectionSymbol: string;
    readonly confirmations: number;
}
