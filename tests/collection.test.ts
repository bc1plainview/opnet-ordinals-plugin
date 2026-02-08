import { CollectionRegistry, type CollectionItem } from '../src/collection.js';

/**
 * Unit tests for the CollectionRegistry.
 */

function createSampleItems(count: number): CollectionItem[] {
    const items: CollectionItem[] = [];
    for (let i = 0; i < count; i++) {
        const txid = 'a'.repeat(64);
        items.push({
            id: `${txid}i${i}`,
            meta: {
                name: `#${String(i).padStart(4, '0')}`,
                attributes: [
                    { trait_type: 'color', value: i % 2 === 0 ? 'red' : 'blue' },
                ],
                high_res_img_url: `https://example.com/${i}.jpg`,
            },
        });
    }
    return items;
}

describe('CollectionRegistry', () => {
    let registry: CollectionRegistry;

    beforeEach(() => {
        registry = new CollectionRegistry('TestCats', 'TCAT');
    });

    describe('constructor and metadata', () => {
        it('should store the collection name and symbol', () => {
            expect(registry.getName()).toBe('TestCats');
            expect(registry.getSymbol()).toBe('TCAT');
        });

        it('should start with size 0', () => {
            expect(registry.size).toBe(0);
        });
    });

    describe('loadItems', () => {
        it('should load a collection of items', () => {
            const items = createSampleItems(10);
            registry.loadItems(items);

            expect(registry.size).toBe(10);
        });

        it('should assign sequential token IDs starting from 0', () => {
            const items = createSampleItems(5);
            registry.loadItems(items);

            for (let i = 0; i < 5; i++) {
                const item = registry.getByTokenId(i);
                expect(item).toBeDefined();
                expect(item!.tokenId).toBe(i);
            }
        });

        it('should skip items with missing id', () => {
            const items: CollectionItem[] = [
                {
                    id: 'a'.repeat(64) + 'i0',
                    meta: {
                        name: '#0',
                        attributes: [],
                        high_res_img_url: 'https://example.com/0.jpg',
                    },
                },
                {
                    id: '',
                    meta: {
                        name: '#1',
                        attributes: [],
                        high_res_img_url: 'https://example.com/1.jpg',
                    },
                },
            ];

            registry.loadItems(items);
            expect(registry.size).toBe(1);
        });

        it('should skip duplicate inscription IDs', () => {
            const txid = 'b'.repeat(64);
            const items: CollectionItem[] = [
                {
                    id: `${txid}i0`,
                    meta: {
                        name: '#0',
                        attributes: [],
                        high_res_img_url: 'https://example.com/0.jpg',
                    },
                },
                {
                    id: `${txid}i0`, // duplicate
                    meta: {
                        name: '#1',
                        attributes: [],
                        high_res_img_url: 'https://example.com/1.jpg',
                    },
                },
            ];

            registry.loadItems(items);
            expect(registry.size).toBe(1);
        });

        it('should clear previous items on reload', () => {
            registry.loadItems(createSampleItems(10));
            expect(registry.size).toBe(10);

            registry.loadItems(createSampleItems(5));
            expect(registry.size).toBe(5);
        });
    });

    describe('getByInscriptionId', () => {
        it('should find an item by its inscription ID', () => {
            const items = createSampleItems(5);
            registry.loadItems(items);

            const txid = 'a'.repeat(64);
            const item = registry.getByInscriptionId(`${txid}i3`);

            expect(item).toBeDefined();
            expect(item!.tokenId).toBe(3);
            expect(item!.meta.name).toBe('#0003');
        });

        it('should return undefined for unknown inscription ID', () => {
            registry.loadItems(createSampleItems(5));
            expect(registry.getByInscriptionId('nonexistent')).toBeUndefined();
        });
    });

    describe('getByTokenId', () => {
        it('should find an item by token ID', () => {
            const items = createSampleItems(5);
            registry.loadItems(items);

            const item = registry.getByTokenId(2);
            expect(item).toBeDefined();
            expect(item!.tokenId).toBe(2);
        });

        it('should return undefined for out-of-range token ID', () => {
            registry.loadItems(createSampleItems(5));
            expect(registry.getByTokenId(999)).toBeUndefined();
        });
    });

    describe('hasInscription', () => {
        it('should return true for known inscription IDs', () => {
            registry.loadItems(createSampleItems(3));
            const txid = 'a'.repeat(64);

            expect(registry.hasInscription(`${txid}i0`)).toBe(true);
            expect(registry.hasInscription(`${txid}i2`)).toBe(true);
        });

        it('should return false for unknown inscription IDs', () => {
            registry.loadItems(createSampleItems(3));
            expect(registry.hasInscription('unknown')).toBe(false);
        });
    });

    describe('getAllInscriptionIds', () => {
        it('should return all inscription IDs', () => {
            registry.loadItems(createSampleItems(3));
            const ids = registry.getAllInscriptionIds();

            expect(ids).toHaveLength(3);
            const txid = 'a'.repeat(64);
            expect(ids).toContain(`${txid}i0`);
            expect(ids).toContain(`${txid}i1`);
            expect(ids).toContain(`${txid}i2`);
        });
    });

    describe('getAllItems', () => {
        it('should return items sorted by token ID', () => {
            registry.loadItems(createSampleItems(5));
            const allItems = registry.getAllItems();

            expect(allItems).toHaveLength(5);
            for (let i = 0; i < 5; i++) {
                expect(allItems[i].tokenId).toBe(i);
            }
        });
    });

    describe('loadFromFile', () => {
        it('should load from motocats.json', () => {
            const registry2 = new CollectionRegistry('MotoCats', 'MCAT');
            registry2.loadFromFile(
                '/Users/mastermindgigachad/Desktop/CLAUDE/opnet-ordinals-plugin/motocats.json',
            );

            expect(registry2.size).toBe(10000);

            // Check first item
            const first = registry2.getByTokenId(0);
            expect(first).toBeDefined();
            expect(first!.id).toBe(
                'bacb6587e90fa6d826c78a9931013722510370f1a3e019ad2fff81372e672ddei0',
            );
            expect(first!.meta.name).toBe('#0000');

            // Check last item
            const last = registry2.getByTokenId(9999);
            expect(last).toBeDefined();
            expect(last!.tokenId).toBe(9999);
        });
    });

    describe('large collection performance', () => {
        it('should handle 10,000 items efficiently', () => {
            const items = createSampleItems(10000);

            const start = Date.now();
            registry.loadItems(items);
            const loadTime = Date.now() - start;

            expect(registry.size).toBe(10000);
            expect(loadTime).toBeLessThan(1000); // Should load in under 1 second

            // Random lookups should be fast
            const lookupStart = Date.now();
            const txid = 'a'.repeat(64);
            for (let i = 0; i < 1000; i++) {
                const idx = Math.floor(Math.random() * 10000);
                registry.getByInscriptionId(`${txid}i${idx}`);
            }
            const lookupTime = Date.now() - lookupStart;
            expect(lookupTime).toBeLessThan(100); // 1000 lookups in under 100ms
        });
    });
});
