import { Pool, type QueryResult } from 'pg';
import { Logger } from '@btc-vision/logger';
import type { BurnClaim, BurnClaimRow, BurnClaimStatus } from './types.js';

/**
 * Database layer for the Ordinals-to-OP721 bridge.
 * Tracks burn claims through their lifecycle:
 * detected -> confirmed -> attested (or failed).
 */
export class BridgeDatabase {
    private readonly pool: Pool;
    private readonly logger: Logger = new Logger();

    public constructor(pool: Pool) {
        this.pool = pool;
    }

    /**
     * Create the burn_claims table if it doesn't exist.
     */
    public async initialize(): Promise<void> {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS burn_claims (
                inscription_id TEXT PRIMARY KEY,
                collection_name TEXT NOT NULL,
                token_id INTEGER NOT NULL,
                sender_address TEXT NOT NULL,
                burn_txid TEXT NOT NULL,
                burn_block_height INTEGER NOT NULL,
                burn_block_hash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'detected',
                attest_txid TEXT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_burn_claims_status
                ON burn_claims(status);

            CREATE INDEX IF NOT EXISTS idx_burn_claims_sender
                ON burn_claims(sender_address);

            CREATE INDEX IF NOT EXISTS idx_burn_claims_collection
                ON burn_claims(collection_name);

            CREATE INDEX IF NOT EXISTS idx_burn_claims_burn_block_height
                ON burn_claims(burn_block_height);
        `);

        this.logger.info('Bridge database schema initialized');
    }

    /**
     * Insert a new burn claim with status "detected".
     */
    public async insertClaim(claim: BurnClaim): Promise<void> {
        await this.pool.query(
            `INSERT INTO burn_claims (
                inscription_id, collection_name, token_id,
                sender_address, burn_txid, burn_block_height,
                burn_block_hash, status, attest_txid,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (inscription_id) DO NOTHING`,
            [
                claim.inscriptionId,
                claim.collectionName,
                claim.tokenId,
                claim.senderAddress,
                claim.burnTxid,
                claim.burnBlockHeight,
                claim.burnBlockHash,
                claim.status,
                claim.attestTxid,
                claim.createdAt,
                claim.updatedAt,
            ],
        );
    }

    /**
     * Update the status of a burn claim.
     */
    public async updateStatus(
        inscriptionId: string,
        status: BurnClaimStatus,
        attestTxid?: string,
    ): Promise<void> {
        const now = Date.now();
        if (attestTxid !== undefined) {
            await this.pool.query(
                `UPDATE burn_claims
                 SET status = $1, attest_txid = $2, updated_at = $3
                 WHERE inscription_id = $4`,
                [status, attestTxid, now, inscriptionId],
            );
        } else {
            await this.pool.query(
                `UPDATE burn_claims
                 SET status = $1, updated_at = $2
                 WHERE inscription_id = $3`,
                [status, now, inscriptionId],
            );
        }
    }

    /**
     * Get a burn claim by inscription ID.
     */
    public async getByInscriptionId(inscriptionId: string): Promise<BurnClaim | null> {
        const result: QueryResult = await this.pool.query(
            'SELECT * FROM burn_claims WHERE inscription_id = $1',
            [inscriptionId],
        );

        if (result.rows.length === 0) {
            return null;
        }

        return this.rowToClaim(result.rows[0] as BurnClaimRow);
    }

    /**
     * Get all claims with a given status.
     */
    public async getByStatus(status: BurnClaimStatus, limit: number = 100): Promise<BurnClaim[]> {
        const result: QueryResult = await this.pool.query(
            `SELECT * FROM burn_claims
             WHERE status = $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [status, limit],
        );

        return result.rows.map((row: BurnClaimRow) => this.rowToClaim(row));
    }

    /**
     * Get all claims for a given sender address.
     */
    public async getBySender(
        senderAddress: string,
        limit: number = 100,
        offset: number = 0,
    ): Promise<BurnClaim[]> {
        const result: QueryResult = await this.pool.query(
            `SELECT * FROM burn_claims
             WHERE sender_address = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [senderAddress, limit, offset],
        );

        return result.rows.map((row: BurnClaimRow) => this.rowToClaim(row));
    }

    /**
     * Get bridge statistics.
     */
    public async getStats(): Promise<{
        total: number;
        detected: number;
        confirmed: number;
        attested: number;
        failed: number;
    }> {
        const result: QueryResult = await this.pool.query(
            `SELECT status, COUNT(*) as count
             FROM burn_claims
             GROUP BY status`,
        );

        const stats = { total: 0, detected: 0, confirmed: 0, attested: 0, failed: 0 };
        for (const row of result.rows) {
            const count = parseInt(row.count as string, 10);
            stats.total += count;
            const status = row.status as BurnClaimStatus;
            if (status in stats) {
                stats[status] = count;
            }
        }
        return stats;
    }

    /**
     * Delete claims from a given block height (for reorg handling).
     */
    public async deleteFromHeight(height: number): Promise<number> {
        const result: QueryResult = await this.pool.query(
            `DELETE FROM burn_claims
             WHERE burn_block_height >= $1 AND status = 'detected'`,
            [height],
        );
        return result.rowCount ?? 0;
    }

    /**
     * Check if an inscription has already been claimed.
     */
    public async isClaimed(inscriptionId: string): Promise<boolean> {
        const result: QueryResult = await this.pool.query(
            'SELECT 1 FROM burn_claims WHERE inscription_id = $1',
            [inscriptionId],
        );
        return result.rows.length > 0;
    }

    private rowToClaim(row: BurnClaimRow): BurnClaim {
        return {
            inscriptionId: row.inscription_id,
            collectionName: row.collection_name,
            tokenId: row.token_id,
            senderAddress: row.sender_address,
            burnTxid: row.burn_txid,
            burnBlockHeight: row.burn_block_height,
            burnBlockHash: row.burn_block_hash,
            status: row.status as BurnClaimStatus,
            attestTxid: row.attest_txid,
            createdAt: parseInt(row.created_at, 10),
            updatedAt: parseInt(row.updated_at, 10),
        };
    }
}
