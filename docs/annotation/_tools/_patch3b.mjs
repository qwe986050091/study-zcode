import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-3.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const f = s.files.find((x) => x.path.endsWith('/statusFormatting.ts'));
const map = {
  'function readRunningTaskStartedAt(': 'function readRunningTaskStartedAt(snapshot: ZCodeSessionFile | null, task: ZCodeTaskMeta): number | null {',
  'export function readTaskWorkedDurationMs(': 'export function readTaskWorkedDurationMs(snapshot: ZCodeSessionFile | null, task: ZCodeTaskMeta): number | null {',
  'export function readLatestAssistantTurnChangeSummary(': 'export function readLatestAssistantTurnChangeSummary(snapshot: ZCodeSessionFile | null): ZCodeTaskMeta["changeSummary"] | null {',
  'export function formatStatusStreamToolProgress(': 'export function formatStatusStreamToolProgress(event: Extract<ZCodeStreamEvent, { type: "tool_call" | "tool_call_update" }>): string | null {'
};
for (const e of f.edits) {
  if (map[e.anchor]) e.anchor = map[e.anchor];
}
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('patched');
