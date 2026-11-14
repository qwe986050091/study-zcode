// 把按 spec 插入但漏掉 '// ' 前缀的行改回注释：按 trim 精确匹配，逐条前缀 '// '
import fs from 'fs';

const [, , file, ...specs] = process.argv;
const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
const targets = [];
for (const s of specs) {
	const spec = JSON.parse(fs.readFileSync(s, 'utf8'));
	for (const it of spec) for (const c of it.comments) targets.push(String(c).trim());
}

let fixed = 0;
const missed = [];
for (const t of targets) {
	const idx = lines.findIndex((l) => l.trim() === t && !l.trim().startsWith('//'));
	if (idx === -1) { missed.push(t); continue; }
	const m = lines[idx].match(/^[\t ]*/);
	lines[idx] = m[0] + '// ' + t;
	fixed++;
}

fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log(`fixed ${fixed}/${targets.length}`);
for (const m of missed) console.log('MISS', m.slice(0, 60));
