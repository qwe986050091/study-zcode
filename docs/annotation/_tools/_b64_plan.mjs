import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'apps/zcode-cli/packages/cli/src/command-center/types.ts',
  'packages/desktop/src/scheduler/index.ts',
  'packages/ui/src/browser-use/BrowserViewportToolbar.tsx',
  'packages/ui/src/project-sidebar/RemoteProjectList.tsx',
  'packages/ui/src/ToolCallBlocks/renderers/cuaListDetails.tsx',
  'packages/ui/src/v4/composer/V4ComposerModeControls.tsx',
  'packages/zcode-server-cli/src/contracts.ts',
  'packages/zcode-server-cli/src/runtime/updatePreparation.ts',
  'apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts',
  'packages/desktop/src/main/desktopSaveFile.ts',
  'packages/ui/src/components/cloud-content-dialog/CloudContentDialog.tsx',
  'packages/ui/src/settings/McpServerList.tsx',
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
