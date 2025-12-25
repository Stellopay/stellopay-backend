# Event Processing Guide

## Overview
This guide explains how to populate the database with contract events for transactions, analytics, and notifications.

## Database Connection Fix

If you're getting the "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string" error:

1. **Set the POSTGRES_CONNECTION_STRING environment variable:**
   ```bash
   export POSTGRES_CONNECTION_STRING="postgresql://username:password@localhost:5432/stellopay_indexer"
   ```

2. **Or create a `.env` file in `stellopay-backend/`:**
   ```
   POSTGRES_CONNECTION_STRING=postgresql://username:password@localhost:5432/stellopay_indexer
   ```

3. **If you don't have a password, use an empty string:**
   ```
   POSTGRES_CONNECTION_STRING=postgresql://username:@localhost:5432/stellopay_indexer
   ```

## Processing Transaction Events

### Method 1: Process a Single Transaction

After executing a contract call (e.g., creating an agreement, funding, sending payment), call:

```bash
POST /api/v1/events/process_tx/:tx_hash
```

**Example:**
```bash
curl -X POST http://localhost:4002/api/v1/events/process_tx/0x1234...abcd
```

This will:
- Fetch the transaction receipt
- Parse all events (AgreementCreated, PaymentSent, PaymentReceived, Funded, Released, etc.)
- Store them in the database
- Return the number of events processed

### Method 2: Process Multiple Transactions

```bash
POST /api/v1/events/process_batch
Content-Type: application/json

{
  "tx_hashes": [
    "0x1234...abcd",
    "0x5678...efgh"
  ]
}
```

### Method 3: Auto-process After Contract Calls

You can modify the frontend to automatically process events after each contract call:

```typescript
// After a successful transaction
const txHash = await executeCall(prepared.call);
if (txHash?.transaction_hash) {
  // Process events
  await apiPost(`/events/process_tx/${txHash.transaction_hash}`, {});
}
```

## Event Types Stored

### Agreement Events
- `AgreementCreated` - Stored in `agreement_events` and `agreements` tables
- `AgreementActivated`, `AgreementPaused`, `AgreementCancelled`, etc. - Stored in `agreement_events`

### Payment Events
- `PaymentSent` - Stored in `payments` table
- `PaymentReceived` - Stored in `payments` table

### Escrow Events
- `Funded` - Stored in `escrow_events` table
- `Released` - Stored in `escrow_events` table
- `Refunded` - Stored in `escrow_events` table

## Data Flow

1. **User executes contract call** (create agreement, fund, send payment, etc.)
2. **Transaction is mined** on Starknet
3. **Call `/events/process_tx/:tx_hash`** to parse and store events
4. **Events are stored** in database tables
5. **Frontend fetches data** from:
   - `/transactions/:user_address` - For transaction history
   - `/notifications/:user_address` - For notifications
   - `/analytics/:user_address` - For analytics charts

## Example Workflow

```typescript
// 1. Create an agreement
const createTx = await executeCall(createAgreementCall);
// tx_hash: 0xabc123...

// 2. Process events
await fetch(`/api/v1/events/process_tx/${createTx.transaction_hash}`, {
  method: 'POST'
});

// 3. Fund the agreement
const fundTx = await executeCall(fundAgreementCall);
// tx_hash: 0xdef456...

// 4. Process events
await fetch(`/api/v1/events/process_tx/${fundTx.transaction_hash}`, {
  method: 'POST'
});

// 5. Now transactions, notifications, and analytics will show the data!
```

## Troubleshooting

### Events not appearing?
1. Make sure the transaction has been mined (check on block explorer)
2. Verify the transaction hash is correct
3. Check backend logs for parsing errors
4. Ensure database connection is working

### Database connection issues?
1. Check `POSTGRES_CONNECTION_STRING` is set correctly
2. Verify PostgreSQL is running
3. Check database exists: `stellopay_indexer`
4. Ensure user has proper permissions


