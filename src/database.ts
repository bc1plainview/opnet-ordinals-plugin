import { Pool, type QueryResult } from 'pg';
import { Logger } from '@btc-vision/logger';
import type { Inscription, InscriptionRow } from './types.js';

/**
 * Database layer for storing Ordinals inscriptions
 */
export class InscriptionDatabase {
    private readonly pool: Pool;
    private readonly logger: Logger = new Logger();

    public constructor(connectionString: string) {
        this.pool = new Pool({
            connectionString,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        this.pool.on('error', (err: Error) => {
            this.logger.error(`Unexpected database error: ${err.message}`);
        });
    }

    /**
     * Initialize database schema
     */
    public async initialize(): Promise<void> {
        try {
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS inscriptions (
                    id TEXT PRIMARY KEY,
                    content_type TEXT NOT NULL,
                    content BYTEA NOT NULL,
                    block_height INTEGER NOT NULL,
                    block_hash TEXT NOT NULL,
                    txid TEXT NOT NULL,
                    vout INTEGER NOT NULL,
                    owner TEXT NOT NULL,
                    timestamp BIGINT NOT NULL,
                    inscription_number INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW()
                );

                CREATE INDEX IF NOT EXISTS idx_inscriptions_owner
                    ON inscriptions(owner);

                CREATE INDEX IF NOT EXISTS idx_inscriptions_block_height
                    ON inscriptions(block_height);

                CREATE INDEX IF NOT EXISTS idx_inscriptions_inscription_number
                    ON inscriptions(inscription_number);

                CREATE INDEX IF NOT EXISTS idx_inscriptions_txid
                    ON inscriptions(txid);

                CREATE INDEX IF NOT EXISTS idx_inscriptions_content_type
                    ON inscriptions(content_type);

                CREATE INDEX IF NOT EXISTS idx_inscriptions_timestamp
                    ON inscriptions(timestamp DESC);
            `);

            this.logger.info('Database schema initialized');
        } catch (error) {
            this.logger.error(`Failed to initialize database: ${String(error)}`);
            throw error;
        }
    }

    /**
     * Save an inscription to the database
     */
    public async save(inscription: Inscription): Promise<void> {
        try {
            await this.pool.query(
                `INSERT INTO inscriptions (
                    id, content_type, content, block_height, block_hash,
                    txid, vout, owner, timestamp, inscription_number
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (id) DO NOTHING`,
                [
                    inscription.id,
                    inscription.contentType,
                    inscription.content,
                    inscription.blockHeight,
                    inscription.blockHash,
                    inscription.txid,
                    inscription.vout,
                    inscription.owner,
                    inscription.timestamp,
                    inscription.inscriptionNumber,
                ]
            );
        } catch (error) {
            this.logger.error(`Failed to save inscription ${inscription.id}: ${String(error)}`);
            throw error;
        }
    }

    /**
     * Get inscription by ID
     */
    public async getById(id: string): Promise<Inscription | null> {
        try {
            const result: QueryResult = await this.pool.query(
                'SELECT * FROM inscriptions WHERE id = $1',
                [id]
            );

            if (result.rows.length === 0) {
                return null;
            }

            return this.rowToInscription(result.rows[0]);
        } catch (error) {
            this.logger.error(`Failed to get inscription ${id}: ${String(error)}`);
            return null;
        }
    }

    /**
     * Get inscriptions by owner address
     */
    public async getByOwner(owner: string, limit: number = 100, offset: number = 0): Promise<Inscription[]> {
        try {
            const result: QueryResult = await this.pool.query(
                `SELECT * FROM inscriptions
                WHERE owner = $1
                ORDER BY inscription_number DESC
                LIMIT $2 OFFSET $3`,
                [owner, limit, offset]
            );

            return result.rows.map((row) => this.rowToInscription(row));
        } catch (error) {
            this.logger.error(`Failed to get inscriptions for owner ${owner}: ${String(error)}`);
            return [];
        }
    }

    /**
     * Get latest inscriptions
     */
    public async getLatest(limit: number = 20): Promise<Inscription[]> {
        try {
            const result: QueryResult = await this.pool.query(
                `SELECT * FROM inscriptions
                ORDER BY inscription_number DESC
                LIMIT $1`,
                [limit]
            );

            return result.rows.map((row) => this.rowToInscription(row));
        } catch (error) {
            this.logger.error(`Failed to get latest inscriptions: ${String(error)}`);
            return [];
        }
    }

    /**
     * Get inscriptions by content type
     */
    public async getByContentType(contentType: string, limit: number = 100): Promise<Inscription[]> {
        try {
            const result: QueryResult = await this.pool.query(
                `SELECT * FROM inscriptions
                WHERE content_type = $1
                ORDER BY inscription_number DESC
                LIMIT $2`,
                [contentType, limit]
            );

            return result.rows.map((row) => this.rowToInscription(row));
        } catch (error) {
            this.logger.error(`Failed to get inscriptions of type ${contentType}: ${String(error)}`);
            return [];
        }
    }

    /**
     * Get total inscription count
     */
    public async getCount(): Promise<number> {
        try {
            const result: QueryResult = await this.pool.query(
                'SELECT COUNT(*) as count FROM inscriptions'
            );
            return parseInt(result.rows[0].count, 10);
        } catch (error) {
            this.logger.error(`Failed to get inscription count: ${String(error)}`);
            return 0;
        }
    }

    /**
     * Delete inscriptions from a specific height (for reorg handling)
     */
    public async deleteFromHeight(height: number): Promise<number> {
        try {
            const result: QueryResult = await this.pool.query(
                'DELETE FROM inscriptions WHERE block_height >= $1',
                [height]
            );
            const deletedCount = result.rowCount || 0;
            this.logger.info(`Deleted ${deletedCount} inscriptions from height ${height}`);
            return deletedCount;
        } catch (error) {
            this.logger.error(`Failed to delete inscriptions from height ${height}: ${String(error)}`);
            return 0;
        }
    }

    /**
     * Get statistics
     */
    public async getStats(): Promise<{
        totalInscriptions: number;
        totalOwners: number;
        contentTypes: Record<string, number>;
    }> {
        try {
            const [countResult, ownersResult, typesResult] = await Promise.all([
                this.pool.query('SELECT COUNT(*) as count FROM inscriptions'),
                this.pool.query('SELECT COUNT(DISTINCT owner) as count FROM inscriptions'),
                this.pool.query(`
                    SELECT content_type, COUNT(*) as count
                    FROM inscriptions
                    GROUP BY content_type
                    ORDER BY count DESC
                `),
            ]);

            const contentTypes: Record<string, number> = {};
            for (const row of typesResult.rows) {
                contentTypes[row.content_type] = parseInt(row.count, 10);
            }

            return {
                totalInscriptions: parseInt(countResult.rows[0].count, 10),
                totalOwners: parseInt(ownersResult.rows[0].count, 10),
                contentTypes,
            };
        } catch (error) {
            this.logger.error(`Failed to get stats: ${String(error)}`);
            return {
                totalInscriptions: 0,
                totalOwners: 0,
                contentTypes: {},
            };
        }
    }

    /**
     * Close database connection
     */
    public async close(): Promise<void> {
        await this.pool.end();
        this.logger.info('Database connection closed');
    }

    /**
     * Convert database row to Inscription object
     */
    private rowToInscription(row: InscriptionRow): Inscription {
        return {
            id: row.id,
            contentType: row.content_type,
            content: row.content,
            blockHeight: row.block_height,
            blockHash: row.block_hash,
            txid: row.txid,
            vout: row.vout,
            owner: row.owner,
            timestamp: parseInt(row.timestamp, 10),
            inscriptionNumber: row.inscription_number,
        };
    }
}
