import fs from 'fs';

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

const [, , file, specPath] = process.argv;
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
const added = lines.map(() => false);

let ok = 0;
const items = spec
	.map((s, i) => ({ ...s, _i: i }))
	.sort((a, b) => b.line - a.line || b._i - a._i);

for (const it of items) {
	const ref = lines[it.line - 1];
	if (ref === undefined) {
		console.log('OUT OF RANGE', it.line);
		continue;
	}
	const origIndent = (ref.match(/^[\t ]*/) || [''])[0];
	const indent = it.indent !== undefined ? it.indent : origIndent;
	const block = it.comments.map((c) => indent + c);
	const pos = it.line - 1 + (it.mode === 'after' ? 1 : 0);
	lines.splice(pos, 0, ...block);
	added.splice(pos, 0, ...block.map(() => true));
	ok++;
}

assertAddedLinesAreComments(file, lines, added);
fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log(`inserted ${ok}/${spec.length} blocks`);
