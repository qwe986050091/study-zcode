// 对 R58 的 36 个键，检查仓内是否已有对应修正行
import fs from 'node:fs';
import path from 'node:path';
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
const keys = rows.filter((r) => r[H.batch] === 'R58').map((r) => r[H.key]);
const ROOT = 'd:/code/opensource/drizzle-orm';
const walk = (d, out = []) => {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name === '.git') continue;
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (/\.(ts|tsx|md)$/.test(e.name)) out.push(p);
	}
	return out;
};
const files = walk(ROOT);
for (const k of keys) {
	const hits = [];
	for (const f of files) {
		const s = fs.readFileSync(f, 'utf8');
		if (s.includes(k)) {
			const lines = s.split(/\r?\n/);
			lines.forEach((l, i) => { if (l.includes(k)) hits.push(path.relative(ROOT, f).replace(/\\/g, '/') + ':' + (i + 1) + ' ' + l.trim().slice(0, 160)); });
		}
	}
	console.log(k + ' => ' + (hits.length ? '\n  ' + hits.join('\n  ') : 'NO-HIT'));
}
