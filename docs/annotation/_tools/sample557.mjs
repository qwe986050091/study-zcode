import fs from 'node:fs';

const REPO = 'd:/code/opensource/mcp-sdk';
const rows = fs
    .readFileSync('d:/code/_annot_baseline/all-uncovered2.txt', 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(l => {
        const [p, ln, , text] = l.split('\t');
        return { p, ln: Number(ln), text: text ?? '' };
    });

const isReexport = t => /^\s*export\s+(const|type)\s+\w+\s*=\s*(?:s\.\w+|\w+\.\w+)\s*;?\s*$/.test(t);
const isBarrel = t => /^\s*export\s+(type\s+)?(\*|\{)/.test(t);
const isParam = t =>
    /^\s*(?:(?:public|private|protected|readonly|static|override)\s+)*[A-Za-z_$][\w$]*\??\s*:\s*\S/.test(t) ||
    /^\s*\.\.\.[A-Za-z_$][\w$]*\s*[,;]?\s*$/.test(t) ||
    /^\s*[A-Za-z_$][\w$]*\??\s*[,;]\s*$/.test(t) ||
    /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+\w+.*\{\s*$/.test(t) ||
    /^\s*declare\s+module\s+/.test(t) ||
    /^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*[(<]/.test(t) ||
    /^\s*(?:(?:public|private|protected|static|async|override)\s+)+[A-Za-z_$][\w$]*\s*\(/.test(t) ||
    /^\s*[A-Za-z_$][\w$]*\s*\(.*\)\s*:\s*.+;\s*$/.test(t);

const pkgOf = p =>
    p.startsWith('packages/client/')
        ? 'client'
        : p.startsWith('packages/core-internal/')
          ? 'core-internal'
          : p.startsWith('packages/server-legacy/')
            ? 'server-legacy'
            : p.startsWith('packages/server/')
              ? 'server'
              : p.startsWith('packages/core/')
                ? 'core'
                : 'middleware';

const paramRows = rows.filter(r => !isReexport(r.text) && !isBarrel(r.text) && isParam(r.text));
const byPkg = {};
for (const r of paramRows) (byPkg[pkgOf(r.p)] ??= []).push(r);

// 分层配比：按各包未覆盖总数（233/283/154/5）分配 60；server-legacy 保底 1，从 server 挪 1。
const uncoveredByPkg = { client: 233, server: 283, 'core-internal': 154, 'server-legacy': 5 };
const totalUncovered = Object.values(uncoveredByPkg).reduce((a, b) => a + b, 0);
const target = { client: 21, server: 24, 'core-internal': 14, 'server-legacy': 1 };

console.log('=== param population per package ===');
for (const [p, arr] of Object.entries(byPkg)) console.log(`${p}\t${arr.length}`);
console.log(`total param\t${paramRows.length}`);
console.log('=== allocation ===');
for (const [p, k] of Object.entries(target)) {
    const pop = (byPkg[p] ?? []).length;
    console.log(`${p}\tpop=${pop}\tsample=${k}\tproportional=${((uncoveredByPkg[p] / totalUncovered) * 60).toFixed(2)}`);
}

const fileCache = new Map();
const readFile = p => {
    if (!fileCache.has(p)) fileCache.set(p, fs.readFileSync(`${REPO}/${p}`, 'utf8').split(/\r?\n/));
    return fileCache.get(p);
};

let n = 0;
for (const pkg of ['client', 'server', 'core-internal', 'server-legacy']) {
    const arr = byPkg[pkg] ?? [];
    const k = Math.min(target[pkg], arr.length);
    for (let i = 0; i < k; i++) {
        const idx = Math.floor(((i + 0.5) * arr.length) / k);
        const r = arr[idx];
        n++;
        const lines = readFile(r.p);
        const from = Math.max(0, r.ln - 5);
        const to = Math.min(lines.length, r.ln + 1);
        console.log(`\n### [${n}] ${r.p}:${r.ln}  === ${r.text.trim()}`);
        for (let j = from; j < to; j++) {
            const mark = j + 1 === r.ln ? '>>' : '  ';
            console.log(`${mark} ${String(j + 1).padStart(5)} | ${lines[j]}`);
        }
    }
}
console.log(`\n=== sampled=${n} ===`);
