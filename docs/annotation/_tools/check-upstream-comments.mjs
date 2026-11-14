// 上游注释行守恒检查（2026-11-08 新增，rev2）
// 目的：只比较「新增/删除行数」抓不到「删掉一条上游注释、又补一条自己的注释」这种净值为零的破坏。
// 做法：从 git 指定 ref（默认 HEAD）取基线文件，与工作区文件分别抽出**整行注释**，
//       按「规范化文本 → 次数」做多重集比对；HEAD 里出现 N 次的注释，工作区必须仍出现 >= N 次。
// 范围：整行 `//`、整行块注释 `/* ... */` 及其 `*` 续行；不含行尾注释（行尾注释不参与本检查）。
// rev2 说明：rev1 用 TS createScanner 扫描整份文件，遇到复杂模板/正则时会在中途失同步，
//            导致只抽出少量注释、把真实删除误判为通过（extension.ts 实测只抽出 6/10 条）。
//            改为逐行状态机，不依赖词法器复位；字符串里的 `//` 不会以整行形式出现，故不误计。
// 用法：node check-upstream-comments.mjs <repo> <file-list.txt> [ref] [out.json]
// 输出：SUMMARY files= checked= upstreamComments= missing=，missing>0 时逐条打印。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2];
const listFile = process.argv[3];
const ref = process.argv[4] || 'HEAD';
const outJson = process.argv[5];
if (!repo || !listFile) {
    console.error('usage: node check-upstream-comments.mjs <repo> <file-list.txt> [ref] [out.json]');
    process.exit(2);
}

const norm = s => s.replace(/\s+/g, ' ').trim();

function extractLineComments(text) {
    const out = [];
    let inBlock = false;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (inBlock) {
            const body = t.replace(/^\*+/, '');
            const closed = body.includes('*/');
            const piece = norm(body.replace(/\*\/.*$/, ''));
            if (piece) out.push({ line: i + 1, text: piece });
            if (closed) inBlock = false;
            continue;
        }
        if (t.startsWith('/*')) {
            const body = t.replace(/^\/\*+/, '');
            const closed = body.includes('*/');
            const piece = norm(body.replace(/\*\/.*$/, '').replace(/^\*+/, ''));
            if (piece) out.push({ line: i + 1, text: piece });
            if (!closed) inBlock = true;
            continue;
        }
        if (t.startsWith('//')) {
            const piece = norm(t.replace(/^\/\/+/, ''));
            if (piece) out.push({ line: i + 1, text: piece });
        }
    }
    return out;
}

const files = fs
    .readFileSync(listFile, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

const rows = [];
let checked = 0;
let upstreamTotal = 0;
let missingTotal = 0;
const unsupported = [];

for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.c', '.h', '.go'].includes(ext)) {
        unsupported.push(rel);
        continue;
    }
    let base;
    try {
        base = execFileSync('git', ['-C', repo, 'show', `${ref}:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
        continue;
    }
    const curPath = path.join(repo, rel);
    if (!fs.existsSync(curPath)) {
        rows.push({ path: rel, missing: [{ line: 0, text: '<file deleted>', count: 1, found: 0 }] });
        missingTotal += 1;
        continue;
    }
    const baseCmt = extractLineComments(base);
    const curCmt = extractLineComments(fs.readFileSync(curPath, 'utf8'));
    const curCount = new Map();
    for (const c of curCmt) curCount.set(c.text, (curCount.get(c.text) ?? 0) + 1);
    const baseCount = new Map();
    for (const c of baseCmt) baseCount.set(c.text, (baseCount.get(c.text) ?? 0) + 1);

    const missing = [];
    for (const [text, need] of baseCount) {
        const have = curCount.get(text) ?? 0;
        if (have < need) {
            const line = baseCmt.find(c => c.text === text)?.line ?? 0;
            missing.push({ line, text: text.slice(0, 140), count: need, found: have });
        }
    }
    checked += 1;
    upstreamTotal += baseCmt.length;
    missingTotal += missing.length;
    rows.push({ path: rel, upstream: baseCmt.length, current: curCmt.length, missing });
}

for (const r of rows) {
    for (const m of r.missing) {
        console.log(`MISSING\t${r.path}:${m.line}\tneed=${m.count}\tfound=${m.found}\t${m.text}`);
    }
}

console.log(`SUMMARY files=${files.length} checked=${checked} upstreamComments=${upstreamTotal} missing=${missingTotal}`);
if (unsupported.length) console.log(`NOTE unsupported=${unsupported.length} (${unsupported.slice(0, 5).join(', ')})`);

if (outJson) fs.writeFileSync(outJson, JSON.stringify({ ref, rows, summary: { files: files.length, checked, upstreamTotal, missingTotal } }, null, 2), 'utf8');
process.exit(missingTotal > 0 ? 1 : 0);
