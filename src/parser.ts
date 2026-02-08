import { address, networks, type Network } from '@btc-vision/bitcoin';
import { Logger } from '@btc-vision/logger';
import type { InscriptionEnvelope } from './types.js';

/**
 * Ordinals envelope tag numbers per the official ord specification.
 * Tags are data pushes of the tag byte value, NOT OP_PUSHNUM opcodes.
 * However, OP_PUSHNUM_1..16 are accepted as equivalent.
 */
const enum Tag {
    ContentType = 1,
    Pointer = 2,
    Parent = 3,
    Metadata = 5,
    Metaprotocol = 7,
    ContentEncoding = 9,
    Delegate = 11,
}

interface ScriptPush {
    readonly data: Buffer;
    readonly nextOffset: number;
}

const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_PUSHNUM_NEG1 = 0x4f;
const OP_PUSHNUM_1 = 0x51;
const OP_PUSHNUM_16 = 0x60;

const ORD_MARKER = Buffer.from('ord', 'utf8');

/**
 * Ordinals inscription parser
 *
 * Implements the official ord specification:
 *   OP_FALSE OP_IF PUSH("ord") [tag value]... PUSH_EMPTY [body]... OP_ENDIF
 *
 * Handles both canonical data-push encoding (OP_PUSHBYTES_1 0x01 for tag 1)
 * and OP_PUSHNUM encoding (OP_1 / 0x51 for tag 1).
 *
 * @see https://github.com/ordinals/ord
 */
export class OrdinalsParser {
    private static readonly logger: Logger = new Logger();

    /**
     * Parse Ordinals inscription from a witness stack.
     *
     * Per the ord spec, inscriptions live in the tapscript (second-to-last
     * witness item in a taproot script-path spend). We also scan all items
     * for robustness.
     *
     * @param witness - Array of witness stack items (Buffers)
     * @returns Parsed inscription envelope, or null if none found
     */
    public static parseInscription(witness: Buffer[]): InscriptionEnvelope | null {
        for (const witnessItem of witness) {
            const envelope = this.extractEnvelope(witnessItem);
            if (envelope !== null) {
                return envelope;
            }
        }
        return null;
    }

    /**
     * Decode a Bitcoin address from an output script using @btc-vision/bitcoin.
     */
    public static decodeAddress(script: Buffer, networkName: 'mainnet' | 'testnet' | 'regtest'): string {
        try {
            const net: Network = this.resolveNetwork(networkName);
            return address.fromOutputScript(Uint8Array.from(script), net);
        } catch {
            return '';
        }
    }

    /**
     * Read one push instruction from raw script bytes at the given offset.
     *
     * Returns the pushed data and the offset of the next instruction, or
     * null if the byte at `offset` is not a push opcode.
     */
    private static readPush(script: Buffer, offset: number): ScriptPush | null {
        if (offset >= script.length) return null;

        const opcode = script[offset];

        // OP_0 / OP_FALSE — pushes empty bytes
        if (opcode === OP_FALSE) {
            return { data: Buffer.alloc(0), nextOffset: offset + 1 };
        }

        // OP_PUSHBYTES_1 .. OP_PUSHBYTES_75 — opcode IS the length
        if (opcode >= 0x01 && opcode <= 0x4b) {
            const end = offset + 1 + opcode;
            if (end > script.length) return null;
            return { data: script.subarray(offset + 1, end), nextOffset: end };
        }

        // OP_PUSHDATA1
        if (opcode === OP_PUSHDATA1) {
            if (offset + 2 > script.length) return null;
            const len = script[offset + 1];
            const end = offset + 2 + len;
            if (end > script.length) return null;
            return { data: script.subarray(offset + 2, end), nextOffset: end };
        }

        // OP_PUSHDATA2
        if (opcode === OP_PUSHDATA2) {
            if (offset + 3 > script.length) return null;
            const len = script.readUInt16LE(offset + 1);
            const end = offset + 3 + len;
            if (end > script.length) return null;
            return { data: script.subarray(offset + 3, end), nextOffset: end };
        }

        // OP_PUSHDATA4
        if (opcode === OP_PUSHDATA4) {
            if (offset + 5 > script.length) return null;
            const len = script.readUInt32LE(offset + 1);
            const end = offset + 5 + len;
            if (end > script.length) return null;
            return { data: script.subarray(offset + 5, end), nextOffset: end };
        }

        // OP_PUSHNUM_NEG1 (0x4f) — pushes [0x81]
        if (opcode === OP_PUSHNUM_NEG1) {
            return { data: Buffer.from([0x81]), nextOffset: offset + 1 };
        }

        // OP_PUSHNUM_1 (0x51) through OP_PUSHNUM_16 (0x60)
        if (opcode >= OP_PUSHNUM_1 && opcode <= OP_PUSHNUM_16) {
            return { data: Buffer.from([opcode - 0x50]), nextOffset: offset + 1 };
        }

        // Not a push instruction
        return null;
    }

