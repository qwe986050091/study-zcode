// 导出 R58 的断言行 + 该行源码上下文，供逐条核验
import fs from 'node:fs';
const P = 'd:/code/_annot_baseline/R55-claim-queue.csv';
const t = fs.readFileSync(P, 'utf8').replace(/^\uFEFF/, '');
const parse = (s) => {
	const rows = []; let row = []; let f = ''; let q = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
		else if (c === '"') q = true;
		else if (c === ',') { row.push(f); f = ''; }
		else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
		else if (c === '\r') {}
		else f += c;
	}
	if (f.length || row.length) { row.push(f); rows.push(row); }
	return rows;
};
const rows = parse(t);
const head = rows.shift();
const H = Object.fromEntries(head.map((h, i) => [h, i]));
const out = rows.filter((r) => r[H.batch] === 'R58');
console.log('R58 rows =', out.length);
const ROOT = 'd:/code/opensource/drizzle-orm/';
for (const r of out) {
	const file = r[H.file];
	const line = Number(r[H.line]);
	const src = fs.readFileSync(ROOT + file, 'utf8').split(/\r?\n/);
	console.log('\n### ' + r[H.key] + ' | ' + r[H.keyword] + ' | ' + file + ':' + line + ' | ' + r[H.layer_status] + ' | ' + r[H.source]);
	console.log('CLAIM: ' + r[H.segment].trim());
	for (let i = Math.max(0, line - 3); i < Math.min(src.length, line + 3); i++) console.log('  ' + String(i + 1).padStart(5) + (i + 1 === line ? '>' : ' ') + ' ' + src[i]);
}
