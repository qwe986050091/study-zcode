// 按「truncated 行内容唯一匹配」插入整行注释：沿用被匹配行的缩进，避免手写 Tab 出错。
// 用法：node _insert.mjs <绝对文件路径> <spec.json>
// spec: [{ "match": "行内容(去首尾空白后完全相等)", "occ": 1, "mode": "before"|"after", "comments": ["// ..."] }]
import fs from 'node:fs';

// 落盘前的内联不变量：每一行新增内容必须是本语言的行首注释，否则整批拒绝写入。
// 不依赖 git 基线比对——基线只能说明「和 HEAD 不一样」，说明不了「这一行是不是注释」。
const COMMENT_RE_BY_EXT = {
	'.ts': /^\s*(\/\/|\/\*|\*)/,
	'.tsx': /^\s*(\/\/|\/\*|\*)/,
	'.js': /^\s*(\/\/|\/\*|\*)/,
	'.mjs': /^\s*(\/\/|\/\*|\*)/,
	'.cjs': /^\s*(\/\/|\/\*|\*)/,
	'.jsx': /^\s*(\/\/|\/\*|\*)/,
	'.c': /^\s*(\/\/|\/\*|\*)/,
	'.h': /^\s*(\/\/|\/\*|\*)/,
	'.cc': /^\s*(\/\/|\/\*|\*)/,
	'.cpp': /^\s*(\/\/|\/\*|\*)/,
	'.hpp': /^\s*(\/\/|\/\*|\*)/,
	'.cs': /^\s*(\/\/|\/\*|\*)/,
	'.java': /^\s*(\/\/|\/\*|\*)/,
	'.go': /^\s*(\/\/|\/\*|\*)/,
	'.kt': /^\s*(\/\/|\/\*|\*)/,
	'.rs': /^\s*\/\//,
	'.py': /^\s*#/,
};

function assertAddedLinesAreComments(file, lines, added) {
	const dot = file.lastIndexOf('.');
	const ext = dot === -1 ? '' : file.slice(dot).toLowerCase();
	const re = COMMENT_RE_BY_EXT[ext];
	if (re === undefined) {
		console.error(`REJECT: 未配置 ${ext || '(无扩展名)'} 的行首注释规则，拒绝写入 ${file}`);
		process.exit(1);
	}
	const bad = [];
	for (let i = 0; i < lines.length; i++) {
		if (added[i] !== true) continue;
		const line = lines[i];
		// 注释串里若夹带换行，写入后会多出物理行，而那些行不在 added 里，必须单独拦下
		if (/[\r\n]/.test(line) || re.test(line) === false) bad.push([i + 1, line]);
	}
	if (bad.length > 0) {
		console.error(`REJECT: ${bad.length} 行新增内容不是整行注释，本批未写入 ${file}`);
		for (const [n, t] of bad.slice(0, 50)) console.error(`  L${n}: ${JSON.stringify(t)}`);
		process.exit(1);
	}
}

const [file, specPath] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let lines = text.split('\n');
const added = lines.map(() => false);

for (const item of spec) {
	const mode = item.mode ?? 'before';
	const occ = item.occ ?? 1;
	let seen = 0;
	const idx = lines.findIndex((line) => {
		if (line.trim() !== item.match.trim()) return false;
		seen++;
		return seen === occ;
	});
	if (idx === -1) {
		console.error('NOT FOUND: ' + item.match);
		process.exitCode = 1;
		continue;
	}
	const indentMatch = lines[idx].match(/^[ \t]*/) ?? [''];
	let indent = indentMatch[0];
	const offset = item.indentOffset ?? 0;
	if (offset < 0) {
		indent = indent.slice(0, Math.max(0, indent.length + offset));
	} else if (offset > 0) {
		indent += '\t'.repeat(offset);
	}
	const block = item.comments.map((c) => indent + c);
	const pos = mode === 'before' ? idx : idx + 1;
	lines.splice(pos, 0, ...block);
	added.splice(pos, 0, ...block.map(() => true));
}

assertAddedLinesAreComments(file, lines, added);
fs.writeFileSync(file, lines.join('\n').replace(/\n/g, '\r\n'), 'utf8');
console.log('inserted ' + spec.length + ' blocks into ' + file);
