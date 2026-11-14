#!/usr/bin/env node
// 按注释正文精确替换：spec = { file, map: { oldText: newText } }，保留原缩进与 `//` 前缀。
import fs from 'node:fs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const lines = fs.readFileSync(spec.file, 'utf8').split(/\r?\n/);
let hit = 0;
const missed = [];
for (const [oldText, newText] of Object.entries(spec.map)) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)\/\/\s?(.*)$/.exec(lines[i]);
        if (m && m[2] === oldText) {
            lines[i] = `${m[1]}// ${newText}`;
            hit++;
            found = true;
        }
    }
    if (!found) missed.push(oldText);
}
if (missed.length) {
    console.error('MISSED:\n' + missed.join('\n'));
    process.exit(1);
}
fs.writeFileSync(spec.file, lines.join('\n'), 'utf8');
console.log(`OK ${spec.file}: replaced=${hit}`);
