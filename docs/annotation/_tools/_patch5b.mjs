import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-5.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const f = s.files[0];
const map = {
  'async function readBotRuntimeLockOwner(': 'async function readBotRuntimeLockOwner(lockPath: string): Promise<BotRuntimeLockOwner | null> {',
  'async function readBotRuntimeLockLeaseAt(': 'async function readBotRuntimeLockLeaseAt(lockPath: string, nonce: string): Promise<number> {'
};
for (const e of f.edits) if (map[e.anchor]) e.anchor = map[e.anchor];
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('ok');
