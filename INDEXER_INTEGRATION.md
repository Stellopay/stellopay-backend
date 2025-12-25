# Indexer Integration Guide

## Overview

Your project uses **Apibara** indexer (`my-indexer/`) to automatically index contract events and store them in PostgreSQL. The backend queries this same database to populate transactions, notifications, and analytics.

## Architecture

```
Starknet Contracts → Apibara Indexer → PostgreSQL Database → Backend API → Frontend
```

## Current Setup

### Indexer Configuration
- **Location**: `my-indexer/apibara.config.ts`
- **Starting Block**: `4420000` (Sepolia)
- **Stream URL**: `https://sepolia.starknet.a5a.ch`
- **Contract Addresses**:
  - `0x0519729f252d4db0ce89c0fef86981ecb7e373523538a4dd17b174551629d03d`
  - `0x0414394dff460d037efc45bdd64214c6478f8bb8e858002359595d88010f8cdc`

### Database Schema
Both indexer and backend use the same schema:
- `agreements` - Agreement records
- `agreement_events` - All agreement-related events
- `payments` - PaymentSent/PaymentReceived events
- `escrow_events` - Funded/Released/Refunded events
- `milestones` - Milestone events
- `employees` - Employee data for payroll

## Checking Indexer Status

### 1. Check if Indexer is Running

```bash
cd my-indexer
pnpm dev
```

You should see logs like:
```
📋 Indexer Configuration:
   Starting Block: 4420000
   Contract Addresses: 2
📍 Progress: Block 4420001
✅ Block 4420002 | Found 1 event(s)
```

### 2. Check Database Status

```bash
# From backend directory
curl http://localhost:4002/api/v1/indexer/status
```

Response:
```json
{
  "status": "connected",
  "counts": {
    "agreements": 5,
    "events": 12,
    "payments": 3,
    "escrowEvents": 2
  },
  "latest": {
    "events": [...],
    "agreements": [...]
  }
}
```

### 3. Check User Events

```bash
curl http://localhost:4002/api/v1/indexer/user/YOUR_ADDRESS/events
```

## Troubleshooting Empty Data

### Issue: Sections showing empty after creating agreement

**Possible Causes:**

1. **Indexer not running**
   - Solution: Start the indexer (`cd my-indexer && pnpm dev`)

2. **Indexer hasn't reached the block yet**
   - The indexer starts from block `4420000`
   - If your agreement was created in a block before this, it won't be indexed
   - Solution: Either wait for indexer to catch up, or change `startingBlock` to `0` in `apibara.config.ts`

3. **Contract address mismatch**
   - The contract address that emitted the event must match one in `apibara.config.ts`
   - Solution: Verify the contract address on StarkScan and update `apibara.config.ts`

4. **Address normalization mismatch**
   - The indexer and backend might normalize addresses differently
   - Solution: Both use the same normalization (66-char hex with leading zeros)

### Quick Fix: Manual Event Processing

If the indexer hasn't caught up, you can manually process events:

```bash
# After creating an agreement, get the transaction hash
# Then process it:
curl -X POST http://localhost:4002/api/v1/events/process_tx/0xYOUR_TX_HASH
```

This will:
- Fetch the transaction receipt
- Parse all events
- Store them in the database
- Make them immediately available in the UI

## Verifying Data Flow

### Step 1: Create Agreement
```bash
# Use frontend or API to create agreement
# Note the transaction hash
```

### Step 2: Check Indexer Logs
```bash
# In my-indexer terminal, you should see:
✅ Block XXXX | Found 1 event(s)
🎉 Successfully stored AgreementCreated: 14
```

### Step 3: Check Database
```bash
# Query database directly
psql postgresql://user:pass@localhost:5432/stellopay_indexer

SELECT * FROM agreements ORDER BY created_at DESC LIMIT 5;
SELECT * FROM agreement_events ORDER BY block_number DESC LIMIT 5;
```

### Step 4: Check Backend API
```bash
curl http://localhost:4002/api/v1/transactions/YOUR_ADDRESS
curl http://localhost:4002/api/v1/notifications/YOUR_ADDRESS
curl http://localhost:4002/api/v1/analytics/YOUR_ADDRESS
```

## Updating Contract Addresses

If you deploy new contracts:

1. **Update indexer config** (`my-indexer/apibara.config.ts`):
   ```typescript
   contractAddresses: [
     "0xNEW_CONTRACT_ADDRESS_1",
     "0xNEW_CONTRACT_ADDRESS_2",
   ]
   ```

2. **Restart indexer**:
   ```bash
   cd my-indexer
   pnpm dev
   ```

3. **Update backend defaults** (optional, `stellopay-backend/src/config.ts`):
   ```typescript
   workAgreementAddress: "0xNEW_CONTRACT_ADDRESS"
   ```

## Monitoring

### Real-time Monitoring
```bash
cd my-indexer
pnpm monitor-events
```

This will show:
- New events as they're indexed
- Current block number
- Event counts

### Check Events Script
```bash
cd my-indexer
pnpm check-events
```

Shows:
- Recent agreements
- Recent events
- Contract addresses being indexed
- Database connection status

## Best Practices

1. **Keep indexer running** - It should run continuously to catch all events
2. **Monitor logs** - Watch for errors or missed events
3. **Verify contract addresses** - Ensure they match between indexer config and actual deployments
4. **Check starting block** - Make sure it's not too high (misses old events) or too low (slow initial sync)
5. **Use manual processing** - For immediate data after transactions, use `/events/process_tx/:tx_hash`

## Next Steps

If data is still not showing:

1. ✅ Check indexer is running
2. ✅ Verify contract addresses match
3. ✅ Check database has data: `SELECT COUNT(*) FROM agreements;`
4. ✅ Verify address normalization: Check if user address format matches stored addresses
5. ✅ Check backend logs for query errors
6. ✅ Use `/indexer/status` endpoint to see what's in the database


