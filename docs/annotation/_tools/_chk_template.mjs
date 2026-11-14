import fs from 'node:fs';
const files = [
  'D:/code/ZCode/packages/services/src/remote-projects/index.ts',
  'D:/code/ZCode/packages/services/src/oauth/repo/oauthCredentialRepo.ts',
  'D:/code/ZCode/packages/services/src/task-groups/repository.ts',
];
let bad = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  let inTemplate = false;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const before = inTemplate;
    if (!inTemplate && t.startsWith('//')) return;
    if (before && t.startsWith('//')) {
      console.log(`INSIDE-TEMPLATE ${f}:${i + 1}: ${t}`);
      bad++;
    }
    let escaped = false;
    for (const ch of raw) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\\\') { escaped = true; continue; }
      if (ch === '`') inTemplate = !inTemplate;
    }
  });
}
console.log(bad === 0 ? 'OK: no comment inside template literal' : `BAD: ${bad}`);
