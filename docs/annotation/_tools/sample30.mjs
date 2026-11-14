import fs from 'node:fs';

const repo = 'd:/code/opensource/mcp-sdk';
const rows = fs
    .readFileSync('d:/code/_annot_baseline/all-uncovered.txt', 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
        const [path, ln, , ...rest] = line.split('\t');
        return { path, line: Number(ln), content: rest.join('\t') };
    });

const N = rows.length;
const K = 30;
const picked = [];
for (let i = 0; i < K; i++) {
    picked.push(rows[Math.floor((i * N) / K)]);
}

for (const [i, r] of picked.entries()) {
    const lines = fs.readFileSync(`${repo}/${r.path}`, 'utf8').split(/\r?\n/);
    const from = Math.max(1, r.line - 4);
    const to = Math.min(lines.length, r.line + 1);
    console.log(`\n### ${i + 1}. ${r.path}:${r.line}  ${r.content.trim()}`);
    for (let n = from; n <= to; n++) {
        const mark = n === r.line ? '>>' : '  ';
        console.log(`${mark} ${String(n).padStart(5)} | ${lines[n - 1]}`);
    }
}
