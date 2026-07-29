const fs = require('fs');
const content = fs.readFileSync('src/routes/transactions.ts', 'utf8');
const lines = content.split('\n');
const newBlock = `      return {
        id: p.transactionHash.slice(0, 10),
        type: isReceived ? "Payment Received" : "Payment Sent",
        address: formatAddress(isReceived ? p.from || "N/A" : p.to || "N/A"),
        date: dateTime.date,
        time: dateTime.time,
        token: tokenInfo.name,
        amount: finalAmount,
        status: "Completed" as const,
        tokenIcon: tokenInfo.icon,
        txHash: p.transactionHash,
        createdAt: p.createdAt,
      };
    }),
    ...escrowEvents.map((e) => {
      const dateTime = formatDate(e.createdAt);
      const tokenAddress = escrowTokenMap.get(e.agreementId) || null;
      const tokenInfo = getTokenInfo(tokenAddress);
      const amountStr = formatAmount(e.amount, tokenInfo);
      const isIncoming = e.eventType === "Released" || e.eventType === "Refunded";
      const sign = isIncoming ? "+" : "-";
      const finalAmount = amountStr !== "-" ? \`\${sign}\${amountStr}\` : amountStr;`;

lines.splice(836, 19, newBlock);
fs.writeFileSync('src/routes/transactions.ts', lines.join('\n'));
console.log('Fixed!');
