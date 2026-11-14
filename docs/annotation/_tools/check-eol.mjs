// EOL 一致性检查（2026-11-09 新增）：按文件扫 bare LF —— 没有 \r 陪伴的 \n。
// 目的：`Edit` 整文件重写会把 CRLF 静默改成 LF，而 check-code-tokens 比较前做了
//       `\r\n -> \n` 归一，所以 token 检查看不见这种污染；必须由本脚本单独把关。
// 用法：node check-eol.mjs <repo> <file-list.txt> [--fix] [out.json]
//   --fix   就地归一化（bare LF -> CRLF），随后复扫并以复扫结果决定退出码。
// 与其它三件套一致的约定：SUMMARY 单行汇总、命中非零退出、文件缺失也算失败。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const positional = args.filter(a => a !== '--fix');
const [repoArg, listArg, outArg] = positional;
if (!repoArg || !listArg) {
    console.error('usage: node check-eol.mjs <repo> <file-list.txt> [--fix] [out.json]');
    process.exit(2);
}
const repo = path.resolve(repoArg);
const files = fs
    .readFileSync(listArg, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

// 返回 bare LF 的 1-based 行号；同时给出全文 bareLF 总数。
function scanBareLf(text) {
    const lines = [];
    let line = 1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n') {
            if (i === 0 || text[i - 1] !== '\r') lines.push(line);
            line++;
        }
    }
    return lines;
}

function fixEol(text) {
    return text.replace(/(?<!\r)\n/g, '\r\n');
}

const rows = [];
const missing = [];
let scanned = 0;
let totalBefore = 0;

for (const rel of files) {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) {
        missing.push(rel);
        rows.push({ path: rel, status: 'missing' });
        continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const lines = scanBareLf(text);
    let after = lines.length;
    if (fix && lines.length > 0) {
        fs.writeFileSync(abs, fixEol(text), 'utf8');
        after = scanBareLf(fs.readFileSync(abs, 'utf8')).length;
    }
    scanned += 1;
    totalBefore += lines.length;
    rows.push({ path: rel, status: 'ok', bareLf: lines.length, remaining: after, lines: lines.slice(0, 50) });
}

const remainingTotal = rows.reduce((n, r) => n + (r.remaining ?? 0), 0);
const hitFiles = rows.filter(r => (r.remaining ?? 0) > 0);
for (const r of hitFiles) {
    const shown = r.lines.slice(0, 20).join(',') + (r.lines.length > 20 ? ',...' : '');
    console.log(`BARE-LF\t${r.path}\tlines=${r.remaining}\t[${shown}]`);
}
for (const rel of missing) console.log(`MISSING\t${rel}`);

console.log(
    `SUMMARY files=${files.length} scanned=${scanned} bareLF=${fix ? totalBefore : remainingTotal} remaining=${remainingTotal} filesWithBareLF=${hitFiles.length}${fix ? ' fixed=true' : ''}`,
);

if (outArg) fs.writeFileSync(outArg, JSON.stringify({ repo, fix, files: files.length, scanned, bareLfBefore: totalBefore, remaining: remainingTotal, rows }, null, 2), 'utf8');

// 与其它三件套同语义：归一化后仍有 bare LF，或文件缺失，即非零退出。
process.exit(remainingTotal > 0 || missing.length > 0 ? 1 : 0);
