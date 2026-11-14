import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-history.ts',
  'packages/shared/src/localTtft.ts',
  'packages/server/src/remote/remoteDeployLock.ts',
  'packages/desktop/src/renderer/src/plugin-sandbox/genUi.ts',
  'packages/web/src/web-remote-control/app/webRemoteControlEntry.ts',
  'packages/ui/src/v4/conversationTurnWorkSegments.ts',
  'packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactChartView.tsx',
  'packages/ui/src/chat-input-toolbar/ComposerProviderMenu.tsx',
  'packages/ui/src/components/ai-elements/terminal.tsx',
  'packages/ui/src/lib/taskModelRecovery.ts',
  'packages/ui/src/plugin-ui/adapters/usePluginUiToolCallModel.ts',
  'packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx',
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
