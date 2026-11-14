import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-b4-density.json', 'utf8'));
const fix = { 'packages/services/src/session/automationService.ts': 2, 'packages/services/src/session/automationCron.ts': 2 };
const rows = data.rows.map((r) => ({ ...r, newComments: r.newComments + (fix[r.path] ?? 0), comment: r.comment + (fix[r.path] ?? 0) }));
const groups = {
  'seg1 小文件/端口/类型': ['sessionMailbox','sessionRealtimePort','sessionTitle','toolPlanAdapter','zcodeTaskListTypes','legacyTaskSessionFile','offPeakTask','mcpWorkspaceScope','taskChangeSummary','continuousStreamCoalescer','controllerRemoteIdentityMigration','offPeakWorkspaceIdentityMigration','offPeakRuntimeModel'],
  'seg2 claude-native 导入链路': ['claudeNativeSessionHeadParser','importedClaudeTaskFileFilter','jsonLineRecord','sessionHistoryJsonl','buildImportedClaudeTaskFile','persistImportedClaudeTask','claudeNativeSessionImportRepo','claudeNativeSessionImportService','claudeNativeSessionImportParser','claudeNativeImportedSessionTypes','importedClaudeHistoryRepair'],
  'seg3 tasksDatabase 迁移': ['schema-v1','migrations','prepared','provider-selection-v2','official-glm-selection-v3','controller-remote-schema-v4','source-server-schema-v5'],
  'seg4 automation': ['automationService','automationRepo','automationCron','automationCronValidation','automationIntervalCarrier'],
  'seg5 索引/别名/任务服务': ['taskIndexRepo','sourceServerWorkspaceAliasRepo','zcodeTaskService'],
  'seg6 off-peak': ['offPeakTaskRepo','offPeakTaskService','offPeakServerClient','offPeakResidentExecutions','offPeakMockGateway'],
};
const used = new Set();
let total = 0;
for (const [name, bases] of Object.entries(groups)) {
  let sum = 0, n = 0;
  for (const r of rows) {
    const base = r.path.split('/').pop().replace(/\.ts$/, '');
    if (bases.includes(base) && !used.has(r.path)) { sum += r.newComments; n++; used.add(r.path); }
  }
  total += sum;
  console.log(`${name}\tfiles=${n}\t+${sum}`);
}
console.log('grouped', total, 'rows', rows.length, 'ungrouped', rows.filter(r => !used.has(r.path)).map(r => r.path));
console.log('sum', rows.reduce((a, r) => a + r.newComments, 0));
for (const r of rows.sort((a,b)=>a.measured-b.measured)) console.log(`${r.path}\t${r.comment - r.newComments}/${r.code}\t${r.comment}/${r.code}=${r.measured.toFixed(2)}%\t+${r.newComments}`);
