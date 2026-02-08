# OPNet Ordinals Indexer + OP721 Bridge

Indexes Bitcoin Ordinals inscriptions on the OPNet blockchain and provides an optional burn-to-mint bridge that lets users burn their Ordinals and receive an OP721 NFT on OPNet.

## How It Works

**Indexer** — Scans OPNet blocks via JSON-RPC, extracts Ordinals inscription envelopes from witness data, stores them in PostgreSQL, and exposes a REST API.

**Bridge** (optional) — Monitors for inscriptions sent to a burn address. When a burn is detected and confirmed, an **attestation worker** automatically calls `attestBurn()` on the OP721 contract to mint the corresponding NFT to the sender. Users pay a configurable bridge fee to cover the deployer's on-chain transaction costs.

```
Bitcoin Block → Plugin → Parser (witness envelopes) → PostgreSQL
                  ↓                                        ↓
            Burn Detector → Bridge Service            REST API
                  ↓              ↓
            Fee Check    Attestation Worker
                  ↓              ↓
         underpaid?     attestBurn() → OP721 Contract → NFT minted
```

## Prerequisites

- Node.js >= 22.0.0
- PostgreSQL

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your configuration
```

## Configuration

See `.env.example` for all options. Core settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPNET_RPC_URL` | OPNet JSON-RPC endpoint | `https://regtest.opnet.org` |
| `NETWORK` | `mainnet`, `testnet`, or `regtest` | `regtest` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://localhost/ordinals` |
| `API_PORT` | REST API port | `3002` |
| `START_HEIGHT` | Block height to start indexing from | `0` |

### Bridge (optional)

Set both `BRIDGE_BURN_ADDRESS` and `BRIDGE_COLLECTION_FILE` to enable:

| Variable | Description |
|----------|-------------|
| `BRIDGE_BURN_ADDRESS` | Address users send inscriptions to burn (e.g. `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`) |
| `BRIDGE_COLLECTION_FILE` | Path to collection JSON file |
| `BRIDGE_COLLECTION_NAME` | Display name for the collection |
| `BRIDGE_COLLECTION_SYMBOL` | Symbol (e.g. `MC`) |
| `BRIDGE_CONFIRMATIONS` | Block confirmations required before minting (default: `6`) |

### Attestation Worker (optional)

Set `DEPLOYER_MNEMONIC` and `BRIDGE_CONTRACT_ADDRESS` to enable automatic attestation:

