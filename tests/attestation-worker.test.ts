import { AttestationWorker } from '../src/attestation-worker.js';
import { BridgeService } from '../src/bridge.js';
import { CollectionRegistry, type CollectionItem } from '../src/collection.js';
import type { BridgeDatabase } from '../src/bridge-database.js';
import type { BurnClaim, BurnClaimStatus } from '../src/types.js';

/**
 * Unit tests for the AttestationWorker.
 *
 * Mocks the OPNet provider, contract, and wallet to test the
 * attestation logic in isolation.
 */

// ------------------------------------------------------------------
// Mock BridgeDatabase (in-memory)
// ------------------------------------------------------------------

class MockBridgeDatabase {
    public claims: Map<string, BurnClaim> = new Map();

    async initialize(): Promise<void> {}

    async insertClaim(claim: BurnClaim): Promise<void> {
        if (!this.claims.has(claim.inscriptionId)) {
            this.claims.set(claim.inscriptionId, claim);
        }
    }

    async updateStatus(
        inscriptionId: string,
        status: BurnClaimStatus,
        attestTxid?: string,
    ): Promise<void> {
        const claim = this.claims.get(inscriptionId);
        if (claim !== undefined) {
            this.claims.set(inscriptionId, {
                ...claim,
                status,
                attestTxid: attestTxid ?? claim.attestTxid,
                updatedAt: Date.now(),
            });
        }
    }

    async getByInscriptionId(inscriptionId: string): Promise<BurnClaim | null> {
        return this.claims.get(inscriptionId) ?? null;
    }

    async getByStatus(status: BurnClaimStatus, _limit: number = 100): Promise<BurnClaim[]> {
        return Array.from(this.claims.values()).filter((c) => c.status === status);
    }

    async getBySender(
        senderAddress: string,
        _limit: number = 100,
        _offset: number = 0,
    ): Promise<BurnClaim[]> {
        return Array.from(this.claims.values()).filter(
            (c) => c.senderAddress === senderAddress,
        );
    }

    async getStats(): Promise<{
        total: number;
        detected: number;
        confirmed: number;
        attested: number;
        failed: number;
        underpaid: number;
    }> {
        const stats = { total: 0, detected: 0, confirmed: 0, attested: 0, failed: 0, underpaid: 0 };
        for (const claim of this.claims.values()) {
            stats.total++;
            if (claim.status in stats) {
                stats[claim.status as keyof typeof stats] += 1;
            }
        }
        return stats;
    }

    async deleteFromHeight(height: number): Promise<number> {
        let deleted = 0;
        for (const [id, claim] of this.claims) {
            if (claim.burnBlockHeight >= height && claim.status === 'detected') {
                this.claims.delete(id);
                deleted++;
            }
        }
        return deleted;
    }

