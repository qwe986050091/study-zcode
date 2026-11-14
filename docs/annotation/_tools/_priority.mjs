import fs from 'node:fs';

const rows = fs.readFileSync('d:/code/ZCode/docs/annotation/ZC-SCOPE-TIERS.tsv', 'utf8')
  .trim().split('\n').slice(1).map((l) => l.split('\t'));
const t1 = rows.filter((c) => c[1] === '1' && c[0] !== 'packages/desktop/src/main/browserView/browserGuestManager.ts');

const SPECIAL = /(credential|token|secret|oauth|auth|permission|privilege|sandbox|keychain|cipher|encrypt|decrypt|update|updater|install|sign|signature|deploy|ssh|wsl|docker|shell|kill|terminate|delete|unlink|truncate|overwrite|save|database|sqlite|migrat|localmediapreviewprotocol)/i;
const RECOVERABLE = /(cache|cdn|telemetry|metric|log|trace|sampl|snapshot|sync|viewport|display|screenshot|screen|recorder|recording|webm|video|audio|tray|icon|theme|layout|chrome|window|resize|focus|indicator|overlay|cursor|notification|clipboard|preview|list|detect|discovery|probe|status|progress|heartbeat|reconnect|residency|recovery|restore|history|timeout|open|editor|application|print|pdf|resource|pip|network)/i;

function classify(path) {
  const base = path.split('/').pop();
  if (SPECIAL.test(base)) return { group: 'A', why: `文件名命中不可逆操作：${base.match(SPECIAL)[0]}` };
  if (RECOVERABLE.test(base)) return { group: 'B', why: `文件名命中可恢复对象：${base.match(RECOVERABLE)[0]}` };
  return { group: 'A', why: '未命中可恢复特征，按不可逆默认（保守）' };
}

const out = t1.map((c) => ({ file: c[0], units: +c[4], uncovered: +c[6], ...classify(c[0]) }));
const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
for (const g of ['A', 'B']) {
  const a = out.filter((r) => r.group === g);
  console.log(`${g}\tfiles=${a.length}\tunits=${sum(a, 'units')}\tuncovered=${sum(a, 'uncovered')}`);
}
console.log('\n== A top 30 ==');
for (const r of out.filter((r) => r.group === 'A').sort((x, y) => y.uncovered - x.uncovered).slice(0, 30)) {
  console.log(`${r.uncovered}\t${r.units}\t${r.file}\t${r.why}`);
}
console.log('\n== B all ==');
for (const r of out.filter((r) => r.group === 'B').sort((x, y) => y.uncovered - x.uncovered)) {
  console.log(`${r.uncovered}\t${r.units}\t${r.file}\t${r.why}`);
}
fs.writeFileSync('d:/code/_annot_baseline/_priority.json', JSON.stringify(out, null, 1));
