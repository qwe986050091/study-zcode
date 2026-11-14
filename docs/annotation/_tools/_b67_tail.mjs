import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts',
  'apps/zcode-cli/packages/core/src/workflow/scheduler/collection-planner.ts',
  'packages/desktop/src/host/remoteMediaPreviewProxy.ts',
  'packages/desktop/src/host/serverRemoteConnection.ts',
];
const byPath = new Map(rows.map((r) => [r.path, r]));
for (const p of list) {
  const r = byPath.get(p);
  const target = Math.round(r.code * 0.314) - r.comment;
  console.log(`${target}  ${p}`);
}
