# OPNet Ordinals Indexer + OP721 Bridge

A production-ready system that indexes Bitcoin Ordinals inscriptions on the OPNet blockchain and provides an automated burn-to-mint bridge, allowing users to permanently burn their Bitcoin Ordinals and receive OP721 NFTs on OPNet in return.

## What This Does

This project has two main capabilities:

### 1. Ordinals Indexer
Scans every OPNet block via JSON-RPC, parses the raw witness data from each transaction looking for Ordinals inscription envelopes (the `OP_FALSE OP_IF PUSH("ord") ... OP_ENDIF` pattern), extracts the content type and binary content, stores everything in PostgreSQL, and serves it through a REST API.

Supports all Ordinals envelope tags: content type, pointer, parent, metadata, metaprotocol, content encoding, and delegate.

### 2. Burn-to-Mint Bridge (optional)
Monitors the indexed transactions for inscriptions sent to a designated burn address (typically the Satoshi genesis address `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`). When a burn is detected and confirmed, an attestation worker automatically calls `attestBurn()` on the OP721 smart contract deployed on OPNet, minting the corresponding NFT to the sender's address.

Users pay a configurable bridge fee (in sats) to cover the deployer's on-chain transaction costs.

## Architecture

```
                              OPNet Blockchain
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            JSON-RPC Provider    Block Data    Transaction Data
                    │               │               │
                    └───────┬───────┘               │
                            ▼                       │
                    ┌───────────────┐               │
                    │  Plugin.ts    │◄──────────────┘
                    │  (orchestrator)│
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
     ┌────────────┐  ┌───────────┐  ┌──────────┐
     │  Parser.ts │  │ Bridge.ts │  │ API.ts   │
     │  (witness  │  │ (burn     │  │ (REST    │
     │  envelopes)│  │ detection)│  │ server)  │
     └─────┬──────┘  └─────┬─────┘  └────┬─────┘
           ▼               ▼              ▼
     ┌───────────┐   ┌──────────┐   ┌──────────┐
     │ Database  │   │ Bridge   │   │ Bridge   │
     │ (inscr.)  │   │ Database │   │ API      │
     └───────────┘   └─────┬────┘   └──────────┘
                           ▼
                    ┌─────────────┐
                    │ Attestation │
                    │ Worker      │
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  OP721      │
                    │  Contract   │
                    │  (on-chain) │
                    └─────────────┘
```

## How the Bridge Works (Step by Step)

### For the Deployer (You)

