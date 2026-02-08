import { type Application, type Request, type Response } from 'express';
import { Logger } from '@btc-vision/logger';
import type { BridgeService } from './bridge.js';

/**
 * REST API endpoints for the Ordinals-to-OP721 bridge.
 *
 * Adds bridge-specific routes to the existing Express app.
 */
export class BridgeAPI {
    private readonly logger: Logger = new Logger();
    private readonly bridge: BridgeService;

    public constructor(bridge: BridgeService) {
        this.bridge = bridge;
    }

    /**
     * Register all bridge routes on the given Express app.
     */
    public registerRoutes(app: Application): void {
        // Get bridge status / stats
        app.get('/bridge/stats', async (_req: Request, res: Response) => {
            try {
                const stats = await this.bridge.getStats();
                return res.json(stats);
            } catch (error) {
                this.logger.error(`Error fetching bridge stats: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get burn claim status for a specific inscription
        app.get('/bridge/claim/:inscriptionId', async (req: Request, res: Response) => {
            try {
                const claim = await this.bridge.getClaimStatus(req.params.inscriptionId);

                if (claim === null) {
                    return res.status(404).json({
                        error: 'No burn claim found for this inscription',
                        inscriptionId: req.params.inscriptionId,
                    });
                }

                // Add helpful message for underpaid claims
                if (claim.status === 'underpaid') {
                    return res.json({
                        ...claim,
                        message:
                            'Burn detected but the bridge fee was insufficient. ' +
                            'Please re-submit with the required fee to the oracle fee address.',
                    });
                }

                return res.json(claim);
            } catch (error) {
                this.logger.error(`Error fetching claim status: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get all claims for a sender address
        app.get('/bridge/claims/sender/:address', async (req: Request, res: Response) => {
            try {
                const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
                const offset = parseInt(req.query.offset as string) || 0;

                const claims = await this.bridge.getClaimsBySender(
                    req.params.address,
                    limit,
                    offset,
                );

                return res.json({
                    sender: req.params.address,
                    count: claims.length,
                    limit,
                    offset,
                    claims,
                });
            } catch (error) {
                this.logger.error(`Error fetching sender claims: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Check if an inscription is part of the loaded collection
        app.get('/bridge/collection/check/:inscriptionId', (req: Request, res: Response) => {
            const inscriptionId = req.params.inscriptionId;
            const inCollection = this.bridge.isInCollection(inscriptionId);
            const collection = this.bridge.getCollection();
            const item = collection.getByInscriptionId(inscriptionId);

            return res.json({
                inscriptionId,
                inCollection,
                tokenId: item?.tokenId ?? null,
                meta: item?.meta ?? null,
            });
        });

        // Get collection info
        app.get('/bridge/collection', (_req: Request, res: Response) => {
            const collection = this.bridge.getCollection();
            return res.json({
                name: collection.getName(),
                symbol: collection.getSymbol(),
                size: collection.size,
                burnAddress: this.bridge.getBurnAddress(),
            });
        });

        // Look up a collection item by token ID
        app.get('/bridge/collection/token/:tokenId', (req: Request, res: Response) => {
            const tokenId = parseInt(req.params.tokenId, 10);
            if (isNaN(tokenId) || tokenId < 0) {
                return res.status(400).json({ error: 'Invalid token ID' });
            }

            const collection = this.bridge.getCollection();
            const item = collection.getByTokenId(tokenId);

            if (item === undefined) {
                return res.status(404).json({
                    error: 'Token not found in collection',
                    tokenId,
                });
            }

            return res.json(item);
        });

        // Retry failed claims (admin endpoint)
        app.post('/bridge/retry-failed', async (_req: Request, res: Response) => {
            try {
                const retried = await this.bridge.retryFailedClaims();
                return res.json({ retried });
            } catch (error) {
                this.logger.error(`Error retrying failed claims: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        this.logger.info('Bridge API routes registered');
    }
}
