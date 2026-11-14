import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const rows = data.rows || data;
const list = [
  'packages/ui/src/chat-input-toolbar/contextQuotaResetOpportunityReminder.tsx',
  'packages/ui/src/components/ui/floating-particles.tsx',
  'packages/ui/src/plugin-ui/adapters/usePluginUiSidePaneModel.tsx',
  'apps/zcode-cli/packages/office-runtime/ui/i18n.ts',
  'packages/ui/src/components/cloud-content-dialog/CloudDialogDescription.tsx',
  'packages/ui/src/settings/saved-workflows/SavedWorkflowLaunchDialog.tsx',
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
