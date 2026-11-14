// 一档内部优先序 v2：按「实际做了什么」判定，而不是按文件名缺不缺可恢复标记。
// A = 有不可逆证据；B = 有可恢复证据且无不可逆证据；C = 未判定（两组证据都没有）。
// 输入：ZC-SCOPE-TIERS.tsv（tier=1，排除已定格的 browserGuestManager.ts）。
import fs from 'node:fs';

const ROOT = 'd:/code/ZCode/';
const EXCLUDE = 'packages/desktop/src/main/browserView/browserGuestManager.ts';
const rows = fs.readFileSync(ROOT + 'docs/annotation/ZC-SCOPE-TIERS.tsv', 'utf8')
  .trim().split('\n').slice(1).map((l) => l.split('\t'))
  .filter((c) => c[1] === '1' && c[0] !== EXCLUDE)
  .map((c) => ({ file: c[0], units: +c[4], covered: +c[5], uncovered: +c[6] }));

// 注释/字符串/模板里的同名文字不算证据。
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

// 不可逆证据：读写的对象是不是凭据/令牌、是否删文件、是否起进程、是否注册 IPC、是否构成鉴权判定。
const IRREV = [
  ['凭据/令牌', /\b(credentialService|saveActiveTokenSet|loadActiveTokenSet|getActiveTokenSet|clearActiveSession|safeStorage|keytar|accessToken|refreshToken|idToken|clientSecret|privateKey|password)\b/],
  ['文件删除', /\b(unlinkSync|unlink|rmdirSync|rmdir|rmSync|rimraf)\s*\(/],
  ['进程启动', /\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/],
  ['IPC/桥接入口', /\b(ipcMain|ipcRenderer|contextBridge)\s*\./],
  ['鉴权判定', /\b(isAuthorized|authorize|hasPermission|checkPermission|assertPermission|isPathInside)\b/],
  ['远程执行', /\b(ssh|sftp|docker|wsl|powershell|bash\s+-c)\b/],
];
// 可恢复证据：坏了能重放/重建/降级。
const RECOV = [
  ['缓存/快照', /\b(cache|Cache|snapshot)\b/],
  ['视图/呈现', /\b(viewport|screenshot|thumbnail|preview|indicator|display)\b/],
  ['度量/上报', /\b(telemetry|metric|report|analytics)\b/],
  ['进度/状态', /\b(progress|heartbeat|status)\b/],
  ['通知/剪贴板', /\b(notify|notification|clipboard)\b/],
];

const out = [];
for (const r of rows) {
  let src = '';
  try { src = codeOnly(fs.readFileSync(ROOT + r.file, 'utf8')); } catch { /* 读不到按未判定 */ }
  const ir = IRREV.filter(([, re]) => re.test(src)).map(([n]) => n);
  const rv = RECOV.filter(([, re]) => re.test(src)).map(([n]) => n);
  const group = ir.length ? 'A' : rv.length ? 'B' : 'C';
  out.push({ ...r, group, ir, rv });
}

const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
for (const g of ['A', 'B', 'C']) {
  const a = out.filter((r) => r.group === g);
  console.log(`${g}\tfiles=${a.length}\tunits=${sum(a, 'units')}\tcovered=${sum(a, 'covered')}\tuncovered=${sum(a, 'uncovered')}`);
}
// 风险序（用户给定）：凭据/令牌 → 远程控制与鉴权 → 文件删除 → 进程启动 → IPC 入口
const order = { '凭据/令牌': 0, 远程执行: 1, 鉴权判定: 1, 文件删除: 2, 进程启动: 3, 'IPC/桥接入口': 4 };
const rank = (r) => Math.min(...r.ir.map((n) => order[n] ?? 9));
console.log('\n== A（按风险类别 + 未覆盖降序）==');
for (const r of out.filter((r) => r.group === 'A').sort((x, y) => rank(x) - rank(y) || y.uncovered - x.uncovered)) {
  console.log(`${rank(r)}\t${r.uncovered}\t${r.units}\t${r.file}\t${r.ir.join('/')}`);
}
console.log('\n== C（未判定，全量）==');
for (const r of out.filter((r) => r.group === 'C').sort((x, y) => y.uncovered - x.uncovered)) {
  console.log(`${r.uncovered}\t${r.units}\t${r.file}`);
}
console.log('\n== B（全量）==');
for (const r of out.filter((r) => r.group === 'B').sort((x, y) => y.uncovered - x.uncovered)) {
  console.log(`${r.uncovered}\t${r.units}\t${r.file}\t${r.rv.join('/')}`);
}
fs.writeFileSync('d:/code/_annot_baseline/_priority2.json', JSON.stringify(out, null, 1));
