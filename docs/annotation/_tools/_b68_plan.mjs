import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'packages/ui/src/settings/usage-stats/CodingPlanUsageLineChart.tsx',
  'packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx',
  'apps/zcode-cli/packages/debug/src/shared.ts',
  'packages/desktop/scripts/mcp-apps-host-fixture/managed-checks.ts',
  'packages/ui/src/components/ui/select.tsx',
  'packages/ui/src/feedback/TicketDetail.tsx',
  'packages/ui/src/lib/promptInputTriggers.ts',
  'packages/ui/src/lib/toolDisplay.ts',
  'packages/ui/src/lib/whiteboard.ts',
  'packages/ui/src/resource-manager/storage/StorageSection.tsx',
  'packages/ui/src/v4/ConversationFileRewindDialog.tsx',
  'apps/zcode-cli/packages/adapters/src/model/transform.ts',
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
