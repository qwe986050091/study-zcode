// 批次注释校验脚本（Go / etcd-io/raft）
// 用法：node d:\code\_annot_baseline\rv-verify.mjs <批次名>
//   批次名可带或不带 RV- 前缀，例如 RV-raft-b1 / raft-b1
// 口径：
//   1) 逐文件 git --no-pager diff --no-index --numstat <基线> <工作区>，删除列必须为 0
//   2) 逐文件语法检查：gofmt -e <file>
//      - 实测结论（2026-11-05，本机 Go 1.27.1 @ D:\program\gosdk\go1.27.1\bin\gofmt.exe）：
//        gofmt -e 在解析失败时把 "file:line:col: ..." 打到 stderr 并以 2 退出；
//        解析成功时只把格式化结果写到 stdout、退出码 0。
//        它是纯本地二进制、不读 go.mod 不联网，因此优先用它，而不是 go vet / go build
//        （后者需要模块依赖，离线环境下可能失败或超时）。
//      - 若 PATH 中找不到 gofmt，再尝试 GOFMT 环境变量 / D:\program\gosdk\go1.27.1\bin\gofmt.exe，
//        都不可用时退化为 go/parser 的 go run 脚本（本脚本内联生成临时文件）。
//      - 两者都找不到时 **fail-closed**：计入 syntaxErr 并以非零码退出，不再“跳过即通过”。
// 输出末行：SUMMARY files=<n> added=<n> deletedNonZero=<n> syntaxErr=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'd:\\code\\opensource\\raft';
const BASE = 'd:\\code\\_annot_baseline';

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawArg) {
  console.error('usage: node rv-verify.mjs <batch>');
  process.exit(2);
}
const batch = rawArg.replace(/^RV-/, '');
const batchDir = path.join(BASE, 'RV-' + batch);
if (!fs.existsSync(batchDir)) {
  console.error('baseline not found: ' + batchDir);
  process.exit(2);
}

const manifest = path.join(batchDir, '_files.txt');
const rels = fs.existsSync(manifest)
  ? fs
      .readFileSync(manifest, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+/)[0])
  : [];

// ---------- 语法检查方式 1：gofmt -e ----------
function findGofmt() {
  // 顺序：显式指定 → 本机真实安装路径 → PATH。PATH 只作兜底，因为
  // 本机 gofmt 不在 PATH 上，若把 'gofmt' 放前面会静默降级成“找不到”。
  const cands = [
    process.env.GOFMT,
    'D:\\program\\gosdk\\go1.27.1\\bin\\gofmt.exe',
    'D:\\program\\go\\bin\\gofmt.exe',
    'gofmt',
  ].filter(Boolean);
  for (const c of cands) {
    // 带分隔符的候选先判存在性，避免把“路径写错”和“二进制不可执行”混为一谈。
    if (/[\\/]/.test(c) && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-h'], { encoding: 'utf8' });
    // gofmt 的 -h 会把 usage 打到 stderr 并以 2 退出；能跑起来就说明可执行文件存在。
    if (!r.error) return c;
  }
  return null;
}

// ---------- 语法检查方式 2：go/parser（仅在 gofmt 缺失时用） ----------
function findGo() {
  const cands = [
    process.env.GO,
    'D:\\program\\gosdk\\go1.27.1\\bin\\go.exe',
    'go',
  ].filter(Boolean);
  for (const c of cands) {
    if (/[\\/]/.test(c) && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (!r.error) return c;
  }
  return null;
}

let goParserDir = null;
function ensureGoParser(goBin) {
  if (goParserDir) return goParserDir;
  goParserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-goparse-'));
  fs.writeFileSync(
    path.join(goParserDir, 'main.go'),
    `package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"os"
)

func main() {
	fset := token.NewFileSet()
	_, err := parser.ParseFile(fset, os.Args[1], nil, parser.AllErrors)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\\n", err)
		os.Exit(2)
	}
}
`,
  );
  return goParserDir;
}

const gofmt = findGofmt();
const goBin = gofmt ? null : findGo();
let syntaxUnavailable = null;
if (!gofmt && !goBin) {
  // fail-closed：语法检查完全不可用时绝不放行，否则 deletedNonZero=0 会变成假绿。
  syntaxUnavailable = 'neither gofmt nor go found (checked GOFMT/GO env, D:\\program\\gosdk\\go1.27.1\\bin, PATH)';
  console.error('ERROR: syntax check unavailable - ' + syntaxUnavailable);
} else {
  console.log('syntax check: ' + (gofmt ? 'gofmt=' + gofmt : 'go-parser=' + goBin));
}

function syntaxCheck(file) {
  if (gofmt) {
    // -e 不加 -l/-w：不落盘、不重排，只做解析。
    const r = spawnSync(gofmt, ['-e', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.error) return { ok: false, msg: String(r.error) };
    const errText = (r.stderr || '').trim();
    if (r.status !== 0 || errText) return { ok: false, msg: errText.split(/\r?\n/)[0] || 'exit ' + r.status };
    return { ok: true };
  }
  if (goBin) {
    const dir = ensureGoParser(goBin);
    const r = spawnSync(goBin, ['run', path.join(dir, 'main.go'), file], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) return { ok: false, msg: String(r.error) };
    const errText = (r.stderr || '').trim();
    if (r.status !== 0 || errText) return { ok: false, msg: errText.split(/\r?\n/)[0] || 'exit ' + r.status };
    return { ok: true };
  }
  return { ok: false, msg: 'syntax check unavailable: neither gofmt nor go found (fail-closed)' };
}

function numstat(baseFile, curFile) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--numstat', '--', baseFile, curFile], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let added = 0;
  let deleted = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    added += m[1] === '-' ? 0 : Number(m[1]);
    deleted += m[2] === '-' ? 0 : Number(m[2]);
  }
  return { added, deleted };
}

let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let checked = 0;
const problems = [];

for (const rel of rels) {
  const baseFile = path.join(batchDir, rel);
  const curFile = path.join(ROOT, rel);
  if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
    problems.push(`MISSING ${rel} (baseline=${fs.existsSync(baseFile)}, current=${fs.existsSync(curFile)})`);
    deletedNonZero++;
    continue;
  }
  const { added, deleted } = numstat(baseFile, curFile);
  addedSum += added;
  checked++;
  if (deleted > 0) {
    deletedNonZero++;
    problems.push(`DELETED ${deleted}  ${rel}`);
  }
  const sc = syntaxCheck(curFile);
  if (!sc.ok) {
    syntaxErr++;
    problems.push(`SYNTAX ${rel}: ${sc.msg}`);
  }
}

for (const p of problems) console.log(p);
if (syntaxUnavailable) console.log(`ERROR syntax check unavailable: ${syntaxUnavailable}`);
console.log(
  `SUMMARY files=${checked} added=${addedSum} deletedNonZero=${deletedNonZero} syntaxErr=${syntaxErr}`,
);
process.exit(deletedNonZero === 0 && syntaxErr === 0 && !syntaxUnavailable ? 0 : 1);
