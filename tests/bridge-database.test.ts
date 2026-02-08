import { BridgeDatabase } from '../src/bridge-database.js';
import type { BurnClaim } from '../src/types.js';

/**
 * Unit tests for BridgeDatabase.
 *
 * Since we don't want to require a real PostgreSQL instance for unit tests,
 * these tests verify the SQL query construction and parameter passing by
 * mocking the pg Pool.
 */

// ------------------------------------------------------------------
// Mock pg Pool
// ------------------------------------------------------------------

interface MockQuery {
    text: string;
    values: unknown[];
}

class MockPool {
    public queries: MockQuery[] = [];
    public nextResult: { rows: unknown[]; rowCount: number } = { rows: [], rowCount: 0 };

    async query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
        this.queries.push({ text, values: values ?? [] });
        return this.nextResult;
    }

    async end(): Promise<void> {}

    on(_event: string, _handler: (err: Error) => void): void {}
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function createTestClaim(inscriptionId: string = 'abc123i0'): BurnClaim {
    return {
        inscriptionId,
        collectionName: 'TestCats',
        tokenId: 42,
        senderAddress: 'bc1qsender',
        burnTxid: 'b'.repeat(64),
        burnBlockHeight: 100,
        burnBlockHash: 'c'.repeat(64),
        status: 'detected',
        attestTxid: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
    };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('BridgeDatabase', () => {
    let pool: MockPool;
    let db: BridgeDatabase;

    beforeEach(() => {
        pool = new MockPool();
        // BridgeDatabase takes a Pool in its constructor
        db = new BridgeDatabase(pool as any);
    });

    describe('initialize', () => {
        it('should execute CREATE TABLE and CREATE INDEX statements', async () => {
            await db.initialize();

            expect(pool.queries).toHaveLength(1);
            const sql = pool.queries[0].text;
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS burn_claims');
            expect(sql).toContain('inscription_id TEXT PRIMARY KEY');
            expect(sql).toContain('idx_burn_claims_status');
            expect(sql).toContain('idx_burn_claims_sender');
            expect(sql).toContain('idx_burn_claims_collection');
            expect(sql).toContain('idx_burn_claims_burn_block_height');
        });
    });

    describe('insertClaim', () => {
        it('should insert a claim with all fields', async () => {
            const claim = createTestClaim();
            await db.insertClaim(claim);

            expect(pool.queries).toHaveLength(1);
            const query = pool.queries[0];
            expect(query.text).toContain('INSERT INTO burn_claims');
            expect(query.text).toContain('ON CONFLICT (inscription_id) DO NOTHING');
            expect(query.values).toEqual([
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
            ]);
        });
    });

    describe('updateStatus', () => {
        it('should update status without attestTxid', async () => {
            await db.updateStatus('abc123i0', 'confirmed');

            expect(pool.queries).toHaveLength(1);
            const query = pool.queries[0];
            expect(query.text).toContain('UPDATE burn_claims');
            expect(query.text).toContain('SET status = $1');
            expect(query.values[0]).toBe('confirmed');
            expect(query.values[2]).toBe('abc123i0');
        });

        it('should update status with attestTxid', async () => {
            const attestTxid = 'd'.repeat(64);
            await db.updateStatus('abc123i0', 'attested', attestTxid);

            expect(pool.queries).toHaveLength(1);
            const query = pool.queries[0];
            expect(query.text).toContain('attest_txid = $2');
            expect(query.values[0]).toBe('attested');
            expect(query.values[1]).toBe(attestTxid);
            expect(query.values[3]).toBe('abc123i0');
        });
    });

    describe('getByInscriptionId', () => {
        it('should return null when no rows found', async () => {
            pool.nextResult = { rows: [], rowCount: 0 };
            const result = await db.getByInscriptionId('nonexistent');
            expect(result).toBeNull();
        });

        it('should return a claim when found', async () => {
            pool.nextResult = {
                rows: [{
                    inscription_id: 'abc123i0',
                    collection_name: 'TestCats',
                    token_id: 42,
                    sender_address: 'bc1qsender',
                    burn_txid: 'b'.repeat(64),
                    burn_block_height: 100,
                    burn_block_hash: 'c'.repeat(64),
                    status: 'detected',
                    attest_txid: null,
                    created_at: '1700000000000',
                    updated_at: '1700000000000',
                }],
                rowCount: 1,
            };

            const result = await db.getByInscriptionId('abc123i0');
            expect(result).not.toBeNull();
            expect(result!.inscriptionId).toBe('abc123i0');
            expect(result!.collectionName).toBe('TestCats');
            expect(result!.tokenId).toBe(42);
            expect(result!.status).toBe('detected');
            expect(result!.createdAt).toBe(1700000000000);
        });
    });

    describe('getByStatus', () => {
        it('should query with status filter and limit', async () => {
            pool.nextResult = { rows: [], rowCount: 0 };
            await db.getByStatus('confirmed', 50);

            expect(pool.queries).toHaveLength(1);
            const query = pool.queries[0];
            expect(query.text).toContain("WHERE status = $1");
            expect(query.text).toContain('LIMIT $2');
            expect(query.values).toEqual(['confirmed', 50]);
        });
    });

    describe('getBySender', () => {
        it('should query with sender, limit, and offset', async () => {
            pool.nextResult = { rows: [], rowCount: 0 };
            await db.getBySender('bc1qsender', 25, 10);

            expect(pool.queries).toHaveLength(1);
            const query = pool.queries[0];
            expect(query.text).toContain("WHERE sender_address = $1");
            expect(query.text).toContain('LIMIT $2 OFFSET $3');
            expect(query.values).toEqual(['bc1qsender', 25, 10]);
        });
    });

    describe('getStats', () => {
        it('should aggregate counts by status', async () => {
            pool.nextResult = {
                rows: [
                    { status: 'detected', count: '5' },
                    { status: 'confirmed', count: '3' },
                    { status: 'attested', count: '10' },
                    { status: 'failed', count: '1' },
                ],
                rowCount: 4,
            };

            const stats = await db.getStats();
            expect(stats.total).toBe(19);
            expect(stats.detected).toBe(5);
            expect(stats.confirmed).toBe(3);
            expect(stats.attested).toBe(10);
            expect(stats.failed).toBe(1);
        });

        it('should handle empty database', async () => {
            pool.nextResult = { rows: [], rowCount: 0 };

            const stats = await db.getStats();
            expect(stats.total).toBe(0);
            expect(stats.detected).toBe(0);
        });
    });

    describe('deleteFromHeight', () => {
        it('should delete detected claims from the given height', async () => {
            pool.nextResult = { rows: [], rowCount: 3 };
            const deleted = await db.deleteFromHeight(500);

            expect(deleted).toBe(3);
            expect(pool.queries).toHaveLength(1);
            const query = pool.queries[0];
            expect(query.text).toContain('DELETE FROM burn_claims');
            expect(query.text).toContain("status = 'detected'");
            expect(query.values).toEqual([500]);
        });
    });

    describe('isClaimed', () => {
        it('should return true when inscription exists', async () => {
            pool.nextResult = { rows: [{ '?column?': 1 }], rowCount: 1 };
            const result = await db.isClaimed('abc123i0');
            expect(result).toBe(true);
        });

        it('should return false when inscription does not exist', async () => {
            pool.nextResult = { rows: [], rowCount: 0 };
            const result = await db.isClaimed('nonexistent');
            expect(result).toBe(false);
        });
    });
});
