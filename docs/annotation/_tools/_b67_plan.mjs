import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'packages/ui/src/app-shell/WorkflowRunPhaseList.tsx',
  'packages/ui/src/components/ai-elements/audio-player.tsx',
  'packages/ui/src/lib/markdownFileLink.ts',
  'packages/ui/src/MessageChangeSummaryPanel.tsx',
  'packages/ui/src/settings/saved-workflows/SavedWorkflowCard.tsx',
  'packages/ui/src/ToolCallBlocks/renderers/get-workflow-run.tsx',
  'packages/ui/src/v4/useV4SessionQuotaBanner.ts',
  'apps/zcode-cli/packages/adapters/src/config/index.ts',
  'apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts',
  'apps/zcode-cli/packages/core/src/workflow/scheduler/collection-planner.ts',
  'packages/desktop/src/host/remoteMediaPreviewProxy.ts',
  'packages/desktop/src/host/serverRemoteConnection.ts',
];
const byPath = new Map(rows.map((r) => [r.path, r]));
let total = 0;
for (const p of list) {
  const r = byPath.get(p);
  if (!r) { console.log('MISSING', p); continue; }
  const target = Math.round(r.code * 0.314) - r.comment;
  total += target;
  console.log(`${String(target).padStart(4)}  code=${String(r.code).padStart(5)} comment=${String(r.comment).padStart(4)} pct=${((r.comment / r.code) * 100).toFixed(2)}  ${p}`);
}
console.log('TOTAL', total);
