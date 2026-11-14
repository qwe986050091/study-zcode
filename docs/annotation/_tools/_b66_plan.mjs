import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'packages/ui/src/components/ui/carousel.tsx',
  'packages/ui/src/ToolCallBlocks/renderers/list-models.tsx',
  'packages/ui/src/WebRemoteControlMobileShell.tsx',
  'packages/ui/src/WorkspaceHeader.tsx',
  'apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-reads.ts',
  'apps/zcode-cli/packages/tui/src/app-events.ts',
  'packages/shared/src/usage-stats.ts',
  'packages/ui/src/app-shell/SubagentDirectorySidePane.tsx',
  'packages/ui/src/hooks/useZCodeTaskService.ts',
  'packages/ui/src/root/remoteWorkspaceSessionPersistence.ts',
  'packages/ui/src/store/whiteboardStore.ts',
  'packages/ui/src/components/ui/smooth-metric-value.tsx',
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
