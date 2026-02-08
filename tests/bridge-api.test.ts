import { BridgeAPI } from '../src/bridge-api.js';
import { BridgeService } from '../src/bridge.js';
import { CollectionRegistry, type CollectionItem } from '../src/collection.js';
import type { BridgeDatabase } from '../src/bridge-database.js';
import type { BurnClaim, BurnClaimStatus } from '../src/types.js';

/**
 * Unit tests for the BridgeAPI.
 *
 * Verifies that the API routes call the correct BridgeService methods
 * and return appropriate responses.
 */

// ------------------------------------------------------------------
// Minimal Express mock
// ------------------------------------------------------------------

type RouteHandler = (req: MockRequest, res: MockResponse) => void | Promise<void>;

interface MockRoute {
    method: string;
    path: string;
    handler: RouteHandler;
}

class MockApp {
    public routes: MockRoute[] = [];

    get(path: string, handler: RouteHandler): void {
        this.routes.push({ method: 'GET', path, handler });
    }

    post(path: string, handler: RouteHandler): void {
        this.routes.push({ method: 'POST', path, handler });
    }

    findRoute(method: string, path: string): MockRoute | undefined {
        return this.routes.find((r) => r.method === method && r.path === path);
    }
}

class MockRequest {
    public params: Record<string, string> = {};
    public query: Record<string, string> = {};
}

