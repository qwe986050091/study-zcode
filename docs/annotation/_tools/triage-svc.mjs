// 只读分诊：对 <15% 文件抽取「关键性」证据信号，不做任何改写。
// 输出一行一文件：内文率 / 代码行 / 总行数 / 信号位 / 首条注释摘要。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const input = 'D:/code/_annot_baseline/inner-services-after.json';
const threshold = Number(process.argv[2] ?? 15);

const rows = JSON.parse(fs.readFileSync(input, 'utf8')).rows
  .filter((r) => r.ratio < threshold)
  .sort((a, b) => a.path.localeCompare(b.path));

const SIGNALS = [
  ['child', /\b(spawn|execFile|exec|fork)\s*\(/],
  ['fsio', /from ["']node:fs|from ["']fs["']|readFile|writeFile|appendFile|rename|fsync|mkdir|rm\s*\(|realpath/],
  ['lock', /\b(lock|mutex|semaphore|queue|inFlight|pending|inflight|AbortController|serial|exclusive|atomic)/i],
  ['crash', /(rename|tmp|temp|\.bak|fsync|flush|commit|transaction|rollback|recover)/i],
  ['auth', /(token|oauth|credential|password|secret|bearer|apiKey|authorization)/i],
  ['path', /(resolve|relative|isAbsolute|realpath|normalize|\.\.\/|sep)/],
  ['machine', /\b(state|phase|status|transition|lifecycle|dispose|shutdown|close|terminal|settle)\b/i],
  ['serde', /(JSON\.parse|JSON\.stringify|schema|migrat|version|legacy|parse\w*\()/],
  ['time', /(setInterval|setTimeout|setImmediate|Date\.now|cron|schedule)/],
  ['net', /(WebSocket|http|https|fetch|socket|listen|connect)/],
];

const out = [];
for (const r of rows) {
  const abs = path.join(repo, r.path);
  let text = '';
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    out.push(`${r.path}\tREAD_FAIL`);
    continue;
  }
  const loc = text.split('\n').length;
  const flags = SIGNALS.filter(([, re]) => re.test(text)).map(([k]) => k).join(',');
  const firstComment = (text.match(/^\s*(?:\/\/|\/\*|\*)\s*(.+)$/m)?.[1] ?? '').slice(0, 70);
  out.push(
    `${r.path}\t${(r.ratio * 100).toFixed(2)}%\t${r.innerZh}/${r.innerCode}\tLOC=${loc}\t[${flags}]\t${firstComment}`,
  );
}
console.log(`FILES=${out.length} threshold=${threshold}`);
console.log(out.join('\n'));
