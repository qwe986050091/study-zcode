import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts',
  'apps/zcode-cli/packages/core/src/hooks/workspace-hook-review-flow.ts',
  'apps/zcode-cli/packages/core/src/runtime/methods/context.ts',
  'apps/zcode-cli/packages/tui/src/app-tool-transcript.ts',
  'packages/ui/src/components/ai-elements/queue.tsx',
  'packages/ui/src/DesktopTopOverlay.tsx',
  'packages/ui/src/GitPaneChangeCard.tsx',
  'packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx',
  'packages/ui/src/browser-use/ResponsiveBrowserResizeHandles.tsx',
  'packages/ui/src/cua-permission/CuaPermissionObservationAttachment.tsx',
  'packages/ui/src/gen-ui/adapters/retainedPage.ts',
  'packages/ui/src/git-branch-switcher/display.ts',
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
