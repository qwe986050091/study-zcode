import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const want = [
  'packages/ui/src/hooks/useAppPanels.ts',
  'packages/ui/src/lib/workspaceSidePane.ts',
  'packages/ui/src/App.tsx',
  'packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts',
  'apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts',
  'apps/zcode-cli/packages/adapters/src/model/runner-stream.ts',
];
for (const p of want) {
  const r = d.rows.find((x) => x.path === p);
  console.log(r ? `${p} code=${r.code} comment=${r.comment} pct=${r.pct} need=${r.need}` : `MISSING ${p}`);
}