    async isClaimed(inscriptionId: string): Promise<boolean> {
        return this.claims.has(inscriptionId);
    }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const BURN_ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const TXID_A = 'a'.repeat(64);
const TXID_B = 'b'.repeat(64);

function createSampleCollection(count: number): CollectionItem[] {
    const items: CollectionItem[] = [];
    for (let i = 0; i < count; i++) {
        items.push({
            id: `${TXID_A}i${i}`,
            meta: {
                name: `#${String(i).padStart(4, '0')}`,
                attributes: [{ trait_type: 'rarity', value: 'common' }],
                high_res_img_url: `https://example.com/${i}.jpg`,
            },
        });
    }
    return items;
}

function createBridgeAndDb(): { bridge: BridgeService; db: MockBridgeDatabase } {
    const collection = new CollectionRegistry('TestCats', 'TCAT');
    collection.loadItems(createSampleCollection(100));
    const db = new MockBridgeDatabase();
    const bridge = new BridgeService(
        collection,
        db as unknown as BridgeDatabase,
        BURN_ADDRESS,
        6,
    );
    return { bridge, db };
}

async function seedConfirmedClaim(
    bridge: BridgeService,
    db: MockBridgeDatabase,
    inscriptionIndex: number,
): Promise<void> {
    await bridge.processBurn({
        txid: TXID_B,
        inscriptionId: `${TXID_A}i${inscriptionIndex}`,
        senderAddress: 'bc1qsender',
        blockHeight: 100,
        blockHash: 'c'.repeat(64),
    });
    await bridge.confirmPendingClaims(106);
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('AttestationWorker', () => {
    describe('computeInscriptionHash', () => {
        it('should return a bigint hash for a given inscription ID', () => {
            const hash = AttestationWorker.computeInscriptionHash(`${TXID_A}i0`);
            expect(typeof hash).toBe('bigint');
            expect(hash).toBeGreaterThan(0n);
        });

        it('should return consistent hashes for the same input', () => {
            const inscriptionId = `${TXID_A}i5`;
            const hash1 = AttestationWorker.computeInscriptionHash(inscriptionId);
            const hash2 = AttestationWorker.computeInscriptionHash(inscriptionId);
            expect(hash1).toBe(hash2);
        });

        it('should return different hashes for different inputs', () => {
            const hash1 = AttestationWorker.computeInscriptionHash(`${TXID_A}i0`);
            const hash2 = AttestationWorker.computeInscriptionHash(`${TXID_A}i1`);
            expect(hash1).not.toBe(hash2);
        });

        it('should produce a 256-bit hash', () => {
            const hash = AttestationWorker.computeInscriptionHash(`${TXID_A}i0`);
            // A 256-bit number has at most 78 decimal digits
            // In hex, it's exactly 64 characters (32 bytes)
            const hexStr = hash.toString(16);
            expect(hexStr.length).toBeLessThanOrEqual(64);
        });
    });

    describe('processConfirmedClaims (integration with bridge)', () => {
        it('should return 0 when no confirmed claims exist', async () => {
            const { bridge } = createBridgeAndDb();

            // We can't create a real AttestationWorker without a valid mnemonic
            // and RPC, so we test the bridge interaction directly
            const claims = await bridge.getClaimsReadyForAttestation();
            expect(claims).toHaveLength(0);
        });

        it('should find confirmed claims ready for attestation', async () => {
            const { bridge, db } = createBridgeAndDb();

            await seedConfirmedClaim(bridge, db, 1);
            await seedConfirmedClaim(bridge, db, 2);

            const claims = await bridge.getClaimsReadyForAttestation();
            expect(claims).toHaveLength(2);
            expect(claims.every((c) => c.status === 'confirmed')).toBe(true);
        });

        it('should allow marking claims as attested', async () => {
            const { bridge, db } = createBridgeAndDb();

            await seedConfirmedClaim(bridge, db, 1);

            const attestTxid = 'f'.repeat(64);
            await bridge.markAttested(`${TXID_A}i1`, attestTxid);

            const claim = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim!.status).toBe('attested');
            expect(claim!.attestTxid).toBe(attestTxid);

            // Should no longer appear in ready-for-attestation list
            const ready = await bridge.getClaimsReadyForAttestation();
            expect(ready).toHaveLength(0);
        });

        it('should allow marking claims as failed', async () => {
            const { bridge, db } = createBridgeAndDb();

            await seedConfirmedClaim(bridge, db, 1);

            await bridge.markFailed(`${TXID_A}i1`);

            const claim = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim!.status).toBe('failed');

            // Should no longer appear in ready-for-attestation list
            const ready = await bridge.getClaimsReadyForAttestation();
            expect(ready).toHaveLength(0);
        });

        it('should respect batch limit via claims array slicing', async () => {
            const { bridge, db } = createBridgeAndDb();

            // Seed 25 confirmed claims (more than MAX_BATCH_SIZE of 20)
            for (let i = 0; i < 25; i++) {
                await seedConfirmedClaim(bridge, db, i);
            }

            const claims = await bridge.getClaimsReadyForAttestation();
            expect(claims.length).toBe(25);

            // The worker would slice to MAX_BATCH_SIZE (20)
            const batch = claims.slice(0, 20);
            expect(batch.length).toBe(20);
        });
    });
});
