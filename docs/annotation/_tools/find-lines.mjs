import fs from 'node:fs';

const L = fs
  .readFileSync('D:/code/_annot_baseline/mcp-py-p01/orig/src/mcp/server/mcpserver/server.py', 'utf8')
  .replace(/\r\n/g, '\n')
  .split('\n');
const subs = process.argv.slice(2);
for (const s of subs) {
  const hits = [];
  L.forEach((l, i) => {
    if (l.includes(s)) hits.push(i + 1 + ': ' + l);
  });
  console.log('[' + s + '] -> ' + (hits.length ? hits.join(' || ') : 'NONE'));
}
