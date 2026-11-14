import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/ZC-deep-b50-spec-03.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.files[0].items[0].anchor = 'import type { PresentationPageElement } from "@/presentation/types.js";';
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('patched');
