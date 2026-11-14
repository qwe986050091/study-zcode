import fs from 'fs';

// 用法: node _insertBeforeText.mjs <file> <spec.json>
// spec: [{ "match": "唯一子串", "comments": ["// ..."], "indent": "\t\t" }]
const [file, specFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const inserts = [];
for (const item of spec) {
	const hits = [];
	lines.forEach((ln, i) => { if (ln.includes(item.match)) hits.push(i); });
	if (hits.length !== 1) {
		console.error(`SKIP (${hits.length} hits): ${item.match}`);
		continue;
	}
	const idx = hits[0];
	const indent = item.indent ?? (lines[idx].match(/^\s*/)[0]);
	inserts.push({ idx, block: item.comments.map((c) => indent + c) });
}
inserts.sort((a, b) => b.idx - a.idx);
for (const { idx, block } of inserts) lines.splice(idx, 0, ...block);
fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log('inserted', inserts.length, 'of', spec.length);
