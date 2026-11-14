// 修正：把误插在 `if (` 括号内的注释行移到 if 之前，并沿用 if 的缩进。
import fs from 'node:fs';

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
const isIfOpen = (t) => /^(\}\s*)?(else\s+)?if\s*\($/.test(t) || /^(?:\}\s*)?(else\s+)?if\s*\(/.test(t) && t.endsWith('(');
let moved = 0;
for (let i = 0; i < lines.length; i++) {
	if (!lines[i].trim().startsWith('//')) continue;
	const prev = i > 0 ? lines[i - 1].trim() : '';
	if (!isIfOpen(prev)) continue;
	const ifIndent = (lines[i - 1].match(/^[ \t]*/) ?? [''])[0];
	const comment = ifIndent + lines[i].trim();
	lines.splice(i, 1);
	lines.splice(i - 1, 0, comment);
	moved++;
	i--;
}
fs.writeFileSync(file, lines.join('\n').replace(/\n/g, '\r\n'), 'utf8');
console.log('moved ' + moved + ' comments above if');
