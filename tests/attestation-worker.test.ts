import { AttestationWorker } from '../src/attestation-worker.js';
import { BridgeService } from '../src/bridge.js';
import { CollectionRegistry, type CollectionItem } from '../src/collection.js';
import type { BridgeDatabase } from '../src/bridge-database.js';
import type { BurnClaim, BurnClaimStatus } from '../src/types.js';
import { address as btcAddress } from '@btc-vision/bitcoin';

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
    describe('hashInscriptionId', () => {
        it('should return a bigint hash for a given inscription ID', () => {
            const hash = AttestationWorker.hashInscriptionId(`${TXID_A}i0`);
            expect(typeof hash).toBe('bigint');
            expect(hash).toBeGreaterThan(0n);
        });

        it('should return consistent hashes for the same input', () => {
            const inscriptionId = `${TXID_A}i5`;
            const hash1 = AttestationWorker.hashInscriptionId(inscriptionId);
            const hash2 = AttestationWorker.hashInscriptionId(inscriptionId);
            expect(hash1).toBe(hash2);
        });

        it('should return different hashes for different inputs', () => {
            const hash1 = AttestationWorker.hashInscriptionId(`${TXID_A}i0`);
            const hash2 = AttestationWorker.hashInscriptionId(`${TXID_A}i1`);
            expect(hash1).not.toBe(hash2);
        });

        it('should produce a 256-bit hash', () => {
            const hash = AttestationWorker.hashInscriptionId(`${TXID_A}i0`);
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

        it('should not include underpaid claims in attestation queue', async () => {
            const collection = new CollectionRegistry('TestCats', 'TCAT');
            collection.loadItems(createSampleCollection(100));
            const db = new MockBridgeDatabase();
            const bridge = new BridgeService(
                collection,
                db as unknown as BridgeDatabase,
                BURN_ADDRESS,
                6,
                10000, // minFeeSats
            );

            // Insert an underpaid burn
            await bridge.processBurn({
                txid: TXID_B,
                inscriptionId: `${TXID_A}i1`,
                senderAddress: 'bc1qsender',
                blockHeight: 100,
                blockHash: 'c'.repeat(64),
                feePaid: 5000, // less than 10000
            });

            // Confirm any pending (should be 0 since underpaid doesn't get confirmed)
            await bridge.confirmPendingClaims(106);

            const ready = await bridge.getClaimsReadyForAttestation();
            expect(ready).toHaveLength(0);
        });

        it('should track claim lifecycle: detected → confirmed → attested', async () => {
            const { bridge, db } = createBridgeAndDb();

            // Step 1: Detect
            await bridge.processBurn({
                txid: TXID_B,
                inscriptionId: `${TXID_A}i5`,
                senderAddress: 'bc1qsender',
                blockHeight: 100,
                blockHash: 'c'.repeat(64),
            });

            let claim = await bridge.getClaimStatus(`${TXID_A}i5`);
            expect(claim!.status).toBe('detected');

            // Step 2: Confirm
            await bridge.confirmPendingClaims(106);
            claim = await bridge.getClaimStatus(`${TXID_A}i5`);
            expect(claim!.status).toBe('confirmed');

            // Step 3: Attest
            const attestTxid = 'e'.repeat(64);
            await bridge.markAttested(`${TXID_A}i5`, attestTxid);
            claim = await bridge.getClaimStatus(`${TXID_A}i5`);
            expect(claim!.status).toBe('attested');
            expect(claim!.attestTxid).toBe(attestTxid);
        });

        it('should track claim lifecycle: detected → confirmed → failed → retry → confirmed', async () => {
            const { bridge, db } = createBridgeAndDb();

            await bridge.processBurn({
                txid: TXID_B,
                inscriptionId: `${TXID_A}i7`,
                senderAddress: 'bc1qsender',
                blockHeight: 100,
                blockHash: 'c'.repeat(64),
            });

            await bridge.confirmPendingClaims(106);
            await bridge.markFailed(`${TXID_A}i7`);

            let claim = await bridge.getClaimStatus(`${TXID_A}i7`);
            expect(claim!.status).toBe('failed');

            // Retry: resets back to confirmed
            const retried = await bridge.retryFailedClaims();
            expect(retried).toBe(1);

            claim = await bridge.getClaimStatus(`${TXID_A}i7`);
            expect(claim!.status).toBe('confirmed');

            // Should now be back in the attestation queue
            const ready = await bridge.getClaimsReadyForAttestation();
            expect(ready).toHaveLength(1);
            expect(ready[0].inscriptionId).toBe(`${TXID_A}i7`);
        });
    });

    describe('bech32ToAddress', () => {
        it('should convert a valid regtest bech32m p2tr address to an Address', () => {
            // Generate a valid regtest p2tr address from a known 32-byte witness program
            const witnessProgram = Buffer.alloc(32, 0xab);
            const bech32Addr = btcAddress.toBech32(witnessProgram, 1, 'bcrt');

            const address = AttestationWorker.bech32ToAddress(bech32Addr);

            // The Address should wrap the same 32-byte witness program
            expect(address).toHaveLength(32);
            expect(Buffer.from(address).toString('hex')).toBe(witnessProgram.toString('hex'));
        });

        it('should convert a valid mainnet bech32m p2tr address', () => {
            const witnessProgram = Buffer.alloc(32, 0xcd);
            const bech32Addr = btcAddress.toBech32(witnessProgram, 1, 'bc');

            const address = AttestationWorker.bech32ToAddress(bech32Addr);
            expect(address).toHaveLength(32);
            expect(Buffer.from(address).toString('hex')).toBe(witnessProgram.toString('hex'));
        });

        it('should throw for an invalid bech32 address', () => {
            expect(() => {
                AttestationWorker.bech32ToAddress('not-a-valid-address');
            }).toThrow();
        });

        it('should produce different addresses for different inputs', () => {
            const wp1 = Buffer.alloc(32, 0x01);
            const wp2 = Buffer.alloc(32, 0x02);
            const addr1 = btcAddress.toBech32(wp1, 1, 'bcrt');
            const addr2 = btcAddress.toBech32(wp2, 1, 'bcrt');

            const a1 = AttestationWorker.bech32ToAddress(addr1);
            const a2 = AttestationWorker.bech32ToAddress(addr2);

            expect(Buffer.from(a1).toString('hex')).not.toBe(
                Buffer.from(a2).toString('hex'),
            );
        });
    });

    describe('hashInscriptionId (extended)', () => {
        it('should handle empty string input', () => {
            const hash = AttestationWorker.hashInscriptionId('');
            expect(typeof hash).toBe('bigint');
            // keccak256 of empty string is a known constant
            expect(hash).toBeGreaterThan(0n);
        });

        it('should handle very long inscription IDs', () => {
            const longId = 'x'.repeat(10000) + 'i0';
            const hash = AttestationWorker.hashInscriptionId(longId);
            expect(typeof hash).toBe('bigint');
            expect(hash).toBeGreaterThan(0n);
        });

        it('should fit within u256 range', () => {
            const hash = AttestationWorker.hashInscriptionId(`${TXID_A}i0`);
            const max256 = (1n << 256n) - 1n;
            expect(hash).toBeLessThanOrEqual(max256);
            expect(hash).toBeGreaterThan(0n);
        });
    });
});
