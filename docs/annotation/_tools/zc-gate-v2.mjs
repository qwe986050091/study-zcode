// ZCode 注释门禁：插入侧与清理侧共用的唯一判据。
// 合并两套既有口径：
//   - qc-poem-audit 的 poem run：连续 >=3 行新增注释，每行正文 <25 字且不含 ASCII/反引号/下划线；
//   - weaklines 的 W/L/B：单行无信息、无信息列举、连续短句堆叠。
// 判据统一后，插入脚本落盘前调用 judgeEntries()，清理脚本用 --scan 扫描同一套规则。
// 取向：宁可误报（误报由人工推翻），不漏报。
//
// 统计口径（硬性）：所有审计一律按「去重文件全量」扫描一次，即同一 rel 路径只计一次；
// 禁止按 ZC-deep-bN/orig 批次快照累加——同一文件可能出现在多个批次目录（如 b120 与 b120a），
// 累加会把同一批注释重复计数（曾出现 74 行实为 37 行 × 2）。参考 `zc-clean-queue.mjs --all`。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const POEM_MIN_RUN = 3;
export const POEM_MAX_LEN = 25;
const TS_PATH = 'D:/code/ZCode/node_modules/typescript/lib/typescript.js';
let tsCache;
function getTs() {
  if (tsCache !== undefined) return tsCache;
  try {
    tsCache = createRequire(import.meta.url)(TS_PATH);
  } catch {
    tsCache = null;
  }
  return tsCache;
}

