// check-upstream-comments.mjs / check-comments-in-strings.mjs 阴性对照
// 目的：证明两个验收脚本能抓到已知坏样本，避免「检查器失效却报通过」。
// 场景：
//   C0 基线不变            -> upstream missing=0，退出码 0
//   A  故意删 2 条上游注释  -> upstream missing=2，退出码 1
//   B  删 1 条再加 1 条同文 -> upstream missing=0，退出码 0（多重集计数守恒）
//   C  注释落进字符串       -> comments-in-strings violations>=1
// 用法：node test-upstream-comments.mjs
// 退出码：0 = 四场景全部符合预期；1 = 至少一项不符。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const upstreamScript = path.join(here, 'check-upstream-comments.mjs');
const stringsScript = path.join(here, 'check-comments-in-strings.mjs');

const BASE = String.raw`// 顶层注释 A：入口说明
// 顶层注释 B：参数约束
export function run(input: string): string {
    // 循环前说明 C
    const pattern = /^---[\t ]*$/m;
    // 分支说明 D
    if (pattern.test(input)) {
        return input.replace(/\{+/, '');
    }
    // 收尾说明 E
    return input; // 行尾注释不计入本检查
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-upstream-control-'));
const sample = path.join(tmp, 'sample.ts');
const list = path.join(tmp, 'files.txt');
fs.writeFileSync(list, 'sample.ts\n');

const git = (args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
fs.writeFileSync(sample, BASE);
git(['init', '-q']);
git(['add', 'sample.ts']);
git(['-c', 'user.email=control@example.invalid', '-c', 'user.name=control', 'commit', '-q', '-m', 'baseline']);

function runUpstream(label) {
    const r = spawnSync(process.execPath, [upstreamScript, tmp, list, 'HEAD'], { encoding: 'utf8' });
    const out = (r.stdout || '').trim();
    const m = /missing=(\d+)/.exec(out);
    const missing = m ? Number(m[1]) : NaN;
    console.log(`### ${label}`);
    console.log(out || '(no stdout)');
    console.log(`exit=${r.status}`);
    console.log('');
    return { missing, status: r.status };
}

function runStrings(label) {
    const r = spawnSync(process.execPath, [stringsScript, tmp, path.join(tmp, 'leak-list.txt')], { encoding: 'utf8' });
    const out = (r.stdout || '').trim();
    const m = /violations=(\d+)/.exec(out);
    const violations = m ? Number(m[1]) : NaN;
    console.log(`### ${label}`);
    console.log(out || '(no stdout)');
    console.log(`exit=${r.status}`);
    console.log('');
    return { violations, status: r.status };
}

const checks = [];
const expect = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`);
};

// C0：基线不变
fs.writeFileSync(sample, BASE);
const c0 = runUpstream('C0 基线不变');
expect('C0 missing=0', c0.missing === 0 && c0.status === 0, `missing=${c0.missing} exit=${c0.status}`);

// A：故意删 2 条上游注释
const aText = BASE.split('\n')
    .filter((l) => !l.includes('循环前说明 C') && !l.includes('收尾说明 E'))
    .join('\n');
fs.writeFileSync(sample, aText);
const a = runUpstream('A 故意删 2 条上游注释');
expect('A missing=2', a.missing === 2 && a.status === 1, `missing=${a.missing} exit=${a.status}`);

// B：删 1 条又加 1 条同文
const bText = BASE.split('\n')
    .filter((l) => !l.includes('分支说明 D'))
    .join('\n')
    .replace(/\n?$/, '\n// 分支说明 D\n');
fs.writeFileSync(sample, bText);
const b = runUpstream('B 删 1 条又加 1 条同文');
expect('B missing=0', b.missing === 0 && b.status === 0, `missing=${b.missing} exit=${b.status}`);

// C：注释落进字符串
const leak = path.join(tmp, 'leak.ts');
const leakList = path.join(tmp, 'leak-list.txt');
fs.writeFileSync(leak, 'export const template = `\n// 这是落进字符串的注释\n`;\n');
fs.writeFileSync(leakList, 'leak.ts\n');
const c = runStrings('C 注释落进字符串');
expect('C violations>=1 且 exit=1', Number.isFinite(c.violations) && c.violations >= 1 && c.status === 1, `violations=${c.violations} exit=${c.status}`);

fs.rmSync(tmp, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
    console.log(`NEGATIVE-CONTROL FAIL (${failed.map((f) => f.name).join(', ')})`);
    process.exit(1);
}
console.log('NEGATIVE-CONTROL PASS (C0/A/B/C)');
process.exit(0);
