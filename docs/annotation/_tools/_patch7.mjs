import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-7.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const f = s.files[0];
const e = f.edits.find((x) => x.anchor === 'import {' || x.anchor.includes('ICredentialService'));
e.anchor = 'import type { ICredentialService } from "../credential/credential.js";';
e.before = true;
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('fixed: ' + e.anchor);
