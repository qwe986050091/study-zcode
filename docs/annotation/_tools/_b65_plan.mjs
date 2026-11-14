import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'packages/ui/src/v4/windowControllerTaskListRegistry.ts',
  'packages/desktop/src/main/forceUpdateGuard.ts',
  'packages/ui/src/components/ai-elements/package-info.tsx',
  'packages/ui/src/feedback/FeedbackScreenshotPicker.tsx',
  'packages/ui/src/resource-manager/ResourceManagerApp.tsx',
  'packages/ui/src/settings/usage-stats/AppUsagePanel.tsx',
  'packages/ui/src/ToolCallBlocks/renderers/agentHelpers.ts',
  'packages/zcode-server-cli/src/packaging/stage.ts',
  'apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts',
  'apps/zcode-cli/packages/cli/src/arguments.ts',
  'apps/zcode-cli/packages/core/src/runtime/methods/context-usage.ts',
  'packages/server/src/remote/remoteAssetLiveIdentity.ts',
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
