import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b5-01g.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const e of s.files[0].edits) {
  if (e.anchor === '  const parsed = parseToml(raw) as Record<string, unknown>;') {
    e.anchor = '      return readTomlMcpServers(parseToml(raw) as Record<string, unknown>);';
  }
}
fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
console.log('ok');
