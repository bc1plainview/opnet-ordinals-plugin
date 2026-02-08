# OPNet Ordinals Indexer Plugin

A production-ready plugin for indexing Bitcoin Ordinals inscriptions on the OPNet blockchain.

## Features

- 🔍 **Real-time indexing** of Ordinals inscriptions from OPNet blocks
- 💾 **PostgreSQL storage** with optimized indexes for fast queries
- 🌐 **REST API** for querying inscriptions, owners, and statistics
- 🔄 **Reorg handling** to maintain data consistency during chain reorganizations
- 📊 **Statistics tracking** for inscriptions, owners, and content types
- ⚡ **High performance** with concurrent processing and caching

## Installation

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Edit .env with your configuration
nano .env

# Build the plugin
npm run build
```

## Configuration

Edit `.env` file:

```env
# OPNet RPC URL
OPNET_RPC_URL=https://regtest.opnet.org

# Network (mainnet, testnet, or regtest)
NETWORK=regtest

# PostgreSQL database URL
DATABASE_URL=postgresql://localhost/ordinals

# API server port
API_PORT=3002

# Starting block height for indexing
START_HEIGHT=0

# Enable REST API
ENABLE_API=true
```

## Database Setup

Create a PostgreSQL database:

```bash
createdb ordinals
```

The plugin will automatically create the required tables and indexes on first run.

## Usage

### Start the indexer

```bash
npm start
```

The plugin will:
1. Connect to the OPNet RPC endpoint
2. Initialize the database schema
3. Start the REST API server (if enabled)
4. Begin indexing blocks from `START_HEIGHT`

### Development mode

```bash
npm run dev
```

This runs TypeScript in watch mode for development.

## REST API

### Endpoints

#### Health Check
```
GET /health
```

Returns the health status of the indexer.

#### Get Inscription by ID
```
GET /inscription/:id
```

Example: `/inscription/abc123:0`

Returns full inscription data including base64-encoded content.

#### Get Inscription Content
```
GET /content/:id
```

Example: `/content/abc123:0`

Returns the raw inscription content with appropriate `Content-Type` header.

#### Get Inscriptions by Owner
```
GET /inscriptions/owner/:address?limit=100&offset=0
```

Example: `/inscriptions/owner/bc1p...?limit=50`

Returns inscriptions owned by a specific Bitcoin address.

#### Get Latest Inscriptions
```
GET /inscriptions/latest?limit=20
```

Returns the most recent inscriptions.

#### Get Inscriptions by Content Type
```
GET /inscriptions/type/:contentType?limit=100
```

Example: `/inscriptions/type/image%2Fpng`

Returns inscriptions of a specific MIME type.

#### Get Statistics
```
GET /stats
```

Returns indexer statistics including:
- Total inscriptions
- Total unique owners
- Content type breakdown

### API Examples

```bash
# Get latest inscriptions
curl http://localhost:3002/inscriptions/latest

# Get specific inscription
curl http://localhost:3002/inscription/abc123:0

# View inscription image
curl http://localhost:3002/content/abc123:0 > inscription.png

# Get inscriptions for an address
curl http://localhost:3002/inscriptions/owner/bc1p...

# Get statistics
curl http://localhost:3002/stats
```

## Architecture

### Components

1. **OrdinalsParser** (`src/parser.ts`)
   - Parses Bitcoin witness data for Ordinals inscription envelopes
   - Decodes Bitcoin addresses from output scripts
   - Handles OP_FALSE OP_IF "ord" envelope format

2. **InscriptionDatabase** (`src/database.ts`)
   - PostgreSQL storage layer
   - Optimized indexes for queries
   - Reorg handling with rollback support

3. **OrdinalsAPI** (`src/api.ts`)
   - Express REST API server
   - CORS enabled
   - Efficient pagination

4. **OrdinalsIndexerPlugin** (`src/plugin.ts`)
   - Main plugin orchestrator
   - Block processing and transaction parsing
   - Integration with OPNet provider

### Data Flow

```
OPNet RPC → OrdinalsIndexerPlugin → OrdinalsParser → InscriptionDatabase
                                                            ↓
                                                      OrdinalsAPI
```

## Database Schema

```sql
CREATE TABLE inscriptions (
    id TEXT PRIMARY KEY,              -- txid:vout
    content_type TEXT NOT NULL,       -- MIME type
    content BYTEA NOT NULL,           -- Inscription data
    block_height INTEGER NOT NULL,
    block_hash TEXT NOT NULL,
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    owner TEXT NOT NULL,              -- Bitcoin address
    timestamp BIGINT NOT NULL,
    inscription_number INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Optimized indexes
CREATE INDEX idx_inscriptions_owner ON inscriptions(owner);
CREATE INDEX idx_inscriptions_block_height ON inscriptions(block_height);
CREATE INDEX idx_inscriptions_inscription_number ON inscriptions(inscription_number);
CREATE INDEX idx_inscriptions_txid ON inscriptions(txid);
CREATE INDEX idx_inscriptions_content_type ON inscriptions(content_type);
```

## Reorg Handling

The plugin automatically handles blockchain reorganizations:

1. Detects when a reorg occurs
2. Deletes inscriptions from orphaned blocks
3. Reprocesses blocks from the fork point
4. Maintains data consistency

## Performance

- **Concurrent processing** of transactions within blocks
- **Database connection pooling** for high throughput
- **Optimized indexes** for fast queries
- **Efficient witness data parsing**

## Monitoring

Check indexer status programmatically:

```typescript
import { OrdinalsIndexerPlugin } from '@opnet/ordinals-indexer-plugin';

const status = plugin.getStatus();
console.log(status);
// {
//   currentHeight: 12345,
//   totalInscriptions: 6789,
//   isRunning: true,
//   isSyncing: false
// }
```

## Development

### Project Structure

```
opnet-ordinals-plugin/
├── src/
│   ├── types.ts          # TypeScript interfaces
│   ├── parser.ts         # Ordinals envelope parser
│   ├── database.ts       # PostgreSQL layer
│   ├── api.ts            # REST API server
│   ├── plugin.ts         # Main plugin class
│   └── index.ts          # Entry point
├── package.json
├── tsconfig.json
└── README.md
```

### Build

```bash
npm run build
```

### Clean

```bash
npm run clean
```

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

For issues or questions, please open an issue on GitHub.
