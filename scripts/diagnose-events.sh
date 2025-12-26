#!/bin/bash

# Diagnostic script to check event indexing status
# Usage: ./diagnose-events.sh [user_address]

USER_ADDRESS="${1:-0x00bf54b8d90403f275fbf0e9db0bb7e2a278bcc0e8b53f3fe71a3e2931c668fa}"
BACKEND_URL="http://localhost:4002"

echo "=========================================="
echo "Event Indexing Diagnostic Report"
echo "=========================================="
echo ""

echo "1. Indexer Status:"
echo "-----------------"
curl -s "${BACKEND_URL}/api/v1/indexer/status" | jq '{
  status: .status,
  totalAgreements: .counts.agreements,
  totalEvents: .counts.events,
  totalPayments: .counts.payments,
  totalEscrowEvents: .counts.escrowEvents,
  eventTypes: [.latest.events[] | .eventType] | unique
}'
echo ""

echo "2. All Event Types in Database:"
echo "--------------------------------"
curl -s "${BACKEND_URL}/api/v1/indexer/status" | jq '[.latest.events[] | .eventType] | group_by(.) | map({eventType: .[0], count: length}) | sort_by(.count) | reverse'
echo ""

echo "3. Sample Events (latest 10):"
echo "----------------------------"
curl -s "${BACKEND_URL}/api/v1/indexer/status" | jq '.latest.events[0:10] | .[] | {eventType, agreementId, txHash: .transactionHash, blockNumber, createdAt}'
echo ""

echo "4. User's Agreement Events:"
echo "----------------------------"
curl -s "${BACKEND_URL}/api/v1/transactions/${USER_ADDRESS}?limit=20" | jq '{
  total: .total,
  eventTypes: [.transactions[] | .type] | group_by(.) | map({type: .[0], count: length}),
  sampleTransactions: .transactions[0:5] | .[] | {type, txHash, date, time}
}'
echo ""

echo "5. Escrow Events:"
echo "-----------------"
curl -s "${BACKEND_URL}/api/v1/indexer/status" | jq '.latest.escrowEvents[0:5] | .[]? | {eventType, agreementId, amount, txHash: .transactionHash}'
echo ""

echo "6. Payment Events:"
echo "------------------"
curl -s "${BACKEND_URL}/api/v1/indexer/status" | jq '.latest.payments[0:5] | .[]? | {eventType, agreementId, amount, from, to, txHash: .transactionHash}'
echo ""

echo "7. Employees Table (if any):"
echo "----------------------------"
echo "Note: Check database directly for employees table"
echo ""

echo "8. Milestones Table (if any):"
echo "------------------------------"
echo "Note: Check database directly for milestones table"
echo ""

echo "=========================================="
echo "Diagnostic Complete"
echo "=========================================="


