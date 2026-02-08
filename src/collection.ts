import { readFileSync } from 'node:fs';
import { Logger } from '@btc-vision/logger';

/**
 * A single item in a collection JSON file.
 */
export interface CollectionItem {
    readonly id: string;
    readonly meta: {
        readonly name: string;
        readonly attributes: ReadonlyArray<{
            readonly trait_type: string;
            readonly value: string;
        }>;
        readonly high_res_img_url: string;
    };
}

/**
 * Indexed collection item with a derived token ID.
 */
export interface IndexedCollectionItem extends CollectionItem {
    readonly tokenId: number;
}

/**
 * Collection registry that loads a JSON file of ordinal inscription IDs
 * and maps each to a sequential token ID for OP721 minting.
 */
export class CollectionRegistry {
    private readonly logger: Logger = new Logger();
    private readonly itemsByInscriptionId: Map<string, IndexedCollectionItem> = new Map();
    private readonly itemsByTokenId: Map<number, IndexedCollectionItem> = new Map();
    private readonly collectionName: string;
    private readonly collectionSymbol: string;

    public constructor(
        collectionName: string,
        collectionSymbol: string,
    ) {
        this.collectionName = collectionName;
        this.collectionSymbol = collectionSymbol;
    }

    /**
     * Load a collection from a JSON file path.
     * The file must be an array of { id, meta } objects.
     */
    public loadFromFile(filePath: string): void {
        const raw = readFileSync(filePath, 'utf8');
        const items: CollectionItem[] = JSON.parse(raw) as CollectionItem[];
        this.loadItems(items);
    }

    /**
     * Load a collection from an array of items directly.
     */
    public loadItems(items: CollectionItem[]): void {
        this.itemsByInscriptionId.clear();
        this.itemsByTokenId.clear();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            if (!item.id || typeof item.id !== 'string') {
                this.logger.warn(`Skipping collection item at index ${i}: missing or invalid id`);
                continue;
            }

            if (this.itemsByInscriptionId.has(item.id)) {
                this.logger.warn(`Duplicate inscription ID at index ${i}: ${item.id}`);
                continue;
            }

            const indexed: IndexedCollectionItem = { ...item, tokenId: i };
            this.itemsByInscriptionId.set(item.id, indexed);
            this.itemsByTokenId.set(i, indexed);
        }

        this.logger.info(
            `Loaded collection "${this.collectionName}" with ${this.itemsByInscriptionId.size} items`,
        );
    }

    /**
     * Look up a collection item by its Bitcoin inscription ID.
     */
    public getByInscriptionId(inscriptionId: string): IndexedCollectionItem | undefined {
        return this.itemsByInscriptionId.get(inscriptionId);
    }

    /**
     * Look up a collection item by its OP721 token ID.
     */
    public getByTokenId(tokenId: number): IndexedCollectionItem | undefined {
        return this.itemsByTokenId.get(tokenId);
    }

    /**
     * Check whether an inscription ID belongs to this collection.
     */
    public hasInscription(inscriptionId: string): boolean {
        return this.itemsByInscriptionId.has(inscriptionId);
    }

    /**
     * Total number of items in the collection.
     */
    public get size(): number {
        return this.itemsByInscriptionId.size;
    }

    public getName(): string {
        return this.collectionName;
    }

    public getSymbol(): string {
        return this.collectionSymbol;
    }

    /**
     * Return all inscription IDs in the collection.
     */
    public getAllInscriptionIds(): string[] {
        return Array.from(this.itemsByInscriptionId.keys());
    }

    /**
     * Return all indexed items sorted by token ID.
     */
    public getAllItems(): IndexedCollectionItem[] {
        return Array.from(this.itemsByTokenId.values()).sort(
            (a, b) => a.tokenId - b.tokenId,
        );
    }
}