    /**
     * Extract an inscription envelope from a script buffer.
     *
     * Scans for the OP_FALSE OP_IF pattern, verifies the "ord" protocol ID,
     * collects all push payloads until OP_ENDIF, then parses tag/value fields
     * and body content.
     */
    private static extractEnvelope(script: Buffer): InscriptionEnvelope | null {
        try {
            const len = script.length;
            let i = 0;

            while (i < len - 1) {
                // Scan for OP_FALSE OP_IF
                if (script[i] !== OP_FALSE || script[i + 1] !== OP_IF) {
                    i++;
                    continue;
                }

                i += 2; // skip past OP_FALSE OP_IF

                // Next instruction must be a push of "ord" (3 bytes)
                const markerPush = this.readPush(script, i);
                if (
                    markerPush === null ||
                    markerPush.data.length !== 3 ||
                    !markerPush.data.equals(ORD_MARKER)
                ) {
                    // Not an ord envelope — keep scanning
                    continue;
                }
                i = markerPush.nextOffset;

                // Collect all push payloads until OP_ENDIF or a non-push opcode
                const payloads: Buffer[] = [];
                while (i < len) {
                    if (script[i] === OP_ENDIF) {
                        break;
                    }

                    const push = this.readPush(script, i);
                    if (push === null) {
                        // Non-push opcode inside envelope — stop collecting
                        break;
                    }

                    payloads.push(push.data);
                    i = push.nextOffset;
                }

                // Parse tag/value pairs and body from collected payloads
                return this.parsePayloads(payloads);
            }

            return null;
        } catch (error) {
            this.logger.error(`Error extracting envelope: ${String(error)}`);
            return null;
        }
    }

    /**
     * Parse collected push payloads into an InscriptionEnvelope.
     *
     * Fields are tag/value pairs consumed in order. The body starts at the
     * first empty payload at an even index (0, 2, 4, ...). Everything after
     * the body separator is concatenated as the inscription body.
     */
    private static parsePayloads(payloads: Buffer[]): InscriptionEnvelope | null {
        let contentType = '';
        let pointer: Buffer | undefined;
        let parent: Buffer | undefined;
        let metadataChunks: Buffer[] | undefined;
        let metaprotocol: string | undefined;
        let contentEncoding: string | undefined;
        let delegate: Buffer | undefined;

        let bodyStart = -1;

        // Walk payloads as tag/value pairs
        for (let idx = 0; idx < payloads.length; idx += 2) {
            const tagPayload = payloads[idx];

            // Body separator: empty push at an even index
            if (tagPayload.length === 0) {
                bodyStart = idx + 1;
                break;
            }

            // Tag must be exactly 1 byte
            if (tagPayload.length !== 1) {
                // Unknown multi-byte tag — skip this pair
                continue;
            }

            const tag = tagPayload[0];
            const valueIdx = idx + 1;
            if (valueIdx >= payloads.length) {
                // Incomplete field — no value for this tag
                break;
            }

            const value = payloads[valueIdx];

            switch (tag) {
                case Tag.ContentType:
                    if (contentType === '') {
                        contentType = value.toString('utf8');
                    }
                    break;
                case Tag.Pointer:
                    if (pointer === undefined) {
                        pointer = Buffer.from(value);
                    }
                    break;
                case Tag.Parent:
                    if (parent === undefined) {
                        parent = Buffer.from(value);
                    }
                    break;
                case Tag.Metadata:
                    // Metadata is a chunked tag — concatenate all occurrences
                    if (metadataChunks === undefined) metadataChunks = [];
                    metadataChunks.push(value);
                    break;
                case Tag.Metaprotocol:
                    if (metaprotocol === undefined) {
                        metaprotocol = value.toString('utf8');
                    }
                    break;
                case Tag.ContentEncoding:
                    if (contentEncoding === undefined) {
                        contentEncoding = value.toString('utf8');
                    }
                    break;
                case Tag.Delegate:
                    if (delegate === undefined) {
                        delegate = Buffer.from(value);
                    }
                    break;
                default:
                    // Unknown tag — ignore (odd tags are safe to ignore per spec)
                    break;
            }
        }

        // Concatenate body chunks
        let content: Buffer;
        if (bodyStart >= 0 && bodyStart < payloads.length) {
            const bodyChunks = payloads.slice(bodyStart);
            content = bodyChunks.length === 1 ? bodyChunks[0] : Buffer.concat(bodyChunks);
        } else {
            content = Buffer.alloc(0);
        }

        // Must have at least a content type or content to be valid
        if (contentType === '' && content.length === 0) {
            return null;
        }

        this.logger.debug(
            `Found inscription: ${contentType || '(no content-type)'}, ${content.length} bytes`
        );

        return {
            content,
            contentType,
            pointer,
            parent,
            metadata: metadataChunks ? Buffer.concat(metadataChunks) : undefined,
            metaprotocol,
            contentEncoding,
            delegate,
        };
    }

    private static resolveNetwork(name: 'mainnet' | 'testnet' | 'regtest'): Network {
        switch (name) {
            case 'mainnet':
                return networks.bitcoin;
            case 'testnet':
                return networks.testnet;
            case 'regtest':
                return networks.regtest;
        }
    }
}
