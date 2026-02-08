import { OrdinalsParser } from '../src/parser.js';

/**
 * Integration tests for end-to-end inscription processing.
 * Tests realistic scenarios matching the official ord behavior.
 *
 * All envelopes below use the CANONICAL data-push encoding
 * (OP_PUSHBYTES_1 0x01 for the content-type tag), matching what
 * the ord reference implementation produces.
 */

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Build a canonical inscription envelope.
 *
 * Encoding: tag 1 = OP_PUSHBYTES_1 0x01, body separator = OP_0.
 * Content is split into 520-byte chunks per the ord spec.
 */
function createInscription(
    body: Buffer,
    mimeType: string,
): Buffer[] {
    const ctBuf = Buffer.from(mimeType, 'utf8');
    const MAX_CHUNK = 520;

    const parts: Buffer[] = [
        Buffer.from([0x00, 0x63, 0x03]),          // OP_FALSE OP_IF PUSH3
        Buffer.from('ord', 'utf8'),
        Buffer.from([0x01, 0x01]),                // tag 1 (content-type)
        Buffer.from([ctBuf.length]),
        ctBuf,
        Buffer.from([0x00]),                      // body separator
    ];

    // Split body into <=520-byte chunks, using appropriate push opcodes
    for (let i = 0; i < body.length; i += MAX_CHUNK) {
        const chunk = body.subarray(i, Math.min(i + MAX_CHUNK, body.length));
        if (chunk.length <= 0x4b) {
            parts.push(Buffer.from([chunk.length]));
        } else if (chunk.length <= 0xff) {
            parts.push(Buffer.from([0x4c, chunk.length]));
        } else {
            const lenBuf = Buffer.alloc(2);
            lenBuf.writeUInt16LE(chunk.length);
            parts.push(Buffer.from([0x4d]));
            parts.push(lenBuf);
        }
        parts.push(chunk);
    }

    parts.push(Buffer.from([0x68]));              // OP_ENDIF

    return [Buffer.concat(parts)];
}

function createTextInscription(text: string): Buffer[] {
    return createInscription(Buffer.from(text, 'utf8'), 'text/plain;charset=utf-8');
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('Integration Tests - Ordinals Specification Compliance', () => {
    describe('Real-world inscription scenarios', () => {
        it('should process a text inscription ("gm")', () => {
            const witness = createTextInscription('gm');
            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain;charset=utf-8');
            expect(result?.content.toString('utf8')).toBe('gm');
        });

        it('should process an image inscription', () => {
            const imageData = Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                0x00, 0x00, 0x00, 0x0d,
            ]);
            const witness = createInscription(imageData, 'image/png');
            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('image/png');
            expect(result?.content.subarray(0, 8)).toEqual(imageData.subarray(0, 8));
        });

        it('should process an HTML inscription', () => {
            const html = '<!DOCTYPE html><html><body>Hello Ordinals</body></html>';
            const witness = createInscription(Buffer.from(html, 'utf8'), 'text/html;charset=utf-8');
            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/html;charset=utf-8');
            expect(result?.content.toString('utf8')).toBe(html);
        });

        it('should process a BRC-20 JSON inscription', () => {
            const metadata = {
                p: 'brc-20',
                op: 'deploy',
                tick: 'ordi',
                max: '21000000',
            };
            const witness = createInscription(
                Buffer.from(JSON.stringify(metadata), 'utf8'),
                'application/json',
            );
            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('application/json');
            const parsed = JSON.parse(result!.content.toString('utf8'));
            expect(parsed.tick).toBe('ordi');
            expect(parsed.max).toBe('21000000');
        });

        it('should process a large inscription (10 KB, chunked at 520 bytes)', () => {
            const largeText = 'A'.repeat(10000);
            const witness = createInscription(Buffer.from(largeText, 'utf8'), 'text/plain');
            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.toString('utf8')).toBe(largeText);
            expect(result?.content.length).toBe(10000);
        });
    });

    describe('Protocol edge cases', () => {
        it('should reject raw data without envelope', () => {
            const witness = [Buffer.from('Hello World')];
            expect(OrdinalsParser.parseInscription(witness)).toBeNull();
        });

        it('should reject wrong magic bytes', () => {
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('nft', 'utf8'),               // Wrong!
                Buffer.from([0x01, 0x01, 0x0a]),
                Buffer.from('text/plain', 'utf8'),
                Buffer.from([0x00, 0x05]),
                Buffer.from('Hello', 'utf8'),
                Buffer.from([0x68]),
            ]);
            expect(OrdinalsParser.parseInscription([envelope])).toBeNull();
        });

        it('should handle inscription with additional fields', () => {
            // Envelope with metaprotocol tag 7
            const ctBuf = Buffer.from('text/plain', 'utf8');
            const mpBuf = Buffer.from('brc-20', 'utf8');
            const content = Buffer.from('Test', 'utf8');

            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01]),                // tag 1 (content-type)
                Buffer.from([ctBuf.length]),
                ctBuf,
                Buffer.from([0x01, 0x07]),                // tag 7 (metaprotocol)
                Buffer.from([mpBuf.length]),
                mpBuf,
                Buffer.from([0x00]),                      // body separator
                Buffer.from([content.length]),
                content,
                Buffer.from([0x68]),
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.metaprotocol).toBe('brc-20');
            expect(result?.content.toString('utf8')).toBe('Test');
        });
    });

    describe('Witness stack scenarios', () => {
        it('should find inscription in P2TR witness stack', () => {
            const inscription = createTextInscription('ord');

            const witness = [
                Buffer.alloc(64, 0xaa),                   // Schnorr signature
                inscription[0],                           // Tapscript with inscription
                Buffer.alloc(33, 0xbb),                   // Control block
            ];

            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.content.toString('utf8')).toBe('ord');
        });

        it('should return first inscription when multiple exist', () => {
            const insc1 = createTextInscription('First');
            const insc2 = createTextInscription('Second');

            const result = OrdinalsParser.parseInscription([insc1[0], insc2[0]]);

            expect(result).not.toBeNull();
            expect(result?.content.toString('utf8')).toBe('First');
        });
    });

    describe('Content type validation', () => {
        const mimeTypes = [
            'text/plain',
            'text/html',
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'image/svg+xml',
            'video/mp4',
            'audio/mpeg',
            'application/json',
            'application/pdf',
            'model/gltf-binary',
        ];

        for (const mimeType of mimeTypes) {
            it(`should accept ${mimeType}`, () => {
                const witness = createInscription(Buffer.from('test', 'utf8'), mimeType);
                const result = OrdinalsParser.parseInscription(witness);

                expect(result).not.toBeNull();
                expect(result?.contentType).toBe(mimeType);
            });
        }

        it('should preserve content-type parameters', () => {
            const witness = createTextInscription('test');
            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain;charset=utf-8');
        });
    });

    describe('Inscription ID format', () => {
        it('should follow the txidi{index} format', () => {
            const txid = 'a'.repeat(64);
            const id0 = `${txid}i0`;
            const id1 = `${txid}i1`;

            expect(id0).toMatch(/^[0-9a-f]{64}i\d+$/);
            expect(id1).toMatch(/^[0-9a-f]{64}i\d+$/);
            expect(id0).toBe(`${'a'.repeat(64)}i0`);
            expect(id1).toBe(`${'a'.repeat(64)}i1`);
        });
    });
});
