# Ordinals Compatibility

## Relationship to Official ord Client

This OPNet Ordinals Indexer plugin implements the **Ordinals inscription envelope format** as specified in the official Ordinals protocol (https://github.com/ordinals/ord), but is a **custom implementation** specifically designed for the OPNet blockchain.

### What We Share with Official ord

#### 1. **Inscription Envelope Format**

Both this plugin and the official ord client use the same envelope format:

```
OP_FALSE OP_IF "ord" 0x01 <content-type> 0x00 <content> OP_ENDIF
```

Example inscription structure:
```
OP_FALSE (0x00)
OP_IF (0x63)
OP_PUSHBYTES_3 "ord"
OP_PUSHBYTES_1 0x01
OP_PUSHDATA <content-type>  // e.g., "image/png"
OP_0 (0x00)
OP_PUSHDATA <content>       // The actual data
OP_ENDIF (0x68)
```

#### 2. **Witness Data Location**

Inscriptions are embedded in Bitcoin SegWit witness data, not in transaction outputs. Both implementations:
- Parse witness stack items from Bitcoin transactions
- Look for the inscription envelope pattern
- Extract content type and content data

#### 3. **Content Types**

Support for standard MIME types:
- `text/plain` - Text inscriptions
- `image/png` - PNG images
- `image/jpeg` - JPEG images
- `image/svg+xml` - SVG graphics
- `image/webp` - WebP images
- `text/html` - HTML documents
- `application/json` - JSON data
- And any other valid MIME type

### How We Differ from Official ord

#### 1. **Target Blockchain**

- **Official ord:** Bitcoin mainnet only
- **This plugin:** OPNet (Bitcoin L1 consensus layer)
  - Works with OPNet's mainnet, testnet, and regtest
  - Integrates with OPNet's RPC provider
  - Uses OPNet's block witness data structure

#### 2. **Indexing Implementation**

- **Official ord:** Built in Rust, runs as standalone indexer/wallet
- **This plugin:** Built in TypeScript, runs as OPNet node plugin
  - Uses OPNet's `JSONRpcProvider` for blockchain data
  - PostgreSQL for inscription storage (ord uses internal database)
  - REST API for queries (ord has its own API format)

#### 3. **Inscription Numbering**

- **Official ord:** Complex satoshi tracking with inscription numbers based on first satoshi
- **This plugin:** Sequential numbering based on discovery order in blocks
  - Simpler, more straightforward
  - No satoshi tracking overhead

#### 4. **Address Decoding**

- **Official ord:** Full Bitcoin address support with extensive validation
- **This plugin:** Simplified address decoding for common types:
  - P2TR (Taproot)
  - P2WPKH (Native SegWit)
  - P2WSH (SegWit script hash)
  - P2PKH (Legacy)
  - P2SH (Script hash)

## Can inscriptions created with ord be indexed by this plugin?

**Yes!** If Ordinals inscriptions created with the official ord client are broadcast to Bitcoin and then included in OPNet's consensus layer, this plugin will index them correctly because:

1. The envelope format is identical
2. The witness data structure is the same
3. The content-type and content extraction logic matches the spec

## Can this plugin index Bitcoin mainnet Ordinals?

Not directly. This plugin is designed for OPNet, which is a Bitcoin L1 consensus layer. To index Bitcoin mainnet Ordinals:

1. **Use official ord client** for Bitcoin mainnet
2. **Modify this plugin** to connect to Bitcoin Core RPC instead of OPNet RPC
3. **Bridge approach:** Run both indexers and cross-reference data

## Production Use Cases

### For OPNet Users

This plugin is ideal if you're:
- Building on OPNet
- Want to track Ordinals on OPNet's consensus layer
- Need a REST API for inscription queries
- Want PostgreSQL storage for advanced queries

### For Bitcoin Ordinals

For indexing Bitcoin mainnet Ordinals, use the official ord client:
```bash
# Official ord installation
git clone https://github.com/ordinals/ord
cd ord
cargo build --release

# Run indexer
./target/release/ord server
```

## Technical Implementation Details

### Envelope Parsing

Our parser (`src/parser.ts`) implements the official spec:

```typescript
// Look for: OP_FALSE OP_IF "ord"
if (script[i] === 0x00 && script[i + 1] === 0x63) {
    // Check for "ord" marker
    if (script[offset] === 0x03 &&
        script.slice(offset + 1, offset + 4).toString() === 'ord') {
        // Extract content type and content
        // ...
    }
}
```

### Standards Compliance

This implementation follows:
- **Ordinals Protocol:** Envelope format, witness data structure
- **Bitcoin SegWit:** Witness stack parsing
- **MIME Types:** RFC 6838 standard content types

## Future Compatibility

As the Ordinals protocol evolves, updates to this plugin would include:
- New inscription formats (e.g., chunked content)
- Recursive inscriptions support
- Metadata standards
- Parent-child inscription relationships

## References

- **Official Ordinals:** https://github.com/ordinals/ord
- **Ordinals Handbook:** https://docs.ordinals.com/
- **OPNet Documentation:** https://opnet.org/docs
- **Bitcoin SegWit:** BIP 141, BIP 143, BIP 144

## License

This plugin is independent software that implements the Ordinals specification. It is not affiliated with or endorsed by the official ord project.