class MockResponse {
    public statusCode: number = 200;
    public body: unknown = null;

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    json(data: unknown): this {
        this.body = data;
        return this;
    }
}

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
        if (claim) {
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

    async getByStatus(status: BurnClaimStatus): Promise<BurnClaim[]> {
        return Array.from(this.claims.values()).filter((c) => c.status === status);
    }

    async getBySender(senderAddress: string): Promise<BurnClaim[]> {
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

    async deleteFromHeight(_height: number): Promise<number> {
        return 0;
    }

    async isClaimed(inscriptionId: string): Promise<boolean> {
        return this.claims.has(inscriptionId);
    }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const BURN_ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const TXID = 'a'.repeat(64);

function createSampleCollection(count: number): CollectionItem[] {
    const items: CollectionItem[] = [];
    for (let i = 0; i < count; i++) {
        items.push({
            id: `${TXID}i${i}`,
            meta: {
                name: `#${String(i).padStart(4, '0')}`,
                attributes: [{ trait_type: 'rarity', value: 'common' }],
                high_res_img_url: `https://example.com/${i}.jpg`,
            },
        });
    }
    return items;
}

function setup(): {
    app: MockApp;
    bridge: BridgeService;
    api: BridgeAPI;
    db: MockBridgeDatabase;
} {
    const collection = new CollectionRegistry('TestCats', 'TCAT');
    collection.loadItems(createSampleCollection(10));

    const db = new MockBridgeDatabase();
    const bridge = new BridgeService(
        collection,
        db as unknown as BridgeDatabase,
        BURN_ADDRESS,
        6,
    );

    const api = new BridgeAPI(bridge);
    const app = new MockApp();
    api.registerRoutes(app as any);

    return { app, bridge, api, db };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('BridgeAPI', () => {
    describe('registerRoutes', () => {
        it('should register all expected routes', () => {
            const { app } = setup();

            const paths = app.routes.map((r) => `${r.method} ${r.path}`);
            expect(paths).toContain('GET /bridge/stats');
            expect(paths).toContain('GET /bridge/claim/:inscriptionId');
            expect(paths).toContain('GET /bridge/claims/sender/:address');
            expect(paths).toContain('GET /bridge/collection/check/:inscriptionId');
            expect(paths).toContain('GET /bridge/collection');
            expect(paths).toContain('GET /bridge/collection/token/:tokenId');
            expect(paths).toContain('POST /bridge/retry-failed');
        });
    });

    describe('GET /bridge/stats', () => {
        it('should return bridge statistics', async () => {
            const { app } = setup();
            const route = app.findRoute('GET', '/bridge/stats')!;

            const req = new MockRequest();
            const res = new MockResponse();
            await route.handler(req, res);

            const body = res.body as Record<string, unknown>;
            expect(body.total).toBe(0);
            expect(body.collectionSize).toBe(10);
            expect(body.burnAddress).toBe(BURN_ADDRESS);
            expect(body.requiredConfirmations).toBe(6);
        });
    });

    describe('GET /bridge/claim/:inscriptionId', () => {
        it('should return 404 for unknown inscription', async () => {
            const { app } = setup();
            const route = app.findRoute('GET', '/bridge/claim/:inscriptionId')!;

            const req = new MockRequest();
            req.params.inscriptionId = 'nonexistent';
            const res = new MockResponse();
            await route.handler(req, res);

            expect(res.statusCode).toBe(404);
            const body = res.body as Record<string, unknown>;
            expect(body.error).toBe('No burn claim found for this inscription');
        });

        it('should return claim data when found', async () => {
            const { app, bridge } = setup();

            // Insert a claim
            await bridge.processBurn({
                txid: 'b'.repeat(64),
                inscriptionId: `${TXID}i3`,
                senderAddress: 'bc1qsender',
                blockHeight: 100,
                blockHash: 'c'.repeat(64),
            });

            const route = app.findRoute('GET', '/bridge/claim/:inscriptionId')!;
            const req = new MockRequest();
            req.params.inscriptionId = `${TXID}i3`;
            const res = new MockResponse();
            await route.handler(req, res);

            expect(res.statusCode).toBe(200);
            const body = res.body as Record<string, unknown>;
            expect(body.inscriptionId).toBe(`${TXID}i3`);
            expect(body.status).toBe('detected');
            expect(body.tokenId).toBe(3);
        });
    });

    describe('GET /bridge/collection/check/:inscriptionId', () => {
        it('should indicate if inscription is in collection', () => {
            const { app } = setup();
            const route = app.findRoute('GET', '/bridge/collection/check/:inscriptionId')!;

            // Check one that IS in the collection
            const req1 = new MockRequest();
            req1.params.inscriptionId = `${TXID}i5`;
            const res1 = new MockResponse();
            route.handler(req1, res1);

            const body1 = res1.body as Record<string, unknown>;
            expect(body1.inCollection).toBe(true);
            expect(body1.tokenId).toBe(5);

            // Check one that is NOT in the collection
            const req2 = new MockRequest();
            req2.params.inscriptionId = 'unknown';
            const res2 = new MockResponse();
            route.handler(req2, res2);

            const body2 = res2.body as Record<string, unknown>;
            expect(body2.inCollection).toBe(false);
            expect(body2.tokenId).toBeNull();
        });
    });

    describe('GET /bridge/collection', () => {
        it('should return collection metadata', () => {
            const { app } = setup();
            const route = app.findRoute('GET', '/bridge/collection')!;

            const req = new MockRequest();
            const res = new MockResponse();
            route.handler(req, res);

            const body = res.body as Record<string, unknown>;
            expect(body.name).toBe('TestCats');
            expect(body.symbol).toBe('TCAT');
            expect(body.size).toBe(10);
            expect(body.burnAddress).toBe(BURN_ADDRESS);
        });
    });

    describe('GET /bridge/collection/token/:tokenId', () => {
        it('should return token data for valid token ID', () => {
            const { app } = setup();
            const route = app.findRoute('GET', '/bridge/collection/token/:tokenId')!;

            const req = new MockRequest();
            req.params.tokenId = '3';
            const res = new MockResponse();
            route.handler(req, res);

            expect(res.statusCode).toBe(200);
            const body = res.body as Record<string, unknown>;
            expect(body.tokenId).toBe(3);
        });

        it('should return 400 for invalid token ID', () => {
            const { app } = setup();
            const route = app.findRoute('GET', '/bridge/collection/token/:tokenId')!;

            const req = new MockRequest();
            req.params.tokenId = 'abc';
            const res = new MockResponse();
            route.handler(req, res);

            expect(res.statusCode).toBe(400);
        });

        it('should return 404 for non-existent token ID', () => {
            const { app } = setup();
            const route = app.findRoute('GET', '/bridge/collection/token/:tokenId')!;

            const req = new MockRequest();
            req.params.tokenId = '999';
            const res = new MockResponse();
            route.handler(req, res);

            expect(res.statusCode).toBe(404);
        });
    });

    describe('POST /bridge/retry-failed', () => {
        it('should retry failed claims and return count', async () => {
            const { app, bridge } = setup();

            // Create and fail a claim
            await bridge.processBurn({
                txid: 'b'.repeat(64),
                inscriptionId: `${TXID}i1`,
                senderAddress: 'bc1qsender',
                blockHeight: 100,
                blockHash: 'c'.repeat(64),
            });
            await bridge.confirmPendingClaims(106);
            await bridge.markFailed(`${TXID}i1`);

            const route = app.findRoute('POST', '/bridge/retry-failed')!;
            const req = new MockRequest();
            const res = new MockResponse();
            await route.handler(req, res);

            expect(res.statusCode).toBe(200);
            const body = res.body as Record<string, unknown>;
            expect(body.retried).toBe(1);
        });
    });
});