| Variable | Description |
|----------|-------------|
| `DEPLOYER_MNEMONIC` | BIP39 mnemonic for the contract deployer wallet |
| `BRIDGE_CONTRACT_ADDRESS` | Deployed OP721 bridge contract address |
| `ORACLE_FEE_ADDRESS` | Address where users pay the bridge fee (can be deployer's address) |
| `BRIDGE_MIN_FEE_SATS` | Minimum sats required from user per burn (default: `0` = no fee) |

### Bridge Fee Mechanism

When `ORACLE_FEE_ADDRESS` and `BRIDGE_MIN_FEE_SATS` are set, users must include a fee payment in their burn transaction:

```
Output 0: inscription → burn address (the burn itself)
Output 1: bridge fee  → oracle fee address (payment for attestation)
Output 2: change      → back to sender (used to derive sender address)
```

If the fee is missing or insufficient, the burn is still recorded but marked as `underpaid` and will not be attested. The `/bridge/claim/:inscriptionId` endpoint shows a helpful message for underpaid claims.

**Cost estimate**: Each `attestBurn()` costs ~5,000-15,000 sats in mining fees + OPNet gas. A safe default is `BRIDGE_MIN_FEE_SATS=10000`.

### Collection JSON Format

```json
[
  {
    "id": "abc123...i0",
    "meta": {
      "name": "#0001",
      "attributes": [...]
    }
  }
]
```

Each item's `id` is the Ordinals inscription ID (`{txid}i{index}`). Token IDs are assigned sequentially based on array order.

## Usage

```bash
# Build
npm run build

# Start
npm start

# Development (watch mode)
npm run dev

# Run tests
npm test
```

## REST API

### Indexer Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/inscription/:id` | Get inscription by ID |
| GET | `/content/:id` | Raw inscription content (binary) |
| GET | `/inscriptions/owner/:address` | Inscriptions by owner (`?limit=&offset=`) |
| GET | `/inscriptions/latest` | Latest inscriptions (`?limit=`) |
| GET | `/inscriptions/type/:contentType` | Inscriptions by MIME type (`?limit=`) |
| GET | `/stats` | Indexer statistics |

### Bridge Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/bridge/stats` | Bridge statistics |
| GET | `/bridge/claim/:inscriptionId` | Claim status for an inscription |
| GET | `/bridge/claims/sender/:address` | All claims by sender address |
| GET | `/bridge/collection` | Collection info and size |
| GET | `/bridge/collection/check/:inscriptionId` | Check if inscription is in collection |
| GET | `/bridge/collection/token/:tokenId` | Get collection item by token ID |
| POST | `/bridge/retry-failed` | Retry failed attestations |

## Smart Contract

The OP721 contract is in `contract/` (AssemblyScript, compiles to WASM).

```bash
cd contract
npm install
npm run build
# Output: contract/build/OrdinalsBridgeNFT.wasm
```

### Contract Methods

| Method | Access | Description |
|--------|--------|-------------|
| `attestBurn(to, inscriptionHash, tokenId)` | Deployer only | Mint OP721 after verifying inscription burn |
| `isInscriptionClaimed(inscriptionHash)` | Public | Check if an inscription has been bridged |
| `attestCount()` | Public | Total attestations processed |
| *+ all standard OP721 methods* | | `name`, `symbol`, `ownerOf`, `balanceOf`, `safeTransfer`, etc. |

### Client-Side ABI

```typescript
import { ORDINALS_BRIDGE_NFT_ABI, IOrdinalsBridgeNFTContract } from 'opnet-ordinals-plugin';
import { getContract } from 'opnet';

const nft = getContract<IOrdinalsBridgeNFTContract>(
    contractAddress,
    ORDINALS_BRIDGE_NFT_ABI,
    provider,
    network,
);
```

## Project Structure

```
src/
  index.ts               Entry point
  plugin.ts              Main indexer + bridge orchestrator
  parser.ts              Ordinals witness envelope parser
  database.ts            PostgreSQL layer (inscriptions)
  api.ts                 REST API (inscriptions)
  collection.ts          Collection registry (JSON loader)
  bridge.ts              Bridge service (burn detection + claim lifecycle)
  bridge-database.ts     PostgreSQL layer (burn claims)
  bridge-api.ts          REST API (bridge)
  bridge-abi.ts          Client-side ABI + TypeScript interface
  attestation-worker.ts  Automatic attestBurn() transaction submitter
  types.ts               Shared type definitions
contract/
  src/
    OrdinalsBridgeNFT.ts   OP721 contract (AssemblyScript)
    index.ts               Contract entry point
tests/
  parser.test.ts              Inscription parser tests
  integration.test.ts         Plugin integration tests
  collection.test.ts          Collection registry tests
  bridge.test.ts              Bridge service tests
  bridge-database.test.ts     Bridge database tests
  bridge-api.test.ts          Bridge API tests
  attestation-worker.test.ts  Attestation worker tests
```

## Claim Lifecycle

```
detected → confirmed → attested
    ↓          ↓
underpaid    failed (→ retry → confirmed)
```

- **detected**: Burn seen on-chain, waiting for confirmations
- **underpaid**: Burn seen but bridge fee insufficient (will not advance)
- **confirmed**: Enough confirmations, ready for attestation
- **attested**: `attestBurn()` submitted and accepted on-chain
- **failed**: Attestation reverted or errored (can retry via `/bridge/retry-failed`)

## Trust Model

The bridge uses an **oracle pattern**. The contract deployer is the trusted attestor who calls `attestBurn()` after verifying burns on-chain. The attestation worker automates this process. This means:

- Burns are irreversible (sent to an unspendable address)
- Each inscription can only be bridged once (enforced on-chain)
- The oracle must be trusted to honestly attest burns
- The attestation worker uses the deployer's wallet to sign transactions

This is the same trust model used by most cross-chain bridges (WBTC, etc.).

## License

MIT
