// 建立 ZC-deep-svc-b4 基线快照：复制 session/** 下 45 个低于 30% 的文件原文，并写 _files.txt。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const batchDir = 'D:/code/_annot_baseline/ZC-deep-svc-b4';
const origDir = path.join(batchDir, 'orig');

const files = [
  'packages/services/src/session/claude-native/claudeNativeSessionHeadParser.ts',
  'packages/services/src/session/claude-native/importedClaudeTaskFileFilter.ts',
  'packages/services/src/session/claude-native/jsonLineRecord.ts',
  'packages/services/src/session/claude-native/sessionHistoryJsonl.ts',
  'packages/services/src/session/sessionMailbox.ts',
  'packages/services/src/session/sessionRealtimePort.ts',
  'packages/services/src/session/sessionTitle.ts',
  'packages/services/src/session/toolPlanAdapter.ts',
  'packages/services/src/session/zcodeTaskListTypes.ts',
  'packages/services/src/session/tasksDatabase/schema-v1.ts',
  'packages/services/src/session/claude-native/claudeNativeSessionImportService.ts',
  'packages/services/src/session/tasksDatabase/source-server-schema-v5.ts',
  'packages/services/src/session/claude-native/claudeNativeSessionImportRepo.ts',
  'packages/services/src/session/controllerRemoteIdentityMigration.ts',
  'packages/services/src/session/tasksDatabase/migrations.ts',
  'packages/services/src/session/sourceServerWorkspaceAliasRepo.ts',
  'packages/services/src/session/offPeakResidentExecutions.ts',
  'packages/services/src/session/sessionModeOptions.ts',
  'packages/services/src/session/continuousStreamCoalescer.ts',
  'packages/services/src/session/automationCronValidation.ts',
  'packages/services/src/session/claude-native/buildImportedClaudeTaskFile.ts',
  'packages/services/src/session/taskChangeSummary.ts',
  'packages/services/src/session/claude-native/importedClaudeHistoryRepair.ts',
  'packages/services/src/session/tasksDatabase/prepared.ts',
  'packages/services/src/session/claude-native/persistImportedClaudeTask.ts',
  'packages/services/src/session/offPeakMockGateway.ts',
  'packages/services/src/session/tasksDatabase/official-glm-selection-v3.ts',
  'packages/services/src/session/tasksDatabase/controller-remote-schema-v4.ts',
  'packages/services/src/session/taskIndexRepo.ts',
  'packages/services/src/session/claude-native/claudeNativeImportedSessionTypes.ts',
  'packages/services/src/session/claude-native/claudeNativeSessionImportParser.ts',
  'packages/services/src/session/automationRepo.ts',
  'packages/services/src/session/mcpWorkspaceScope.ts',
  'packages/services/src/session/offPeakServerClient.ts',
  'packages/services/src/session/offPeakTaskService.ts',
  'packages/services/src/session/tasksDatabase/provider-selection-v2.ts',
  'packages/services/src/session/legacyTaskSessionFile.ts',
  'packages/services/src/session/automationService.ts',
  'packages/services/src/session/offPeakTaskRepo.ts',
  'packages/services/src/session/offPeakRuntimeModel.ts',
  'packages/services/src/session/offPeakWorkspaceIdentityMigration.ts',
  'packages/services/src/session/automationIntervalCarrier.ts',
  'packages/services/src/session/offPeakTask.ts',
  'packages/services/src/session/automationCron.ts',
  'packages/services/src/session/zcodeTaskService.ts',
];

for (const rel of files) {
  const src = path.join(repo, rel);
  const dst = path.join(origDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
fs.writeFileSync(path.join(batchDir, '_files.txt'), files.join('\n') + '\n');
console.log(`snapshot OK files=${files.length}`);