// JSX 渲染位判定（A 类）：JsxText 里以 // 开头的行不是注释，会被渲染成页面可见文本。
// 判据与 zx-jsx-comment.mjs 的 A 类一致；这里只做插入侧最需要的一条，命中即整批不落盘。
// fail-closed：拿不到 typescript 或解析失败都抛错，由调用方按违规处理。
export function scanJsxTextComments(text, fileName = 'gate.tsx') {
  const ts = getTs();
  if (!ts) throw new Error('typescript 不可用，JSX 位置判定 fail-closed');
  const norm = text.replace(/\r\n/g, '\n');
  const kind = /\.jsx$/.test(fileName)
    ? ts.ScriptKind.JSX
    : /\.tsx$/.test(fileName)
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, norm, ts.ScriptTarget.Latest, true, kind);
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) throw new Error('解析失败: ' + String(diags[0].messageText).slice(0, 120));
  const hits = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const start = node.getStart(sf);
      const baseLine = sf.getLineAndCharacterOfPosition(start).line;
      raw.split('\n').forEach((s, i) => {
        const t = s.trim();
        if (t.startsWith('//')) hits.push({ line: baseLine + i + 1, text: t });
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const TAG_STOP = new Set(['STEP', 'INV', 'TODO', 'FIXME', 'NOTE', 'SAFETY', 'XXX', 'HACK', 'OK', 'NULL']);
const PRECOND =
  /(前提|前置|依赖|必须先|先于|顺序|调用前|调用后|传入|返回|失败|否则|会|导致|破坏|panic|死锁|回滚|重放|越界|不变量|INV-|保证|确保|无法|不能|只能|必须|拒绝|抛出|未|若|如果|一旦|冲突|泄漏|泄露)/;
const INVARIANT = /(唯一|不可变|幂等|原子|有序|单调|只读|线程安全|可重入|有界|不共享|恒定|固定|稳定|从\s*\d+\s*开始)/;
const HEADING = /[:：]\s*$/;
const STRUCTURAL_MARKER = /^(?:```|~~~|eslint-|prettier-|@ts-|#region\b|#endregion\b|\*+$|[═─━]{3,})/;
const PREDICATE =
  /(若|则|会|导致|必须|不能|只能|返回|抛出|写入|读取|分配|释放|等于|大于|小于|防止|保证|确保|因为|所以|但是|而|由|让|保持|限制|覆盖|指向|持有|借用|观测|依赖|产生|触发|恢复|丢弃|重试|拒绝|跳过|合并|拆分|先|再|最后)/;
const ANCHOR = /\d|`[^`]+`/;

export const ident = (s) => (s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((t) => !TAG_STOP.has(t));
export const effLen = (s) => [...s.replace(/\s+/g, '')].length;
export const isSep = (s) => s.replace(/[\s\-=*#/]/g, '') === '';
export const isCommentLine = (line) => line.trim().startsWith('//');
export const contentOf = (line) => line.trim().replace(/^\/\/\s?/, '');

// poem 行：短、纯中文、无标识符锚点。
export function isPoemLine(content) {
  if (content.length === 0) return false;
  if (content.length >= POEM_MAX_LEN) return false;
  if (/[A-Za-z`_]/.test(content)) return false;
  return true;
}

// W：单行无信息（无标识符、无前提/不变量线索）。
export function isWeakContent(content) {
  if (isSep(content)) return false;
  if (STRUCTURAL_MARKER.test(content)) return false;
  if (HEADING.test(content)) return false;
  if (ident(content).length > 0) return false;
  if (PRECOND.test(content)) return false;
  if (INVARIANT.test(content)) return false;
  return true;
}

function bigrams(s) {
  const cs = [...s.replace(/\s+/g, '')];
  const o = new Set();
  for (let i = 0; i + 1 < cs.length; i++) o.add(cs[i] + cs[i + 1]);
  return o;
}
function jac(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

// entries: [{ line: <1-based 行号>, content: <去掉 // 后的正文> }]，必须按行号升序。
// 返回统一判据结果：poem run 优先，其次 B 堆叠，最后 W/L 单行，同一行只计一次。
export function judgeEntries(entries) {
  const rows = [...entries].sort((a, b) => a.line - b.line);
  const findings = [];
  const claimed = new Set();

  // 1) poem run：连续行号、每行都满足 poem 判据。
  let run = [];
  const flushPoem = () => {
    if (run.length >= POEM_MIN_RUN) {
      findings.push({
        kind: 'POEM',
        reason: `poem run ${run.length} 行`,
        line: run[0].line,
        endLine: run[run.length - 1].line,
        lines: run.map((r) => r.content),
      });
      for (const r of run) claimed.add(r.line);
    }
    run = [];
  };
  for (const r of rows) {
    const ok = isPoemLine(r.content);
    if (!ok) flushPoem();
    if (ok) {
      if (run.length && r.line !== run[run.length - 1].line + 1) flushPoem();
      run.push(r);
    }
  }
  flushPoem();

  // 2) B：连续短句堆叠（无锚点、无标识符、<25 字），未被 poem 认领的行才计。
  let block = [];
  const flushBlock = () => {
    if (block.length >= POEM_MIN_RUN) {
      const left = block.filter((r) => !claimed.has(r.line));
      if (left.length >= POEM_MIN_RUN) {
        const avg =
          left.slice(1).reduce((sum, x, z) => sum + jac(bigrams(x.content), bigrams(left[z].content)), 0) /
          Math.max(1, left.length - 1);
        const lead = (x) => [...x.replace(/\s+/g, '')].slice(0, 2).join('');
        const sameLead = left.every((x) => lead(x.content) === lead(left[0].content));
        findings.push({
          kind: 'B',
          reason: avg >= 0.35 ? '同义重复' : sameLead ? '纯排比' : '短句堆叠',
          line: left[0].line,
          endLine: left[left.length - 1].line,
          lines: left.map((r) => r.content),
        });
        for (const r of left) claimed.add(r.line);
      }
    }
    block = [];
  };
  for (const r of rows) {
    const ok = !isSep(r.content) && !ANCHOR.test(r.content) && effLen(r.content) < POEM_MAX_LEN && ident(r.content).length === 0;
    if (!ok) flushBlock();
    if (ok) {
      if (block.length && r.line !== block[block.length - 1].line + 1) flushBlock();
      block.push(r);
    }
  }
  flushBlock();

  // 3) W / L：逐行。
  for (const r of rows) {
    if (claimed.has(r.line)) continue;
    if (isWeakContent(r.content)) {
      findings.push({ kind: 'W', reason: '单行无信息', line: r.line, endLine: r.line, lines: [r.content] });
    }
    const seps = (r.content.match(/[、,，]/g) ?? []).length;
    if (seps >= 2 && !PREDICATE.test(r.content)) {
      findings.push({ kind: 'L', reason: '无信息列举', line: r.line, endLine: r.line, lines: [r.content] });
    }
  }
  return findings;
}

// 连续插入的注释行：只取 before→after 之间新增的 // 行（贪心对齐，插入场景足够）。
export function addedCommentEntries(beforeLines, afterLines) {
  const added = [];
  let j = 0;
  for (let i = 0; i < afterLines.length; i++) {
    if (j < beforeLines.length && afterLines[i] === beforeLines[j]) {
      j++;
    } else if (isCommentLine(afterLines[i])) {
      added.push({ line: i + 1, content: contentOf(afterLines[i]) });
    }
  }
  return added;
}

// 对「即将落盘的插入结果」做门禁：返回违规定位；空数组表示通过。
// 两层判据：先判内容注水（judgeEntries），再判插入位置（JSX 子节点里的 // 会渲染成可见文本）。
export function gateInsertion(beforeLines, afterLines, fileName = 'gate.tsx') {
  const entries = addedCommentEntries(beforeLines, afterLines);
  const findings = judgeEntries(entries);
  const addedLines = new Set(entries.map((e) => e.line));
  let jsxHits;
  try {
    jsxHits = scanJsxTextComments(afterLines.join('\n'), fileName);
  } catch (e) {
    return [
      { kind: 'JSX_GATE', reason: 'JSX 位置判定失败（fail-closed）: ' + e.message, line: 0, endLine: 0, lines: [] },
    ];
  }
  for (const h of jsxHits) {
    if (!addedLines.has(h.line)) continue;
    findings.push({
      kind: 'JSX_TEXT',
      reason: '注释落在 JSX 子节点，会被渲染成页面可见文本',
      line: h.line,
      endLine: h.line,
      lines: [h.text],
    });
  }
  return findings;
}

// 字符串 / 模板字符串字面量覆盖的行号（1-based）。
// 这些行里的 `//` 是字符串内容而不是注释，不能计入注释度量，也不能作为改写对象。
// TypeScript 不可用或解析失败时返回 null，调用方退回「按行前缀判定」的保守口径。
export function stringLiteralLineRanges(text, fileName = 'gate.ts') {
  const ts = getTs();
  if (!ts) return null;
  const kindSet = new Set(
    [
      ts.SyntaxKind.StringLiteral,
      ts.SyntaxKind.NoSubstitutionTemplateLiteral,
      ts.SyntaxKind.TemplateHead,
      ts.SyntaxKind.TemplateMiddle,
      // SyntaxKind[18] 的别名是 LastTemplateToken，与 TemplateTail 同值，按数字比较才可靠。
      ts.SyntaxKind.TemplateTail,
      ts.SyntaxKind.RegularExpressionLiteral,
    ].filter((k) => typeof k === 'number'),
  );
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(fileName)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, kind);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) return null;
  const lines = new Set();
  const visit = (node) => {
    if (kindSet.has(node.kind)) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      for (let l = start; l <= end; l++) lines.add(l);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

// 清理侧：按 git diff <base> 取本工程新增的 // 行，再跑同一套判据。
// base 默认 HEAD；批次已随快照提交后，HEAD 已含这些注释，重跑会恒为 0 行，
// 此时传 --base <快照提交的父提交> 才能复原落盘时的判据条件。
export function scanFile(rel, repo = 'D:/code/ZCode', base = 'HEAD') {
  const r = spawnSync('git', ['-C', repo, '--no-pager', 'diff', '-U0', base, '--', rel], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('git diff 失败: ' + (r.stderr || '').slice(0, 200));
  let literalLines = null;
  try {
    literalLines = stringLiteralLineRanges(fs.readFileSync(path.join(repo, rel), 'utf8'), rel);
  } catch {
    literalLines = null;
  }
  const entries = [];
  let cur = 0;
  for (const l of (r.stdout || '').split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      cur = +m[1];
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      const line = l.slice(1);
      if (isCommentLine(line) && !(literalLines && literalLines.has(cur))) {
        entries.push({ line: cur, content: contentOf(line) });
      }
      cur++;
    } else if (l.startsWith(' ')) cur++;
  }
  return { findings: judgeEntries(entries), addedCommentLines: entries.length };
}

// CLI：node zc-gate.mjs --scan <files.txt>  |  node zc-gate.mjs --file <rel> [--json]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';
  const i = argv.findIndex((a) => a === '--scan' || a === '--file');
  const mode = argv[i];
  const target = argv[i + 1];
  if (!mode || !target) {
    console.error('usage: node zc-gate.mjs --scan <files.txt> | --file <rel> [--base <ref>]');
    process.exit(2);
  }
  const rels =
    mode === '--scan'
      ? fs
          .readFileSync(target, 'utf8')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [target];
  let badFiles = 0;
  let waterLines = 0;
  let added = 0;
  for (const rel of rels) {
    let res;
    try {
      res = scanFile(rel, 'D:/code/ZCode', base);
    } catch (e) {
      console.error(`FAIL ${rel}: ${e.message}`);
      process.exit(1);
    }
    added += res.addedCommentLines;
    if (!res.findings.length) continue;
    badFiles++;
    const lineSet = new Set();
    for (const f of res.findings) for (let l = f.line; l <= f.endLine; l++) lineSet.add(l);
    waterLines += lineSet.size;
    for (const f of res.findings) {
      console.log(`${f.kind} ${rel}:${f.line}${f.endLine > f.line ? '-' + f.endLine : ''} ${f.reason} :: ${f.lines.join(' | ')}`);
    }
  }
  const rate = added ? ((waterLines / added) * 100).toFixed(2) : '0.00';
  // 硬判据：声称在审一个批次（传了 --scan）却一行新增注释都没看到，说明基线选错
  // （最常见是拿 HEAD 当基线，而该批注释早已入库）。这时 waterRate 恒为 0.00%，
  // 若按 PASS 返回，门禁就变成了空跑，比不跑更危险。
  if (mode === '--scan' && added === 0) {
    console.error(
      `ERROR addedCommentLines=0：基线 ${base} 下这些文件没有任何新增注释行。` +
        '若本批已提交，请用 --base <落盘前的父提交>；门禁不接受空跑结果。',
    );
    process.exit(2);
  }
  console.log(`SUMMARY files=${rels.length} badFiles=${badFiles} addedCommentLines=${added} waterLines=${waterLines} waterRate=${rate}%`);
  process.exit(badFiles ? 1 : 0);
}
