# Quick Start Guide

## Prerequisites

- Node.js >= 22.0.0
- PostgreSQL database
- Access to an OPNet RPC endpoint

## Installation

```bash
cd opnet-ordinals-plugin
npm install
```

## Configuration

```bash
cp .env.example .env
```

Edit `.env`:
```env
OPNET_RPC_URL=https://regtest.opnet.org
NETWORK=regtest
DATABASE_URL=postgresql://localhost/ordinals
API_PORT=3002
START_HEIGHT=0
ENABLE_API=true
```

## Setup Database

```bash
# Create PostgreSQL database
createdb ordinals

# Schema will be created automatically on first run
```

## Build

```bash
npm run build
```

## Run

```bash
npm start
```

The plugin will:
1. Connect to OPNet RPC at `https://regtest.opnet.org`
2. Initialize the PostgreSQL database
3. Start the REST API on port 3002
4. Begin indexing blocks from height 0

## API Usage

```bash
# Health check
curl http://localhost:3002/health

# Get latest inscriptions
curl http://localhost:3002/inscriptions/latest

# Get inscription by ID
curl http://localhost:3002/inscription/abc123:0

# View inscription content
curl http://localhost:3002/content/abc123:0

# Get inscriptions by owner
curl http://localhost:3002/inscriptions/owner/bc1p...

# Get statistics
curl http://localhost:3002/stats
```

## Production Deployment

For production use:

1. **Use mainnet network:**
   ```env
   NETWORK=mainnet
   OPNET_RPC_URL=https://mainnet.opnet.org
   ```

2. **Configure PostgreSQL with proper credentials:**
   ```env
   DATABASE_URL=postgresql://username:password@host:5432/ordinals
   ```

3. **Run with process manager (PM2):**
   ```bash
   npm install -g pm2
   pm2 start dist/index.js --name opnet-ordinals
   pm2 save
   ```

4. **Enable auto-restart:**
   ```bash
   pm2 startup
   ```

## Monitoring

Check indexer status:
```bash
curl http://localhost:3002/stats
```

View logs:
```bash
# If using PM2
pm2 logs opnet-ordinals

# Direct run
npm start
```

## Troubleshooting

**Connection refused errors:**
- Verify PostgreSQL is running
- Check DATABASE_URL is correct

**No blocks being indexed:**
- Verify OPNET_RPC_URL is accessible
- Check network setting matches RPC endpoint

**API not responding:**
- Check API_PORT is not in use
- Verify ENABLE_API=true
