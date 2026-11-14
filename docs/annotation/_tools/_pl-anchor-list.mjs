#!/usr/bin/env node
// 生成 pluginLoader.ts 的「391 条旧口径非实质行」四锚点判定清单（不批量重写）。
// 旧口径非实质 = 无数字、无反引号、无 ≥3 字符 ASCII 标识符。
// 机器只给出四锚点里可机检的部分；未命中一律标「待人工」，不代替人工判定。
// 用法：node _pl-anchor-list.mjs <file> <out.tsv>
import fs from 'node:fs';

const TAG_STOP = new Set(['STEP', 'INV', 'TODO', 'FIXME', 'NOTE', 'SAFETY', 'XXX', 'HACK']);
const identTokens = (s) => (s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((t) => !TAG_STOP.has(t));
const CONSEQUENCE = /(否则|会导致|导致|破坏|失败|丢失|覆盖|泄漏|泄露|越界|不一致|未定义|崩溃|中断|绕过|误判|拒绝)/;
const IO_VERB = /(写|读|消费方|调用方|生成|落盘|序列化|反序列化|校验|透传|回填|收集|聚合)/;
const BRANCH_WORD = /(分支|路径|情形|场景|情况|事件)/;

const [file, outPath] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

// 将连续的 // 行合并成段落，用于整句判定（§5.2：折行按整句判）
const rows = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (!/^\/\//.test(t) || !/[\u4e00-\u9fa5]/.test(t)) continue;
  let j = i;
  const seg = [];
  while (j < lines.length) {
    const tt = lines[j].trim();
    if (!/^\/\//.test(tt) || !/[\u4e00-\u9fa5]/.test(tt)) break;
    seg.push(tt.replace(/^\/\/\s?/, ''));
    j++;
  }
  const text = seg.join('');
  const oldSubst = /\d/.test(text) || /`[^`]+`/.test(text) || identTokens(text).length > 0;
  if (!oldSubst) {
    const anchors = [];
    if (/`[^`]+`/.test(text) || identTokens(text).length > 0) anchors.push('A1');
    if (/\d/.test(text) && /(ms|毫秒|秒|分钟|次|条|个|字节|KB|MB|行|上限|下限|长度)/.test(text)) anchors.push('A2');
    if (IO_VERB.test(text) && CONSEQUENCE.test(text)) anchors.push('A3');
    if (BRANCH_WORD.test(text) && /(不同|差别|差异|相比|而|仅|只)/.test(text)) anchors.push('A4');
    rows.push({
      line: i + 1,
      lines: j - i,
      text,
      anchors: anchors.length ? anchors.join('+') : '-',
      verdict: anchors.length ? '机器可证' : '待人工',
    });
  }
  i = j - 1;
}

const tsv = ['line\tlines\tverdict\tanchors\ttext', ...rows.map((r) => `${r.line}\t${r.lines}\t${r.verdict}\t${r.anchors}\t${r.text}`)].join('\n');
fs.writeFileSync(outPath, tsv + '\n', 'utf8');
const auto = rows.filter((r) => r.verdict === '机器可证').length;
console.log(`rows=${rows.length} auto=${auto} manual=${rows.length - auto}`);
const byAnchor = {};
for (const r of rows) if (r.anchors !== '-') byAnchor[r.anchors] = (byAnchor[r.anchors] || 0) + 1;
console.log('anchors=' + JSON.stringify(byAnchor));
