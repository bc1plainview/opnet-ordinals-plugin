import { BridgeService, type DetectedBurn } from '../src/bridge.js';
import { CollectionRegistry, type CollectionItem } from '../src/collection.js';
import type { BridgeDatabase } from '../src/bridge-database.js';
import type { BurnClaim, BurnClaimStatus } from '../src/types.js';

/**
 * Unit tests for the BridgeService.
 *
 * Uses a mock BridgeDatabase to test the oracle logic in isolation.
 */

// ------------------------------------------------------------------
// Mock BridgeDatabase
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
            const updated: BurnClaim = {
                ...claim,
                status,
                attestTxid: attestTxid ?? claim.attestTxid,
                updatedAt: Date.now(),
            };
            this.claims.set(inscriptionId, updated);
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
    }> {
        const stats = { total: 0, detected: 0, confirmed: 0, attested: 0, failed: 0 };
        for (const claim of this.claims.values()) {
            stats.total++;
            stats[claim.status]++;
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

function createBurn(inscriptionIndex: number, blockHeight: number = 100): DetectedBurn {
    return {
        txid: TXID_B,
        inscriptionId: `${TXID_A}i${inscriptionIndex}`,
        senderAddress: 'bc1qsender',
        blockHeight,
        blockHash: 'c'.repeat(64),
    };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('BridgeService', () => {
    let collection: CollectionRegistry;
    let mockDb: MockBridgeDatabase;
    let bridge: BridgeService;

    beforeEach(() => {
        collection = new CollectionRegistry('TestCats', 'TCAT');
        collection.loadItems(createSampleCollection(100));

        mockDb = new MockBridgeDatabase();
        bridge = new BridgeService(
            collection,
            mockDb as unknown as BridgeDatabase,
            BURN_ADDRESS,
            6,
        );
    });

    describe('processBurn', () => {
        it('should accept a burn of a collection inscription', async () => {
            const burn = createBurn(5);
            const result = await bridge.processBurn(burn);

            expect(result).not.toBeNull();
            expect(result!.tokenId).toBe(5);
            expect(result!.meta.name).toBe('#0005');

            // Should have created a claim in the database
            const claim = await bridge.getClaimStatus(`${TXID_A}i5`);
            expect(claim).not.toBeNull();
            expect(claim!.status).toBe('detected');
            expect(claim!.senderAddress).toBe('bc1qsender');
            expect(claim!.tokenId).toBe(5);
        });

        it('should reject a burn of an inscription not in the collection', async () => {
            const burn: DetectedBurn = {
                txid: TXID_B,
                inscriptionId: 'f'.repeat(64) + 'i0',
                senderAddress: 'bc1qsender',
                blockHeight: 100,
                blockHash: 'c'.repeat(64),
            };

            const result = await bridge.processBurn(burn);
            expect(result).toBeNull();

            // No claim should exist
            expect(mockDb.claims.size).toBe(0);
        });

        it('should reject a duplicate burn for the same inscription', async () => {
            const burn = createBurn(3);

            // First burn succeeds
            const first = await bridge.processBurn(burn);
            expect(first).not.toBeNull();

            // Second burn is rejected
            const second = await bridge.processBurn(burn);
            expect(second).toBeNull();

            // Only one claim exists
            expect(mockDb.claims.size).toBe(1);
        });

        it('should handle multiple different inscription burns', async () => {
            await bridge.processBurn(createBurn(0));
            await bridge.processBurn(createBurn(50));
            await bridge.processBurn(createBurn(99));

            expect(mockDb.claims.size).toBe(3);
        });
    });

    describe('confirmPendingClaims', () => {
        it('should confirm claims with enough confirmations', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.processBurn(createBurn(2, 100));

            // At height 105, only 5 confirmations — not enough
            let confirmed = await bridge.confirmPendingClaims(105);
            expect(confirmed).toBe(0);

            // At height 106, 6 confirmations — should confirm
            confirmed = await bridge.confirmPendingClaims(106);
            expect(confirmed).toBe(2);

            // Verify status changed
            const claim1 = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim1!.status).toBe('confirmed');
        });

        it('should not re-confirm already confirmed claims', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.confirmPendingClaims(106);

            // Second confirmation attempt should find no detected claims
            const confirmed = await bridge.confirmPendingClaims(110);
            expect(confirmed).toBe(0);
        });

        it('should handle claims at different heights', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.processBurn(createBurn(2, 103));

            // At height 106: inscription 1 has 6 confirmations, inscription 2 has 3
            const confirmed = await bridge.confirmPendingClaims(106);
            expect(confirmed).toBe(1);

            const claim1 = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim1!.status).toBe('confirmed');

            const claim2 = await bridge.getClaimStatus(`${TXID_A}i2`);
            expect(claim2!.status).toBe('detected');
        });
    });

    describe('getClaimsReadyForAttestation', () => {
        it('should return only confirmed claims', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.processBurn(createBurn(2, 100));
            await bridge.confirmPendingClaims(106);

            // Add one more that isn't confirmed yet
            await bridge.processBurn(createBurn(3, 105));

            const ready = await bridge.getClaimsReadyForAttestation();
            expect(ready).toHaveLength(2);
            expect(ready.every((c) => c.status === 'confirmed')).toBe(true);
        });
    });

    describe('markAttested', () => {
        it('should update claim status to attested with txid', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.confirmPendingClaims(106);

            const attestTxid = 'd'.repeat(64);
            await bridge.markAttested(`${TXID_A}i1`, attestTxid);

            const claim = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim!.status).toBe('attested');
            expect(claim!.attestTxid).toBe(attestTxid);
        });
    });

    describe('markFailed', () => {
        it('should update claim status to failed', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.confirmPendingClaims(106);

            await bridge.markFailed(`${TXID_A}i1`);

            const claim = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim!.status).toBe('failed');
        });
    });

    describe('retryFailedClaims', () => {
        it('should reset failed claims to confirmed', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.confirmPendingClaims(106);
            await bridge.markFailed(`${TXID_A}i1`);

            const retried = await bridge.retryFailedClaims();
            expect(retried).toBe(1);

            const claim = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim!.status).toBe('confirmed');
        });

        it('should return 0 when no failed claims exist', async () => {
            const retried = await bridge.retryFailedClaims();
            expect(retried).toBe(0);
        });
    });

    describe('getClaimsBySender', () => {
        it('should return claims for a specific sender', async () => {
            await bridge.processBurn(createBurn(1));
            await bridge.processBurn(createBurn(2));

            const claims = await bridge.getClaimsBySender('bc1qsender');
            expect(claims).toHaveLength(2);
        });

        it('should return empty array for unknown sender', async () => {
            const claims = await bridge.getClaimsBySender('bc1qunknown');
            expect(claims).toHaveLength(0);
        });
    });

    describe('getStats', () => {
        it('should return accurate statistics', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.processBurn(createBurn(2, 100));
            await bridge.processBurn(createBurn(3, 100));
            await bridge.confirmPendingClaims(106);
            await bridge.markAttested(`${TXID_A}i1`, 'd'.repeat(64));
            await bridge.markFailed(`${TXID_A}i2`);

            const stats = await bridge.getStats();
            expect(stats.total).toBe(3);
            expect(stats.confirmed).toBe(1); // #3 is confirmed
            expect(stats.attested).toBe(1);  // #1 is attested
            expect(stats.failed).toBe(1);    // #2 is failed
            expect(stats.collectionSize).toBe(100);
            expect(stats.burnAddress).toBe(BURN_ADDRESS);
            expect(stats.requiredConfirmations).toBe(6);
        });
    });

    describe('isInCollection', () => {
        it('should return true for collection inscriptions', () => {
            expect(bridge.isInCollection(`${TXID_A}i0`)).toBe(true);
            expect(bridge.isInCollection(`${TXID_A}i99`)).toBe(true);
        });

        it('should return false for non-collection inscriptions', () => {
            expect(bridge.isInCollection('unknown')).toBe(false);
            expect(bridge.isInCollection(`${TXID_A}i100`)).toBe(false);
        });
    });

    describe('handleReorg', () => {
        it('should delete unconfirmed claims from reorged heights', async () => {
            await bridge.processBurn(createBurn(1, 100));
            await bridge.processBurn(createBurn(2, 105));
            await bridge.processBurn(createBurn(3, 110));

            // Reorg at height 106 should only delete claim at 110
            const deleted = await bridge.handleReorg(106);
            expect(deleted).toBe(1); // Only the one at height 110

            // Claim at 100 and 105 should still exist
            const claim1 = await bridge.getClaimStatus(`${TXID_A}i1`);
            expect(claim1).not.toBeNull();

            const claim2 = await bridge.getClaimStatus(`${TXID_A}i2`);
            expect(claim2).not.toBeNull();

            // Claim at 110 should be gone
            const claim3 = await bridge.getClaimStatus(`${TXID_A}i3`);
            expect(claim3).toBeNull();
        });
    });

    describe('getBurnAddress', () => {
        it('should return the configured burn address', () => {
            expect(bridge.getBurnAddress()).toBe(BURN_ADDRESS);
        });
    });

    describe('getCollection', () => {
        it('should return the collection registry', () => {
            const coll = bridge.getCollection();
            expect(coll.getName()).toBe('TestCats');
            expect(coll.size).toBe(100);
        });
    });
});
