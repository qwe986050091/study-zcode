// B08 注释插入器：读目标文件 → 按 1-based 原始行号锚点倒序插入整行 // 注释 → 以 CRLF 写回。
// 锚点来自同目录 DZ-b08-anchors-1..5.mjs；行号以修改前内容为准，一次性应用。
import fs from 'node:fs';
import path from 'node:path';

const target = 'D:/code/opensource/drizzle-orm/drizzle-orm/src/sqlite-core/dialect.ts';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const anchors = [];
for (let i = 1; i <= 5; i++) {
	const mod = (await import('file:///' + path.join(here, `DZ-b08-anchors-${i}.mjs`).replace(/\\/g, '/')));
	for (const [line, ...lines] of mod.default) anchors.push({ line, lines });
}

const raw = fs.readFileSync(target, 'utf8');
if (!raw.includes('\r\n')) throw new Error('target is not CRLF');
if (/(^|[^\r])\n/.test(raw)) throw new Error('target has mixed LF line endings');

const lines = raw.split('\r\n');
const trailingEmpty = lines.length && lines[lines.length - 1] === '';
if (trailingEmpty) lines.pop();
const before = lines.length;

const seen = new Set();
let added = 0;
for (const a of anchors) {
	if (!Number.isInteger(a.line) || a.line < 1 || a.line > before) {
		throw new Error('anchor line out of range: ' + a.line);
	}
	if (seen.has(a.line)) throw new Error('duplicate anchor line: ' + a.line);
	seen.add(a.line);
	for (const t of a.lines) {
		if (!t.trim().startsWith('//')) throw new Error('non-comment anchor text: ' + t);
		if (t.includes('*/')) throw new Error('star-slash in anchor text: ' + t);
	}
	added += a.lines.length;
}

// 倒序应用：先插后面的行号，前面锚点的原始行号仍然有效
const ordered = [...anchors].sort((x, y) => y.line - x.line);
for (const a of ordered) {
	const indent = lines[a.line - 1].match(/^\t*/)[0];
	lines.splice(a.line - 1, 0, ...a.lines.map((t) => indent + t));
}

fs.writeFileSync(target, lines.join('\r\n') + '\r\n', 'utf8');
console.log(`anchors=${anchors.length} added=${added} before=${before} after=${lines.length}`);
