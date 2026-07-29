const fs = require('fs');
const content = fs.readFileSync('src/routes/transactions.ts', 'utf8');
const lines = content.split('\n');

const slicedLines = lines.slice(0, 1021); // keeps 0 to 1020
slicedLines.push('  }');
slicedLines.push(');');
slicedLines.push('');
slicedLines.push('export default transactionsRouter;');
slicedLines.push('');

fs.writeFileSync('src/routes/transactions.ts', slicedLines.join('\n'));
console.log('Sliced end of file successfully!');
