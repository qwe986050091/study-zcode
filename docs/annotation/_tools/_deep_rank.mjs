import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('D:/code/_annot_baseline/zc-244-v3-map.json', 'utf8'));
const rows = j.rows.map((r) => ({
  path: r.path,
  units: r.units,
  uncovered: r.units - r.covered,
  cov: r.coverage,
  field: r.field,
  fieldUncovered: r.field - r.fieldCovered,
  branchUncovered: r.branch - r.branchCovered,
  texts: (r.uncoveredUnits ?? []).map((u) => u.text),
}));
// 跨进程边界：主进程 / host / preload / renderer 之间的 IPC、postMessage、utilityProcess
const XPROC = /(ipcMain|ipcRenderer|postMessage|utilityProcess|preload|BrowserWindow|webContents|MessagePort|invoke\(|handle\()/;
// 安全相关：鉴权、权限、沙箱、路径校验、凭据、CSP、反序列化
const SEC = /(auth|token|credential|permission|sandbox|sanitiz|validate|path\.|csp|secret|encrypt|origin|allowlist|trust)/i;
const scored = rows.map((r) => {
  const xp = r.texts.filter((t) => XPROC.test(t)).length;
  const sec = r.texts.filter((t) => SEC.test(t)).length;
  const score = r.uncovered * (1 + (xp > 0 ? 1 : 0) + (sec > 0 ? 1 : 0)) + xp * 3 + sec * 3;
  return { ...r, xp, sec, score };
});
scored.sort((a, b) => b.score - a.score);
const total = rows.reduce((n, r) => n + r.uncovered, 0);
console.log('TOTAL uncovered units =', total, 'files with uncovered>0 =', rows.filter((r) => r.uncovered > 0).length);
console.log('path\tuncovered\tunits\tcov%\txproc\tsec\tscore');
for (const r of scored.slice(0, 20))
  console.log(`${r.path}\t${r.uncovered}\t${r.units}\t${r.cov?.toFixed(1)}\t${r.xp}\t${r.sec}\t${r.score}`);
