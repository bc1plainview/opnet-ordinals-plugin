import { Logger } from '@btc-vision/logger';
import type { CollectionRegistry, IndexedCollectionItem } from './collection.js';
import type { BridgeDatabase } from './bridge-database.js';
import type { BurnClaim } from './types.js';

/**
 * Represents a detected burn transaction to be processed.
 */
export interface DetectedBurn {
    readonly txid: string;
    readonly inscriptionId: string;
    readonly senderAddress: string;
    readonly blockHeight: number;
    readonly blockHash: string;
    readonly feePaid?: number;
}

/**
 * Bridge oracle service.
 *
 * Monitors the indexer for inscriptions sent to the burn address,
 * cross-references them with the loaded collection, and manages
 * the claim lifecycle:
 *
 *   1. detected  – burn tx seen on-chain
 *   2. confirmed – enough confirmations have elapsed
 *   3. attested  – oracle submitted attestBurn to the OP721 contract
 *   4. failed    – attestation failed (can be retried)
 */
export class BridgeService {
    private readonly logger: Logger = new Logger();
    private readonly collection: CollectionRegistry;
    private readonly db: BridgeDatabase;
    private readonly burnAddress: string;
    private readonly requiredConfirmations: number;
    private readonly minFeeSats: number;

    public constructor(
        collection: CollectionRegistry,
        db: BridgeDatabase,
        burnAddress: string,
        requiredConfirmations: number = 6,
        minFeeSats: number = 0,
    ) {
        this.collection = collection;
        this.db = db;
        this.burnAddress = burnAddress;
        this.requiredConfirmations = requiredConfirmations;
        this.minFeeSats = minFeeSats;
    }

    /**
     * Process a detected burn: validate it belongs to the collection,
     * hasn't been claimed yet, and insert a new burn claim.
     *
     * Returns the indexed item if valid, or null if rejected.
     */
    public async processBurn(burn: DetectedBurn): Promise<IndexedCollectionItem | null> {
        // Check if the inscription belongs to the collection
        const item = this.collection.getByInscriptionId(burn.inscriptionId);
        if (item === undefined) {
            this.logger.debug(
                `Inscription ${burn.inscriptionId} not in collection, skipping`,
            );
            return null;
        }

        // Check if already claimed
        const alreadyClaimed = await this.db.isClaimed(burn.inscriptionId);
        if (alreadyClaimed) {
            this.logger.warn(
                `Inscription ${burn.inscriptionId} already has a burn claim, skipping`,
            );
            return null;
        }

        // Check fee payment if a minimum fee is required
        const feePaid = burn.feePaid ?? 0;
        const isUnderpaid = this.minFeeSats > 0 && feePaid < this.minFeeSats;

        // Create a new burn claim
        const now = Date.now();
        const claim: BurnClaim = {
            inscriptionId: burn.inscriptionId,
            collectionName: this.collection.getName(),
            tokenId: item.tokenId,
            senderAddress: burn.senderAddress,
            burnTxid: burn.txid,
            burnBlockHeight: burn.blockHeight,
            burnBlockHash: burn.blockHash,
            status: isUnderpaid ? 'underpaid' : 'detected',
            attestTxid: null,
            createdAt: now,
            updatedAt: now,
        };

        await this.db.insertClaim(claim);

        if (isUnderpaid) {
            this.logger.warn(
                `Burn underpaid: ${burn.inscriptionId} -> token #${item.tokenId} ` +
                `(paid ${feePaid} sats, required ${this.minFeeSats} sats)`,
            );
        } else {
            this.logger.info(
                `Burn detected: ${burn.inscriptionId} -> token #${item.tokenId} ` +
                `(sender: ${burn.senderAddress}, tx: ${burn.txid})`,
            );
        }

        return item;
    }

    /**
     * Confirm claims that have enough block confirmations.
     * Called periodically by the indexer loop.
     *
     * @param currentHeight - The current chain tip height
     * @returns Number of claims moved to "confirmed" status
     */
    public async confirmPendingClaims(currentHeight: number): Promise<number> {
        const pending = await this.db.getByStatus('detected');
        let confirmedCount = 0;

        for (const claim of pending) {
            const confirmations = currentHeight - claim.burnBlockHeight;
            if (confirmations >= this.requiredConfirmations) {
                await this.db.updateStatus(claim.inscriptionId, 'confirmed');
                this.logger.info(
                    `Claim confirmed: ${claim.inscriptionId} ` +
                    `(${confirmations} confirmations)`,
                );
                confirmedCount++;
            }
        }

        return confirmedCount;
    }

    /**
     * Get all confirmed claims ready for attestation on the OP721 contract.
     */
    public async getClaimsReadyForAttestation(): Promise<BurnClaim[]> {
        return this.db.getByStatus('confirmed');
    }

    /**
     * Mark a claim as successfully attested on-chain.
     */
    public async markAttested(inscriptionId: string, attestTxid: string): Promise<void> {
        await this.db.updateStatus(inscriptionId, 'attested', attestTxid);
        this.logger.info(
            `Claim attested: ${inscriptionId} (attest tx: ${attestTxid})`,
        );
    }

    /**
     * Mark a claim as failed (can be retried later).
     */
    public async markFailed(inscriptionId: string): Promise<void> {
        await this.db.updateStatus(inscriptionId, 'failed');
        this.logger.warn(`Claim failed: ${inscriptionId}`);
    }

    /**
     * Get the status of a specific inscription's burn claim.
     */
    public async getClaimStatus(inscriptionId: string): Promise<BurnClaim | null> {
        return this.db.getByInscriptionId(inscriptionId);
    }

    /**
     * Get all claims for a sender address.
     */
    public async getClaimsBySender(
        senderAddress: string,
        limit: number = 100,
        offset: number = 0,
    ): Promise<BurnClaim[]> {
        return this.db.getBySender(senderAddress, limit, offset);
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
        underpaid: number;
        collectionSize: number;
        burnAddress: string;
        requiredConfirmations: number;
        minFeeSats: number;
    }> {
        const dbStats = await this.db.getStats();
        return {
            ...dbStats,
            collectionSize: this.collection.size,
            burnAddress: this.burnAddress,
            requiredConfirmations: this.requiredConfirmations,
            minFeeSats: this.minFeeSats,
        };
    }

    /**
     * Check if an inscription ID is part of the loaded collection.
     */
    public isInCollection(inscriptionId: string): boolean {
        return this.collection.hasInscription(inscriptionId);
    }

    /**
     * Get the burn address this bridge monitors.
     */
    public getBurnAddress(): string {
        return this.burnAddress;
    }

    /**
     * Get the collection registry.
     */
    public getCollection(): CollectionRegistry {
        return this.collection;
    }

    /**
     * Handle blockchain reorg by removing unconfirmed claims from the
     * reorged height.
     */
    public async handleReorg(newHeight: number): Promise<number> {
        const deleted = await this.db.deleteFromHeight(newHeight);
        if (deleted > 0) {
            this.logger.warn(
                `Bridge reorg: deleted ${deleted} unconfirmed claims from height ${newHeight}`,
            );
        }
        return deleted;
    }

    /**
     * Retry failed claims by resetting them to "confirmed".
     */
    public async retryFailedClaims(): Promise<number> {
        const failed = await this.db.getByStatus('failed');
        let retried = 0;
        for (const claim of failed) {
            await this.db.updateStatus(claim.inscriptionId, 'confirmed');
            retried++;
        }
        if (retried > 0) {
            this.logger.info(`Retrying ${retried} failed claims`);
        }
        return retried;
    }
}
