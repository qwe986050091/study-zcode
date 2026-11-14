import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b5-01e.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const bad = new Set([
  '          category: "skills",',
  '          category: "commands",',
  '          category: "plugins",',
  '          category: "mcpServers",',
]);
s.files[0].edits = s.files[0].edits.filter((x) => !bad.has(x.anchor));
fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
console.log('edits', s.files[0].edits.length);
