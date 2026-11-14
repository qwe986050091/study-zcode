import fs from 'node:fs';

const p = 'd:\\code\\_annot_baseline\\spec-uvr-d5-2.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const items = j[0].items;
const anchor = '            "We should not the graalpy interpreter if not named `python` or requested; got {result:?}"';
items[items.length - 1].anchor = anchor;
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('last anchor ->', anchor);