1. **Deploy the OP721 contract** — Compile and deploy `contract/src/OrdinalsBridgeNFT.ts` to OPNet. This is an AssemblyScript smart contract that compiles to WASM. It extends the OP721 standard (OPNet's NFT standard) with three custom methods: `attestBurn()`, `isInscriptionClaimed()`, and `attestCount()`.

2. **Prepare your collection JSON** — Create a JSON file that maps each Ordinals inscription ID to its metadata. The array index becomes the OP721 token ID:
   ```json
   [
     {
       "id": "abc123def456...i0",
       "meta": {
         "name": "My NFT #0001",
         "attributes": [
           { "trait_type": "Background", "value": "Blue" },
           { "trait_type": "Rarity", "value": "Legendary" }
         ],
         "high_res_img_url": "https://example.com/0001.png"
       }
     },
     {
       "id": "789ghi012jkl...i0",
       "meta": {
         "name": "My NFT #0002",
         "attributes": [...]
       }
     }
   ]
   ```
   Each `id` is the full Ordinals inscription ID (`{txid}i{vout_index}`). Token ID 0 = array index 0, token ID 1 = array index 1, etc.

3. **Configure the environment** — Set up your `.env` file with:
   - Your OPNet RPC endpoint
   - PostgreSQL connection string
   - The burn address (where users will send inscriptions to destroy them)
   - Your collection JSON file path
   - Your deployer mnemonic (the same wallet that deployed the contract)
   - The deployed contract address
   - Your oracle fee address (where users pay you)
   - The minimum fee in sats

4. **Start the plugin** — `npm run build && npm start`. It begins scanning blocks, indexing inscriptions, detecting burns, confirming them after N blocks, and automatically submitting `attestBurn()` transactions.

### For Users (Bridging Their Ordinal)

1. **User constructs a burn transaction** with exactly this output structure:
   ```
   Output 0: inscription → burn address     (sends the ordinal to be destroyed)
   Output 1: bridge fee  → oracle fee addr  (pays the deployer for gas costs)
   Output 2: change      → back to sender   (their change + identifies their address)
   ```

2. **Plugin detects the burn** — When the block containing this transaction is processed, the plugin sees output 0 goes to the burn address. It looks up the inscription ID (from the input's previous outpoint) in the collection. If it matches, a burn claim is created.

3. **Fee check** — The plugin checks output 1 to see if it pays the oracle fee address with at least `BRIDGE_MIN_FEE_SATS`. If the fee is insufficient, the claim is marked `underpaid` and will not proceed. The burn is still recorded so the user can see what happened via the API.

4. **Confirmation wait** — The claim stays in `detected` status until `BRIDGE_CONFIRMATIONS` blocks have passed (default: 6). This prevents minting on transactions that get reorged.

5. **Automatic attestation** — Once confirmed, the attestation worker:
   - Hashes the inscription ID with keccak256 to get a u256
   - Converts the sender's bech32 address to an OPNet Address
   - Simulates `attestBurn(to, inscriptionHash, tokenId)` to check it won't revert
   - Signs and broadcasts the transaction using the deployer's wallet
   - Chains UTXOs between attestations (up to 20 per block cycle)
   - Marks the claim as `attested` with the transaction ID

6. **User receives their OP721 NFT** — The contract mints the token to the sender's address. The inscription hash is permanently marked as claimed on-chain, preventing double-minting.

### Claim Lifecycle

```
             ┌─────────┐
             │ detected │ ← Burn seen on-chain, waiting for confirmations
             └────┬─────┘
                  │
       ┌──────────┼──────────┐
       ▼                     ▼
┌────────────┐        ┌───────────┐
│ underpaid  │        │ confirmed │ ← Enough confirmations, ready for attestation
│ (stuck)    │        └─────┬─────┘
└────────────┘              │
                  ┌─────────┼─────────┐
                  ▼                   ▼
           ┌──────────┐        ┌──────────┐
           │ attested │        │  failed  │ ← Contract reverted or broadcast error
           │ (done!)  │        └─────┬────┘
           └──────────┘              │
                                     ▼
                              POST /bridge/retry-failed
                                     │
                                     ▼
                              ┌───────────┐
                              │ confirmed │ ← Back in the queue
                              └───────────┘
```

- **detected** — Burn tx seen on-chain, waiting for block confirmations
- **underpaid** — Burn seen but bridge fee was insufficient (permanently stuck unless re-bridged)
- **confirmed** — Enough confirmations passed, queued for attestation
- **attested** — `attestBurn()` successfully submitted on-chain, NFT minted
- **failed** — Attestation reverted or errored, can be retried via API

## On-Chain Guarantees vs Off-Chain Trust

What the **smart contract enforces** (trustless):
- Each inscription hash can only be claimed **once** (double-mint protection)
- Each token ID can only be minted **once**
- Max supply cannot be exceeded
- Only the contract deployer can call `attestBurn()`
- Standard OP721 ownership, transfers, and balance tracking

What the **oracle is trusted for** (not trustless):
- Honestly reporting that a burn actually happened on Bitcoin
- Correctly mapping inscription IDs to the right token IDs
- Not front-running or censoring specific burns
- Running the attestation worker reliably

This is the same oracle/attestor trust model used by WBTC, most cross-chain bridges, and Chainlink data feeds. The deployer is the single trusted party. Burns are irreversible regardless — once an ordinal is sent to the burn address, it's gone forever.

## Prerequisites

- Node.js >= 22.0.0
- PostgreSQL (any recent version)

## Setup

```bash
# Clone the repo
git clone https://github.com/bc1plainview/opnet-ordinals-plugin.git
cd opnet-ordinals-plugin

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings (see Configuration below)

# Build
npm run build

# Run tests (163 tests across 7 suites)
npm test

# Start the plugin
npm start
```

## Configuration

### Core Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `OPNET_RPC_URL` | OPNet JSON-RPC endpoint | `https://regtest.opnet.org` |
| `NETWORK` | `mainnet`, `testnet`, or `regtest` | `regtest` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://localhost/ordinals` |
| `API_PORT` | REST API port | `3002` |
| `START_HEIGHT` | Block height to start indexing from | `0` |
| `ENABLE_API` | Enable the REST API server | `true` |

### Bridge Settings (optional — set both to enable)

| Variable | Description |
|----------|-------------|
| `BRIDGE_BURN_ADDRESS` | Bitcoin address where inscriptions are burned (e.g. `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`) |
| `BRIDGE_COLLECTION_FILE` | Path to collection JSON file |
| `BRIDGE_COLLECTION_NAME` | Display name for the collection (e.g. `MotoCats`) |
| `BRIDGE_COLLECTION_SYMBOL` | Symbol (e.g. `MCAT`) |
| `BRIDGE_CONFIRMATIONS` | Block confirmations required before minting (default: `6`) |

### Attestation Worker Settings (optional — set both to enable auto-minting)

| Variable | Description |
|----------|-------------|
| `DEPLOYER_MNEMONIC` | BIP39 mnemonic for the contract deployer wallet |
| `BRIDGE_CONTRACT_ADDRESS` | Deployed OP721 bridge contract address on OPNet |
| `ORACLE_FEE_ADDRESS` | Bitcoin address where users pay the bridge fee |
| `BRIDGE_MIN_FEE_SATS` | Minimum sats required from user per burn (default: `0` = free) |

### Cost Estimate

Each `attestBurn()` is a Bitcoin L1 transaction containing an OPNet contract interaction:
- **Mining fee**: ~200-400 vbytes at current fee rate (e.g. 10 sat/vB = 2,000-4,000 sats)
- **OPNet gas**: varies by contract execution (~1,000-5,000 sats)
- **Total per attestation**: ~5,000-15,000 sats (~$5-15 at $100K BTC)
- **Safe default fee**: `BRIDGE_MIN_FEE_SATS=10000` (0.0001 BTC)

The attestation worker caps spending at 100,000 sats per attestation as a safety limit.

## REST API

### Indexer Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (returns `{ status: "ok" }`) |
| GET | `/inscription/:id` | Get inscription by ID (content as base64) |
| GET | `/content/:id` | Raw inscription content (binary, with correct Content-Type) |
| GET | `/inscriptions/owner/:address` | Inscriptions by owner (`?limit=&offset=`) |
| GET | `/inscriptions/latest` | Latest inscriptions (`?limit=`, max 100) |
| GET | `/inscriptions/type/:contentType` | Inscriptions by MIME type (`?limit=`) |
| GET | `/stats` | Indexer statistics (total inscriptions, owners, content types) |

### Bridge Endpoints (only available when bridge is enabled)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/bridge/stats` | Bridge statistics (counts by status, fee info, collection size) |
| GET | `/bridge/claim/:inscriptionId` | Claim status for a specific inscription |
| GET | `/bridge/claims/sender/:address` | All claims by sender address (`?limit=&offset=`) |
| GET | `/bridge/collection` | Collection info (name, symbol, size, burn address) |
| GET | `/bridge/collection/check/:inscriptionId` | Check if inscription is in collection (returns tokenId + meta) |
| GET | `/bridge/collection/token/:tokenId` | Get collection item by token ID |
| POST | `/bridge/retry-failed` | Retry all failed attestations (resets them to confirmed) |

### Example API Responses

**GET /bridge/claim/abc123...i0** (attested):
```json
{
  "inscriptionId": "abc123...i0",
  "collectionName": "MotoCats",
  "tokenId": 42,
  "senderAddress": "bc1q...",
  "burnTxid": "def456...",
  "burnBlockHeight": 850000,
  "status": "attested",
  "attestTxid": "789abc..."
}
```

**GET /bridge/claim/xyz789...i0** (underpaid):
```json
{
  "inscriptionId": "xyz789...i0",
  "collectionName": "MotoCats",
  "tokenId": 7,
  "senderAddress": "bc1q...",
  "status": "underpaid",
  "message": "Burn detected but the bridge fee was insufficient. Please re-submit with the required fee to the oracle fee address."
}
```

**GET /bridge/stats**:
```json
{
  "total": 150,
  "detected": 3,
  "confirmed": 1,
  "attested": 142,
  "failed": 0,
  "underpaid": 4,
  "collectionSize": 10000,
  "burnAddress": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  "requiredConfirmations": 6,
  "minFeeSats": 10000
}
```

## Smart Contract

The OP721 contract lives in `contract/` and is written in AssemblyScript for the OPNet WASM runtime.

### Building the Contract

```bash
cd contract
npm install
npm run build
# Output: contract/build/OrdinalsBridgeNFT.wasm
```

### Contract Methods

| Method | Access | Description |
|--------|--------|-------------|
| `attestBurn(to, inscriptionHash, tokenId)` | Deployer only | Mint OP721 after verifying inscription burn. Reverts if inscription already claimed, token already exists, or max supply reached. |
| `isInscriptionClaimed(inscriptionHash)` | Public (view) | Check if an inscription hash has already been bridged |
| `attestCount()` | Public (view) | Total number of attestations processed |
| `name()` | Public (view) | Collection name (set on deployment) |
| `symbol()` | Public (view) | Collection symbol (set on deployment) |
| `ownerOf(tokenId)` | Public (view) | Owner of a specific token |
| `balanceOf(owner)` | Public (view) | Number of tokens owned by an address |
| `tokenOfOwnerByIndex(owner, index)` | Public (view) | Enumerate tokens owned by an address |
| `safeTransfer(from, to, tokenId)` | Token owner | Transfer a token |

### Deployment Calldata

The contract expects this calldata on deployment:
1. `string` — Collection name
2. `string` — Collection symbol
3. `string` — Base metadata URI
4. `u256` — Max supply

### Client-Side ABI

The package exports a TypeScript ABI and interface for interacting with the deployed contract from any OPNet client:

```typescript
import {
    ORDINALS_BRIDGE_NFT_ABI,
    IOrdinalsBridgeNFTContract,
} from 'opnet-ordinals-plugin';
import { getContract, JSONRpcProvider } from 'opnet';
import { networks } from '@btc-vision/bitcoin';

const provider = new JSONRpcProvider('https://regtest.opnet.org', networks.regtest);

const nft = getContract<IOrdinalsBridgeNFTContract>(
    contractAddress,
    ORDINALS_BRIDGE_NFT_ABI,
    provider,
    networks.regtest,
);

// Check if an inscription has been bridged
const result = await nft.isInscriptionClaimed(inscriptionHash);
console.log('Claimed:', result.properties.claimed);

// Get total attestation count
const count = await nft.attestCount();
console.log('Total bridged:', count.properties.count);
```

## Project Structure

```
src/
  index.ts               Entry point + env config loading
  plugin.ts              Main orchestrator (block loop, burn detection, attestation)
  parser.ts              Ordinals witness envelope parser (OP_FALSE OP_IF ... OP_ENDIF)
  database.ts            PostgreSQL layer for inscriptions
  api.ts                 REST API for inscriptions (Express)
  collection.ts          Collection registry (JSON loader, inscription→tokenId mapping)
  bridge.ts              Bridge service (burn validation, claim lifecycle, fee checking)
  bridge-database.ts     PostgreSQL layer for burn claims
  bridge-api.ts          REST API for bridge endpoints
  bridge-abi.ts          Client-side ABI + TypeScript interface for the OP721 contract
  attestation-worker.ts  Automatic attestBurn() transaction builder + broadcaster
  types.ts               Shared TypeScript type definitions
contract/
  src/
    OrdinalsBridgeNFT.ts   OP721 smart contract (AssemblyScript → WASM)
    index.ts               Contract entry point
tests/
  parser.test.ts              Ordinals parser (envelope extraction, all tag types)
  integration.test.ts         Full plugin integration (block processing, reorgs)
  collection.test.ts          Collection registry (loading, lookups, edge cases)
  bridge.test.ts              Bridge service (burn processing, confirmations, underpaid)
  bridge-database.test.ts     Bridge database (SQL schema, CRUD operations)
  bridge-api.test.ts          Bridge API routes (all endpoints, error handling)
  attestation-worker.test.ts  Attestation worker (hashing, address conversion, lifecycle)
```

## Running Modes

The plugin supports three configurations depending on which env vars are set:

### Indexer Only
Set core vars only. No bridge vars. Indexes inscriptions and serves the REST API.

### Indexer + Bridge Detection
Set `BRIDGE_BURN_ADDRESS` + `BRIDGE_COLLECTION_FILE`. Indexes inscriptions AND detects burns, but does not automatically attest. You can monitor claims via the API and attest manually.

### Full Automated Bridge
Set all vars including `DEPLOYER_MNEMONIC` + `BRIDGE_CONTRACT_ADDRESS`. Fully automated: indexes, detects burns, confirms, and automatically mints OP721 NFTs.

## Reorg Handling

The plugin detects blockchain reorganizations by comparing each block's `previousBlockHash` against the last processed block hash. On reorg:
1. Inscriptions from the invalidated height are deleted from PostgreSQL
2. Unconfirmed burn claims from the invalidated height are deleted
3. The indexer resets to the fork point and re-processes

Confirmed/attested claims are NOT deleted during a reorg (they've already been submitted on-chain).

## Package Exports

When used as an npm dependency (`import from 'opnet-ordinals-plugin'`):

```typescript
// Classes
export { OrdinalsIndexerPlugin } from './plugin.js';
export { CollectionRegistry } from './collection.js';
export { BridgeService } from './bridge.js';
export { BridgeDatabase } from './bridge-database.js';
export { BridgeAPI } from './bridge-api.js';
export { AttestationWorker } from './attestation-worker.js';

// ABI + contract interface
export { ORDINALS_BRIDGE_NFT_ABI } from './bridge-abi.js';
export type { IOrdinalsBridgeNFTContract } from './bridge-abi.js';
export type { AttestBurnResult, IsInscriptionClaimedResult, AttestCountResult } from './bridge-abi.js';
export type { InscriptionBridgedEvent } from './bridge-abi.js';

// Types
export type { OrdinalsPluginConfig, Inscription, BurnClaim, BurnClaimStatus, BridgeConfig } from './types.js';
export type { CollectionItem, IndexedCollectionItem } from './collection.js';
export type { DetectedBurn } from './bridge.js';
```

## License

MIT
