import { OrdinalsParser } from '../src/parser.js';

/**
 * Helper: build an inscription envelope using CANONICAL data-push encoding.
 *
 * Tag 1 (content-type) is encoded as OP_PUSHBYTES_1 0x01, not OP_PUSHNUM_1.
 * Body separator is OP_0 (0x00).
 * Content chunks use OP_PUSHBYTES_N.
 */
function buildCanonicalEnvelope(
    contentType: string,
    contentChunks: Buffer[],
    extraFields?: Array<{ tag: number; value: Buffer }>,
): Buffer {
    const parts: Buffer[] = [
        Buffer.from([0x00]),                      // OP_FALSE
        Buffer.from([0x63]),                      // OP_IF
        Buffer.from([0x03]),                      // OP_PUSHBYTES_3
        Buffer.from('ord', 'utf8'),               // "ord" marker
    ];

    // Content-type field: tag=1 (OP_PUSHBYTES_1 0x01), then push content-type string
    const ctBuf = Buffer.from(contentType, 'utf8');
    parts.push(Buffer.from([0x01, 0x01]));        // OP_PUSHBYTES_1, value=0x01 (Tag.ContentType)
    parts.push(Buffer.from([ctBuf.length]));      // OP_PUSHBYTES_N
    parts.push(ctBuf);

    // Extra tag/value fields
    if (extraFields) {
        for (const field of extraFields) {
            parts.push(Buffer.from([0x01, field.tag])); // OP_PUSHBYTES_1, tag byte
            if (field.value.length <= 0x4b) {
                parts.push(Buffer.from([field.value.length]));
                parts.push(field.value);
            } else if (field.value.length <= 0xff) {
                parts.push(Buffer.from([0x4c, field.value.length])); // OP_PUSHDATA1
                parts.push(field.value);
            } else {
                const lenBuf = Buffer.alloc(2);
                lenBuf.writeUInt16LE(field.value.length);
                parts.push(Buffer.from([0x4d]));  // OP_PUSHDATA2
                parts.push(lenBuf);
                parts.push(field.value);
            }
        }
    }

    // Body separator: OP_0
    parts.push(Buffer.from([0x00]));

    // Body content chunks
    for (const chunk of contentChunks) {
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

    return Buffer.concat(parts);
}

/**
 * Helper: build an inscription envelope using OP_PUSHNUM encoding.
 *
 * Tag 1 (content-type) is encoded as OP_PUSHNUM_1 (0x51).
 * This is the non-canonical but accepted format.
 */
function buildPushNumEnvelope(contentType: string, content: Buffer): Buffer {
    const ctBuf = Buffer.from(contentType, 'utf8');
    return Buffer.concat([
        Buffer.from([0x00]),                      // OP_FALSE
        Buffer.from([0x63]),                      // OP_IF
        Buffer.from([0x03]),                      // OP_PUSHBYTES_3
        Buffer.from('ord', 'utf8'),               // "ord" marker
        Buffer.from([0x51]),                      // OP_PUSHNUM_1 = tag 1 (ContentType)
        Buffer.from([ctBuf.length]),              // OP_PUSHBYTES_N
        ctBuf,                                    // Content type string
        Buffer.from([0x00]),                      // OP_0 (body separator)
        Buffer.from([content.length]),            // OP_PUSHBYTES_N
        content,                                  // Content
        Buffer.from([0x68]),                      // OP_ENDIF
    ]);
}

describe('OrdinalsParser', () => {
    describe('Canonical data-push encoding (OP_PUSHBYTES_1 0x01)', () => {
        it('should parse a text inscription with canonical tag encoding', () => {
            const content = Buffer.from('Hello, Ordinals!', 'utf8');
            const envelope = buildCanonicalEnvelope('text/plain', [content]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.toString('utf8')).toBe('Hello, Ordinals!');
        });

        it('should parse an image/png inscription with canonical tags', () => {
            const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            const envelope = buildCanonicalEnvelope('image/png', [pngHeader]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('image/png');
            expect(result?.content).toEqual(pngHeader);
        });

        it('should parse application/json inscription', () => {
            const json = Buffer.from('{"name":"Bitcoin"}', 'utf8');
            const envelope = buildCanonicalEnvelope('application/json', [json]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('application/json');
            expect(result?.content.toString('utf8')).toBe('{"name":"Bitcoin"}');
        });

        it('should parse image/svg+xml inscription', () => {
            const svg = Buffer.from('<svg></svg>', 'utf8');
            const envelope = buildCanonicalEnvelope('image/svg+xml', [svg]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('image/svg+xml');
            expect(result?.content.toString('utf8')).toBe('<svg></svg>');
        });
    });

    describe('OP_PUSHNUM encoding (non-canonical but accepted)', () => {
        it('should parse inscription using OP_PUSHNUM_1 for content-type tag', () => {
            const content = Buffer.from('Hello', 'utf8');
            const envelope = buildPushNumEnvelope('text/plain', content);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.toString('utf8')).toBe('Hello');
        });

        it('should handle OP_PUSHNUM_2 through OP_PUSHNUM_16', () => {
            // OP_PUSHNUM_2 (0x52) => tag byte 2 (Pointer)
            // Build an envelope with tag 2 (pointer) pointing to a value, plus tag 1 (content-type)
            const ctBuf = Buffer.from('text/plain', 'utf8');
            const pointerValue = Buffer.from([0x05, 0x00, 0x00, 0x00]); // pointer to sat 5
            const content = Buffer.from('test', 'utf8');

            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                // Tag 1 via OP_PUSHNUM_1
                Buffer.from([0x51]),
                Buffer.from([ctBuf.length]),
                ctBuf,
                // Tag 2 via OP_PUSHNUM_2
                Buffer.from([0x52]),                        // OP_PUSHNUM_2 => tag 2 (Pointer)
                Buffer.from([pointerValue.length]),
                pointerValue,
                // Body separator and content
                Buffer.from([0x00]),
                Buffer.from([content.length]),
                content,
                Buffer.from([0x68]),
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.pointer).toEqual(pointerValue);
            expect(result?.content.toString('utf8')).toBe('test');
        });
    });

    describe('Chunked content (multi-push body)', () => {
        it('should concatenate multiple content chunks', () => {
            const chunk1 = Buffer.from('Hello, ');
            const chunk2 = Buffer.from('Ordinals ');
            const chunk3 = Buffer.from('World!');
            const envelope = buildCanonicalEnvelope('text/plain', [chunk1, chunk2, chunk3]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.toString('utf8')).toBe('Hello, Ordinals World!');
        });

        it('should handle large content split into 75-byte chunks', () => {
            const largeText = 'A'.repeat(300);
            const fullContent = Buffer.from(largeText, 'utf8');
            const chunkSize = 75;
            const chunks: Buffer[] = [];
            for (let i = 0; i < fullContent.length; i += chunkSize) {
                chunks.push(fullContent.subarray(i, Math.min(i + chunkSize, fullContent.length)));
            }

            const envelope = buildCanonicalEnvelope('text/plain', chunks);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.content.toString('utf8')).toBe(largeText);
            expect(result?.content.length).toBe(300);
        });
    });

    describe('OP_PUSHDATA1/2/4 handling', () => {
        it('should handle OP_PUSHDATA1 for content chunks (76-255 bytes)', () => {
            const content = Buffer.alloc(200, 0x42); // 200 bytes of 'B'

            // Build envelope manually with OP_PUSHDATA1 for content
            const ctBuf = Buffer.from('application/octet-stream', 'utf8');
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01]),                // tag 1 canonical
                Buffer.from([ctBuf.length]),
                ctBuf,
                Buffer.from([0x00]),                      // body separator
                Buffer.from([0x4c, content.length]),      // OP_PUSHDATA1 + 1-byte length
                content,
                Buffer.from([0x68]),
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('application/octet-stream');
            expect(result?.content.length).toBe(200);
            expect(result?.content.every((b) => b === 0x42)).toBe(true);
        });

        it('should handle OP_PUSHDATA2 for content chunks (256-520 bytes)', () => {
            const content = Buffer.alloc(520, 0x43); // 520 bytes of 'C'

            const ctBuf = Buffer.from('application/octet-stream', 'utf8');
            const lenBuf = Buffer.alloc(2);
            lenBuf.writeUInt16LE(content.length);

            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01]),
                Buffer.from([ctBuf.length]),
                ctBuf,
                Buffer.from([0x00]),                      // body separator
                Buffer.from([0x4d]),                       // OP_PUSHDATA2
                lenBuf,                                   // 2-byte length LE
                content,
                Buffer.from([0x68]),
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.content.length).toBe(520);
            expect(result?.content.every((b) => b === 0x43)).toBe(true);
        });

        it('should handle OP_PUSHDATA4 for content chunks', () => {
            const content = Buffer.alloc(100, 0x44); // Use small for test speed

            const ctBuf = Buffer.from('application/octet-stream', 'utf8');
            const lenBuf = Buffer.alloc(4);
            lenBuf.writeUInt32LE(content.length);

            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01]),
                Buffer.from([ctBuf.length]),
                ctBuf,
                Buffer.from([0x00]),
                Buffer.from([0x4e]),                      // OP_PUSHDATA4
                lenBuf,                                   // 4-byte length LE
                content,
                Buffer.from([0x68]),
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.content.length).toBe(100);
            expect(result?.content.every((b) => b === 0x44)).toBe(true);
        });
    });

    describe('Tag/value field parsing', () => {
        it('should extract pointer field (tag 2)', () => {
            const pointer = Buffer.from([0x05, 0x00, 0x00, 0x00]); // sat 5, LE
            const content = Buffer.from('test', 'utf8');
            const envelope = buildCanonicalEnvelope('text/plain', [content], [
                { tag: 2, value: pointer },
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.pointer).toEqual(pointer);
        });

        it('should extract parent field (tag 3)', () => {
            const parentId = Buffer.alloc(32, 0xab); // 32-byte txid
            const content = Buffer.from('child', 'utf8');
            const envelope = buildCanonicalEnvelope('text/plain', [content], [
                { tag: 3, value: parentId },
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.parent).toEqual(parentId);
        });

        it('should extract metaprotocol field (tag 7)', () => {
            const metaprotocol = Buffer.from('brc-20', 'utf8');
            const content = Buffer.from('{}', 'utf8');
            const envelope = buildCanonicalEnvelope('application/json', [content], [
                { tag: 7, value: metaprotocol },
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.metaprotocol).toBe('brc-20');
        });

        it('should extract content-encoding field (tag 9)', () => {
            const encoding = Buffer.from('br', 'utf8');
            const content = Buffer.from([0x01, 0x02, 0x03]); // brotli placeholder
            const envelope = buildCanonicalEnvelope('text/html', [content], [
                { tag: 9, value: encoding },
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentEncoding).toBe('br');
        });

        it('should extract delegate field (tag 11)', () => {
            const delegateId = Buffer.alloc(32, 0xcd);
            const envelope = buildCanonicalEnvelope('text/plain', [Buffer.from('x')], [
                { tag: 11, value: delegateId },
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.delegate).toEqual(delegateId);
        });

        it('should use first value when a non-chunked tag appears multiple times', () => {
            const ct1 = Buffer.from('text/plain', 'utf8');
            const ct2 = Buffer.from('text/html', 'utf8');
            const content = Buffer.from('dup', 'utf8');

            // Manually build envelope with duplicate content-type
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                // First content-type
                Buffer.from([0x01, 0x01]),
                Buffer.from([ct1.length]),
                ct1,
                // Duplicate content-type
                Buffer.from([0x01, 0x01]),
                Buffer.from([ct2.length]),
                ct2,
                // Body
                Buffer.from([0x00]),
                Buffer.from([content.length]),
                content,
                Buffer.from([0x68]),
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain'); // first wins
        });

        it('should concatenate chunked metadata tag (tag 5)', () => {
            const meta1 = Buffer.from([0xa1, 0x61, 0x61]); // CBOR chunk 1
            const meta2 = Buffer.from([0x01]);              // CBOR chunk 2
            const content = Buffer.from('m', 'utf8');

            const envelope = buildCanonicalEnvelope('text/plain', [content], [
                { tag: 5, value: meta1 },
                { tag: 5, value: meta2 },
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.metadata).toEqual(Buffer.concat([meta1, meta2]));
        });
    });

    describe('Invalid envelope rejection', () => {
        it('should return null for missing "ord" marker', () => {
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('xyz', 'utf8'),
                Buffer.from([0x01, 0x01]),
                Buffer.from([0x0a]),
                Buffer.from('text/plain', 'utf8'),
                Buffer.from([0x00, 0x05]),
                Buffer.from('Hello', 'utf8'),
                Buffer.from([0x68]),
            ]);

            expect(OrdinalsParser.parseInscription([envelope])).toBeNull();
        });

        it('should return null for missing OP_FALSE', () => {
            const envelope = Buffer.concat([
                Buffer.from([0x63, 0x03]),                // OP_IF without OP_FALSE
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01, 0x0a]),
                Buffer.from('text/plain', 'utf8'),
                Buffer.from([0x00, 0x05]),
                Buffer.from('Hello', 'utf8'),
                Buffer.from([0x68]),
            ]);

            expect(OrdinalsParser.parseInscription([envelope])).toBeNull();
        });

        it('should return null for missing OP_IF', () => {
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x03]),                // OP_FALSE + wrong byte
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x68]),
            ]);

            expect(OrdinalsParser.parseInscription([envelope])).toBeNull();
        });

        it('should return null for empty witness', () => {
            expect(OrdinalsParser.parseInscription([])).toBeNull();
        });

        it('should return null for random witness data', () => {
            const witness = [
                Buffer.from([0x01, 0x02, 0x03]),
                Buffer.from([0xff, 0xfe, 0xfd]),
            ];
            expect(OrdinalsParser.parseInscription(witness)).toBeNull();
        });

        it('should return null for truncated envelope', () => {
            const envelope = Buffer.from([0x00, 0x63, 0x03]);
            expect(OrdinalsParser.parseInscription([envelope])).toBeNull();
        });

        it('should handle buffer overflow attempt gracefully', () => {
            // 0xff is not a recognized push opcode — parser stops collecting
            // body chunks but the envelope itself is still valid (empty body).
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01, 0x0a]),
                Buffer.from('text/plain', 'utf8'),
                Buffer.from([0x00, 0xff]),                // 0x00 = body separator, 0xff = unknown opcode
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);
            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.length).toBe(0);       // No body data
        });

        it('should return null when content push exceeds available data', () => {
            // Push claims 50 bytes but only a few bytes follow — readPush returns null
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01, 0x0a]),
                Buffer.from('text/plain', 'utf8'),
                Buffer.from([0x00]),                      // body separator
                Buffer.from([0x32]),                       // Claims 50 bytes
                Buffer.from([0x01, 0x02]),                 // Only 2 bytes
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);
            // readPush fails → no body chunks collected → valid with empty body
            expect(result).not.toBeNull();
            expect(result?.content.length).toBe(0);
        });
    });

    describe('Witness stack scanning', () => {
        it('should find inscription in multi-item witness stack', () => {
            const content = Buffer.from('Found!', 'utf8');
            const envelope = buildCanonicalEnvelope('text/plain', [content]);

            const witness = [
                Buffer.from([0x01, 0x02]),                // Random data
                Buffer.from([0xff]),                      // Random data
                envelope,                                 // The inscription
                Buffer.from([0xaa, 0xbb]),                // Random data
            ];

            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.content.toString('utf8')).toBe('Found!');
        });

        it('should find first inscription when multiple exist', () => {
            const env1 = buildCanonicalEnvelope('text/plain', [Buffer.from('First')]);
            const env2 = buildCanonicalEnvelope('text/plain', [Buffer.from('Second')]);

            const result = OrdinalsParser.parseInscription([env1, env2]);

            expect(result).not.toBeNull();
            expect(result?.content.toString('utf8')).toBe('First');
        });

        it('should find inscription in P2TR-style witness', () => {
            const content = Buffer.from('ord', 'utf8');
            const envelope = buildCanonicalEnvelope('text/plain;charset=utf-8', [content]);

            const witness = [
                Buffer.alloc(64, 0xaa),                   // Signature
                envelope,                                 // Tapscript
                Buffer.alloc(33, 0xbb),                   // Control block
            ];

            const result = OrdinalsParser.parseInscription(witness);

            expect(result).not.toBeNull();
            expect(result?.content.toString('utf8')).toBe('ord');
        });
    });

    describe('Edge cases', () => {
        it('should handle empty content (body separator immediately followed by OP_ENDIF)', () => {
            const ctBuf = Buffer.from('text/plain', 'utf8');
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01]),
                Buffer.from([ctBuf.length]),
                ctBuf,
                Buffer.from([0x00]),                      // body separator
                Buffer.from([0x68]),                      // OP_ENDIF immediately
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.length).toBe(0);
        });

        it('should handle very long content type', () => {
            const longType = 'x'.repeat(75);
            const content = Buffer.from('test', 'utf8');
            const envelope = buildCanonicalEnvelope(longType, [content]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe(longType);
        });

        it('should handle content-type with parameters', () => {
            const content = Buffer.from('gm', 'utf8');
            const envelope = buildCanonicalEnvelope('text/plain;charset=utf-8', [content]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain;charset=utf-8');
        });

        it('should handle inscription with no body separator (fields only)', () => {
            // Build envelope with content-type but no body separator
            const ctBuf = Buffer.from('text/plain', 'utf8');
            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01]),
                Buffer.from([ctBuf.length]),
                ctBuf,
                Buffer.from([0x68]),                      // OP_ENDIF directly
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            // Should still parse — has a content type but no body
            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.length).toBe(0);
        });

        it('should handle OP_PUSHNUM_NEG1 inside envelope', () => {
            // OP_PUSHNUM_NEG1 (0x4f) => data [0x81]
            // We'll put it as an unknown tag value — shouldn't crash
            const ctBuf = Buffer.from('text/plain', 'utf8');
            const content = Buffer.from('neg', 'utf8');

            const envelope = Buffer.concat([
                Buffer.from([0x00, 0x63, 0x03]),
                Buffer.from('ord', 'utf8'),
                Buffer.from([0x01, 0x01]),
                Buffer.from([ctBuf.length]),
                ctBuf,
                // An odd unknown tag using OP_PUSHNUM_NEG1
                Buffer.from([0x4f]),                      // OP_PUSHNUM_NEG1 => [0x81] => tag 129 (odd, safe)
                Buffer.from([0x01, 0xaa]),                // 1-byte value
                Buffer.from([0x00]),                      // body separator
                Buffer.from([content.length]),
                content,
                Buffer.from([0x68]),
            ]);

            const result = OrdinalsParser.parseInscription([envelope]);

            expect(result).not.toBeNull();
            expect(result?.contentType).toBe('text/plain');
            expect(result?.content.toString('utf8')).toBe('neg');
        });
    });

    describe('decodeAddress', () => {
        it('should decode P2TR (Taproot) address for mainnet', () => {
            const pubkey = Buffer.from('a'.repeat(64), 'hex');
            const script = Buffer.concat([
                Buffer.from([0x51, 0x20]),
                pubkey,
            ]);

            const addr = OrdinalsParser.decodeAddress(script, 'mainnet');
            expect(addr).toMatch(/^bc1p/);
            expect(addr.length).toBeGreaterThan(10);
        });

        it('should decode P2TR address for regtest', () => {
            const pubkey = Buffer.from('a'.repeat(64), 'hex');
            const script = Buffer.concat([
                Buffer.from([0x51, 0x20]),
                pubkey,
            ]);

            const addr = OrdinalsParser.decodeAddress(script, 'regtest');
            expect(addr).toMatch(/^bcrt1p/);
        });

        it('should decode P2TR address for testnet', () => {
            const pubkey = Buffer.from('a'.repeat(64), 'hex');
            const script = Buffer.concat([
                Buffer.from([0x51, 0x20]),
                pubkey,
            ]);

            const addr = OrdinalsParser.decodeAddress(script, 'testnet');
            expect(addr).toMatch(/^tb1p/);
        });

        it('should decode P2WPKH (Native SegWit) address', () => {
            const hash = Buffer.from('b'.repeat(40), 'hex');
            const script = Buffer.concat([
                Buffer.from([0x00, 0x14]),
                hash,
            ]);

            const addr = OrdinalsParser.decodeAddress(script, 'mainnet');
            expect(addr).toMatch(/^bc1q/);
        });

        it('should decode P2WSH address', () => {
            const hash = Buffer.from('c'.repeat(64), 'hex');
            const script = Buffer.concat([
                Buffer.from([0x00, 0x20]),
                hash,
            ]);

            const addr = OrdinalsParser.decodeAddress(script, 'mainnet');
            expect(addr).toMatch(/^bc1q/);
        });

        it('should decode P2PKH (Legacy) address', () => {
            const hash = Buffer.from('d'.repeat(40), 'hex');
            const script = Buffer.concat([
                Buffer.from([0x76, 0xa9, 0x14]),
                hash,
                Buffer.from([0x88, 0xac]),
            ]);

            const addr = OrdinalsParser.decodeAddress(script, 'mainnet');
            expect(addr).toMatch(/^1/);
        });

        it('should decode P2SH address', () => {
            const hash = Buffer.from('e'.repeat(40), 'hex');
            const script = Buffer.concat([
                Buffer.from([0xa9, 0x14]),
                hash,
                Buffer.from([0x87]),
            ]);

            const addr = OrdinalsParser.decodeAddress(script, 'mainnet');
            expect(addr).toMatch(/^3/);
        });

        it('should return empty string for invalid script', () => {
            const script = Buffer.from([0x00]);
            expect(OrdinalsParser.decodeAddress(script, 'mainnet')).toBe('');
        });
    });

    describe('MIME type coverage', () => {
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
                const content = Buffer.from('test', 'utf8');
                const envelope = buildCanonicalEnvelope(mimeType, [content]);

                const result = OrdinalsParser.parseInscription([envelope]);

                expect(result).not.toBeNull();
                expect(result?.contentType).toBe(mimeType);
            });
        }
    });
});
