// 固定种子抽检：从 git diff 的新增行里取整行注释，按种子打乱后取前 ceil(pct*N) 条。
// 用法：node _sample.mjs <seed> <pct> <repo> <file...>
import { execFileSync } from 'node:child_process';

const [seedArg, pctArg, repo, ...files] = process.argv.slice(2);
const seed = Number(seedArg);
const pct = Number(pctArg);
const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', '--', ...files], { encoding: 'utf8', maxBuffer: 1 << 26 });

const lines = [];
let cur = '';
for (const raw of diff.split(/\r?\n/)) {
	if (raw.startsWith('+++ b/')) {
		cur = raw.slice(6);
		continue;
	}
	if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
	const text = raw.slice(1).trim();
	if (!text.startsWith('//')) continue;
	lines.push({ file: cur, text });
}

function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(seed);
const idx = lines.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) {
	const j = Math.floor(rand() * (i + 1));
	[idx[i], idx[j]] = [idx[j], idx[i]];
}
const k = Math.ceil(pct * lines.length);
const picked = idx.slice(0, k).sort((a, b) => a - b);
console.log(`seed=${seed} pct=${pct} total=${lines.length} sample=${k}`);
for (const i of picked) console.log(`${i}\t${lines[i].file}\t${lines[i].text}`);
