import fs from 'node:fs';
for (const p of ['ZC-deep-b75-spec-04.json']) {
  const spec = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const f of spec.files) {
    for (const item of f.items) {
      if (!item.raw) continue;
      item.raw = item.raw.map((l) => {
        const t = String(l);
        if (t.trim() === '') return '//';
        return t.trim().startsWith('//') ? t : '// ' + t;
      });
    }
  }
  fs.writeFileSync(p, JSON.stringify(spec, null, 2) + '\n');
  console.log('fixed ' + p);
}
