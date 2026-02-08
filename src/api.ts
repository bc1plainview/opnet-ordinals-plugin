import express, { type Request, type Response, type Application } from 'express';
import cors from 'cors';
import { Logger } from '@btc-vision/logger';
import type { InscriptionDatabase } from './database.js';

/**
 * REST API for querying Ordinals inscriptions
 */
export class OrdinalsAPI {
    private readonly app: Application;
    private readonly db: InscriptionDatabase;
    private readonly logger: Logger = new Logger();
    private readonly port: number;

    public constructor(db: InscriptionDatabase, port: number = 3002) {
        this.app = express();
        this.db = db;
        this.port = port;

        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Setup Express middleware
     */
    private setupMiddleware(): void {
        this.app.use(cors());
        this.app.use(express.json());

        // Request logging
        this.app.use((req: Request, _res: Response, next) => {
            this.logger.debug(`${req.method} ${req.path}`);
            next();
        });
    }

    /**
     * Setup API routes
     */
    private setupRoutes(): void {
        // Health check
        this.app.get('/health', (_req: Request, res: Response) => {
            res.json({
                status: 'ok',
                service: 'ordinals-indexer',
                timestamp: Date.now(),
            });
        });

        // Get inscription by ID
        this.app.get('/inscription/:id', async (req: Request, res: Response) => {
            try {
                const inscription = await this.db.getById(req.params.id);

                if (inscription === null) {
                    return res.status(404).json({
                        error: 'Inscription not found',
                        id: req.params.id,
                    });
                }

                return res.json({
                    ...inscription,
                    content: inscription.content.toString('base64'),
                    contentSize: inscription.content.length,
                });
            } catch (error) {
                this.logger.error(`Error fetching inscription: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get inscription content (serve raw binary)
        this.app.get('/content/:id', async (req: Request, res: Response) => {
            try {
                const inscription = await this.db.getById(req.params.id);

                if (inscription === null) {
                    return res.status(404).send('Not found');
                }

                res.setHeader('Content-Type', inscription.contentType);
                res.setHeader('Content-Length', inscription.content.length);
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                return res.send(inscription.content);
            } catch (error) {
                this.logger.error(`Error serving content: ${String(error)}`);
                return res.status(500).send('Internal server error');
            }
        });

        // Get inscriptions by owner
        this.app.get('/inscriptions/owner/:address', async (req: Request, res: Response) => {
            try {
                const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
                const offset = parseInt(req.query.offset as string) || 0;

                const inscriptions = await this.db.getByOwner(req.params.address, limit, offset);

                return res.json({
                    owner: req.params.address,
                    count: inscriptions.length,
                    limit,
                    offset,
                    inscriptions: inscriptions.map((i) => ({
                        ...i,
                        content: undefined, // Don't send content in list view
                        contentSize: i.content.length,
                    })),
                });
            } catch (error) {
                this.logger.error(`Error fetching owner inscriptions: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get latest inscriptions
        this.app.get('/inscriptions/latest', async (req: Request, res: Response) => {
            try {
                const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
                const inscriptions = await this.db.getLatest(limit);

                return res.json({
                    count: inscriptions.length,
                    inscriptions: inscriptions.map((i) => ({
                        ...i,
                        content: undefined,
                        contentSize: i.content.length,
                    })),
                });
            } catch (error) {
                this.logger.error(`Error fetching latest inscriptions: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get inscriptions by content type
        this.app.get('/inscriptions/type/:contentType', async (req: Request, res: Response) => {
            try {
                const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
                const contentType = decodeURIComponent(req.params.contentType);

                const inscriptions = await this.db.getByContentType(contentType, limit);

                return res.json({
                    contentType,
                    count: inscriptions.length,
                    inscriptions: inscriptions.map((i) => ({
                        ...i,
                        content: undefined,
                        contentSize: i.content.length,
                    })),
                });
            } catch (error) {
                this.logger.error(`Error fetching inscriptions by type: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get statistics
        this.app.get('/stats', async (_req: Request, res: Response) => {
            try {
                const stats = await this.db.getStats();
                return res.json(stats);
            } catch (error) {
                this.logger.error(`Error fetching stats: ${String(error)}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

    }

    /**
     * Get the Express Application instance so additional routes can be
     * registered (e.g. bridge API routes) before the server starts.
     */
    public getApp(): Application {
        return this.app;
    }

    /**
     * Start the API server.
     *
     * Registers the catch-all 404 handler, then begins listening.
     * Any additional routes (e.g. bridge) must be registered via
     * getApp() BEFORE calling start().
     */
    public start(): void {
        // 404 handler — must be last
        this.app.use((_req: Request, res: Response) => {
            res.status(404).json({ error: 'Not found' });
        });

        this.app.listen(this.port, () => {
            this.logger.info(`Ordinals API listening on http://localhost:${this.port}`);
        });
    }
}
