import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/_d43_spec.json', 'utf8'));
const e = s.find((x) => x.file.endsWith('dependency_groups.rs'));
const item = e.items.find((i) => i.line === 30);
item.line = 27;
fs.writeFileSync('d:/code/_annot_baseline/_d43_spec2.json', JSON.stringify([e], null, 2));
console.log('rewritten line to', item.line);
