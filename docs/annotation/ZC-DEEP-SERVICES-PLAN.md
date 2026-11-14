# ZC 深度注释计划：packages/services

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）。
> 范围：`packages/services/src/**` 下全部生产 `.ts/.tsx`；排除 `*.test.ts(x)`、`*.spec.ts(x)`、`test-fixture.ts`、`dist/`、`node_modules/`、`__tests__/`、`fixtures/`。
> `packages/core/**`、`apps/**` 不在本计划内，由其他会话负责。

## 1. 基线（2026-11-06，ZC-deep-svc-base 快照）

```text
node d:\code\_annot_baseline\deep-density.mjs d:\code\ZCode \
  --baseline d:\code\_annot_baseline\ZC-deep-svc-base \
  --root packages/services/src --ext .ts,.tsx --threshold 30 --mode code \
  --exclude "packages/services/src/**/*.test.ts,packages/services/src/**/*.test.tsx,packages/services/src/**/*.spec.ts,packages/services/src/**/*.spec.tsx,packages/services/src/**/test-fixture.ts"
```

| 指标 | 值 |
| --- | ---: |
| 受测文件数 | 467 |
| 低于 30%（coreBelow30） | 431 |
| 缺口行数 needLines | 26160 |
| 最低密度 min | 0.00% |
| 中位密度 median | 4.90% |
| 当前注释行 / 代码行 | 7277 / 109922（6.62%） |

口径：`注释行 / 代码行 ≥ 30%`（DEEP-SPEC 第 3 节 C1，`--mode code`）；缺口 `need = ceil(code × 30%) − comment`，逐文件求和，不允许大文件超额抵扣小文件。

## 2. 按目录的缺口分布

| 目录 | 文件数 | 低于 30% | 代码行 | 注释行 | 缺口 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `bots` | 42 | 42 | 18234 | 603 | 4887 |
| `zcode-agent` | 38 | 37 | 19299 | 1699 | 4118 |
| `session` | 46 | 45 | 12438 | 1014 | 2748 |
| `conversation-share` | 11 | 11 | 5933 | 331 | 1456 |
| `model-provider` | 28 | 28 | 4557 | 251 | 1129 |
| `git` | 15 | 15 | 4126 | 180 | 1063 |
| `usage-stats` | 9 | 9 | 3112 | 172 | 766 |
| `settings-sync` | 3 | 3 | 2281 | 13 | 673 |
| `(root)` | 8 | 6 | 3585 | 437 | 646 |
| `oauth` | 15 | 14 | 2594 | 215 | 598 |
| `subagents` | 7 | 7 | 1837 | 52 | 503 |
| `feedback` | 6 | 6 | 1747 | 39 | 487 |
| `process` | 10 | 10 | 1966 | 140 | 455 |
| `plugin-sync` | 4 | 4 | 1449 | 10 | 426 |
| `coding-plan-subscription` | 4 | 2 | 1588 | 134 | 371 |
| `cua-permission-broker` | 11 | 9 | 1711 | 184 | 361 |
| `providers` | 11 | 11 | 1203 | 34 | 332 |
| `project-storage` | 13 | 11 | 1204 | 56 | 313 |
| `system` | 4 | 4 | 1070 | 12 | 312 |
| `terminal` | 5 | 5 | 1147 | 46 | 300 |
| `commands` | 3 | 3 | 1041 | 31 | 282 |
| `skills` | 3 | 3 | 1210 | 98 | 266 |
| `skill-sync` | 5 | 5 | 866 | 12 | 250 |
| `runtime-tools` | 9 | 8 | 1023 | 121 | 205 |
| `storage` | 14 | 12 | 970 | 99 | 203 |
| `remote-projects` | 7 | 6 | 702 | 31 | 185 |
| `mcp-sync` | 2 | 2 | 770 | 50 | 181 |
| `file` | 5 | 3 | 1087 | 185 | 164 |
| `zcode-session` | 5 | 5 | 737 | 69 | 155 |
| `task-groups` | 6 | 5 | 526 | 12 | 151 |
| `hooks` | 5 | 4 | 600 | 40 | 145 |
| `cloud-content` | 3 | 3 | 471 | 1 | 142 |
| `telemetry` | 1 | 1 | 589 | 37 | 140 |
| `setting` | 6 | 6 | 663 | 69 | 132 |
| `project` | 6 | 5 | 610 | 59 | 129 |
| `plugin-ui-bridge` | 10 | 8 | 698 | 90 | 128 |
| `fs` | 2 | 2 | 450 | 18 | 118 |
| `highspeed` | 4 | 4 | 644 | 84 | 111 |
| `memory` | 4 | 3 | 467 | 37 | 108 |
| `gen-ui` | 9 | 9 | 368 | 7 | 107 |
| `plugins` | 6 | 6 | 542 | 69 | 95 |
| `bigmodel` | 2 | 2 | 292 | 8 | 81 |
| `task-facts` | 5 | 4 | 270 | 11 | 74 |
| `source-server-workspace` | 3 | 3 | 304 | 20 | 73 |
| `bot-project-runtime` | 4 | 3 | 213 | 7 | 61 |
| `marketing-touch` | 3 | 3 | 207 | 3 | 61 |
| `onboarding` | 3 | 1 | 357 | 97 | 48 |
| `broadcast` | 2 | 1 | 258 | 42 | 48 |
| `project-workspace-navigation` | 4 | 4 | 167 | 6 | 46 |
| `credential` | 3 | 2 | 236 | 31 | 44 |
| `output-style` | 3 | 2 | 224 | 45 | 40 |
| `client-config` | 2 | 2 | 99 | 3 | 28 |
| `fileWatcher` | 2 | 1 | 137 | 21 | 27 |
| `media-preview` | 1 | 1 | 85 | 0 | 26 |
| `project-catalog` | 5 | 3 | 81 | 6 | 22 |
| `prompt-attachment-transfer` | 2 | 2 | 79 | 5 | 20 |
| `source-server-management` | 1 | 1 | 67 | 2 | 19 |
| `official-mcp` | 2 | 2 | 363 | 90 | 19 |
| `startup-storage` | 4 | 3 | 64 | 6 | 17 |
| `window-controller` | 1 | 1 | 71 | 6 | 16 |
| `logger` | 1 | 1 | 57 | 3 | 15 |
| `window-project-directory` | 4 | 3 | 50 | 6 | 12 |
| `remote-sync` | 1 | 1 | 33 | 0 | 10 |
| `client-scenes` | 2 | 2 | 60 | 12 | 7 |
| `types` | 1 | 1 | 15 | 0 | 5 |
| `conversation-telemetry` | 1 | 0 | 18 | 6 | 0 |

## 3. 按缺口排序的文件清单

| # | 缺口 | 代码行 | 注释行 | 当前密度 | 文件 |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 2464 | 9336 | 337 | 3.61% | `bots/botsService.ts` |
| 2 | 1285 | 6010 | 518 | 8.62% | `zcode-agent/zcodeAgentService.ts` |
| 3 | 1251 | 5242 | 322 | 6.14% | `zcode-agent/zcodeTaskServiceAdapter.ts` |
| 4 | 728 | 2729 | 91 | 3.33% | `bots/providers/feishuProvider.ts` |
| 5 | 652 | 2214 | 13 | 0.59% | `settings-sync/settingsSyncService.ts` |
| 6 | 589 | 2199 | 71 | 3.23% | `session/sourceServerWorkspaceAliasRepo.ts` |
| 7 | 532 | 2324 | 166 | 7.14% | `conversation-share/conversationShareService.ts` |
| 8 | 520 | 2855 | 337 | 11.80% | `node.ts` |
| 9 | 403 | 1498 | 47 | 3.14% | `git/repo/gitCliRepo.ts` |
| 10 | 371 | 1504 | 81 | 5.39% | `usage-stats/providers/bigmodelUsageQuotaProvider.ts` |
| 11 | 342 | 1383 | 73 | 5.28% | `coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` |
| 12 | 315 | 1078 | 9 | 0.83% | `plugin-sync/pluginSyncService.ts` |
| 13 | 302 | 1274 | 81 | 6.36% | `session/taskIndexRepo.ts` |
| 14 | 296 | 1681 | 209 | 12.43% | `zcode-agent/zcodeTaskIndexSyncer.ts` |
| 15 | 282 | 1319 | 114 | 8.64% | `session/automationRepo.ts` |
| 16 | 280 | 999 | 20 | 2.00% | `feedback/feedbackHttpClient.ts` |
| 17 | 253 | 1071 | 69 | 6.44% | `oauth/oauthService.ts` |
| 18 | 250 | 1088 | 77 | 7.08% | `skills/skillsService.ts` |
| 19 | 242 | 907 | 31 | 3.42% | `model-provider/legacyZCodeConfigProviderReader.ts` |
| 20 | 232 | 875 | 31 | 3.54% | `commands/commandsService.ts` |
| 21 | 231 | 823 | 16 | 1.94% | `usage-stats/providers/bigmodelUsageMonitorMapper.ts` |
| 22 | 227 | 811 | 17 | 2.10% | `subagents/subagentsService.ts` |
| 23 | 227 | 1271 | 155 | 12.20% | `zcode-agent/zcodeAgentProcessManager.ts` |
| 24 | 214 | 974 | 79 | 8.11% | `zcode-agent/zcodeAgentConnectionScope.ts` |
| 25 | 213 | 761 | 16 | 2.10% | `conversation-share/conversationSharePublicProjection.ts` |
| 26 | 194 | 810 | 49 | 6.05% | `session/offPeakMockGateway.ts` |
| 27 | 189 | 687 | 18 | 2.62% | `conversation-share/conversationShareArtifactDiscovery.ts` |
| 28 | 177 | 622 | 10 | 1.61% | `bots/providers/weixinProvider.ts` |
| 29 | 177 | 741 | 46 | 6.21% | `model-provider/legacyModelProviderSerialized.ts` |
| 30 | 174 | 730 | 45 | 6.16% | `mcp-sync/mcpSyncService.ts` |
| 31 | 173 | 621 | 14 | 2.25% | `git/repo/gitCliHelpers.ts` |
| 32 | 170 | 604 | 12 | 1.99% | `system/sshConfigAlias.ts` |
| 33 | 146 | 517 | 10 | 1.93% | `bots/providers/telegramProvider.ts` |
| 34 | 143 | 519 | 13 | 2.50% | `cua-permission-broker/windowsCuaDevRuntime.ts` |
| 35 | 140 | 589 | 37 | 6.28% | `telemetry/telemetryCore.ts` |
| 36 | 133 | 472 | 9 | 1.91% | `skill-sync/skillSyncService.ts` |
| 37 | 132 | 581 | 43 | 7.40% | `file/fileService.ts` |
| 38 | 128 | 524 | 30 | 5.73% | `conversation-share/conversationShareHttpClient.ts` |
| 39 | 126 | 675 | 77 | 11.41% | `session/offPeakTaskService.ts` |
| 40 | 124 | 494 | 25 | 5.06% | `model-provider/codingPlanProviderAvailability.ts` |
| 41 | 119 | 425 | 9 | 2.12% | `conversation-share/conversationShareWorkflowSnapshot.ts` |
| 42 | 114 | 397 | 6 | 1.51% | `project-storage/project-repository.ts` |
| 43 | 113 | 702 | 98 | 13.96% | `session/offPeakTaskRepo.ts` |
| 44 | 109 | 382 | 6 | 1.57% | `bots/replyFormatter.ts` |
| 45 | 109 | 486 | 37 | 7.61% | `session/claude-native/claudeNativeSessionImportParser.ts` |
| 46 | 107 | 369 | 4 | 1.08% | `terminal/terminalProfile.ts` |
| 47 | 104 | 381 | 11 | 2.89% | `subagents/subagentMarkdown.ts` |
| 48 | 104 | 344 | 0 | 0.00% | `system/systemService.ts` |
| 49 | 101 | 444 | 33 | 7.43% | `cua-permission-broker/windowsCuaDevHelperHost.ts` |
| 50 | 101 | 381 | 14 | 3.67% | `providers/api/nodeApiClient.ts` |
| 51 | 100 | 392 | 18 | 4.59% | `bots/telegramChannelRuntime.ts` |
| 52 | 99 | 366 | 11 | 3.01% | `remote-projects/index.ts` |
| 53 | 99 | 331 | 1 | 0.30% | `terminal/terminalProfileMacOs.ts` |
| 54 | 96 | 381 | 19 | 4.99% | `oauth/repo/oauthCredentialRepo.ts` |
| 55 | 96 | 395 | 23 | 5.82% | `zcode-agent/modelTrajectory.ts` |
| 56 | 94 | 329 | 5 | 1.52% | `task-groups/repository.ts` |
| 57 | 93 | 312 | 1 | 0.32% | `cloud-content/contentBundleCache.ts` |
| 58 | 93 | 322 | 4 | 1.24% | `git/gitCommitMessageGenerator.ts` |
| 59 | 93 | 358 | 15 | 4.19% | `model-provider/providerProvisioningTarget.ts` |
| 60 | 93 | 414 | 32 | 7.73% | `process/processTreeTerminator.ts` |
| 61 | 92 | 307 | 1 | 0.33% | `skill-sync/skillSyncArchive.ts` |
| 62 | 91 | 809 | 152 | 18.79% | `zcode-agent/zcodeAgent.ts` |
| 63 | 88 | 328 | 11 | 3.35% | `subagents/subagentConfigScope.ts` |
| 64 | 87 | 324 | 11 | 3.40% | `bots/feishuChannelRuntime.ts` |
| 65 | 87 | 293 | 1 | 0.34% | `fs/fsFaultInjection.ts` |
| 66 | 86 | 289 | 1 | 0.35% | `plugin-sync/pluginSyncArchive.ts` |
| 67 | 84 | 397 | 36 | 9.07% | `process/processResourceSampler.ts` |
| 68 | 83 | 280 | 1 | 0.36% | `bots/messages.ts` |
| 69 | 83 | 421 | 44 | 10.45% | `conversation-share/conversationShare.ts` |
| 70 | 83 | 306 | 9 | 2.94% | `git/gitService.ts` |
| 71 | 82 | 328 | 17 | 5.18% | `memory/memoryService.ts` |
| 72 | 82 | 398 | 38 | 9.55% | `setting/settingService.ts` |
| 73 | 81 | 276 | 2 | 0.72% | `bots/providers/webhookProvider.ts` |
| 74 | 81 | 317 | 15 | 4.73% | `bots/weixinChannelRuntime.ts` |
| 75 | 81 | 268 | 0 | 0.00% | `hooks/workspaceHookSettingsModel.ts` |
| 76 | 81 | 294 | 8 | 2.72% | `session/controllerRemoteIdentityMigration.ts` |
| 77 | 80 | 354 | 27 | 7.63% | `oauth/providers/zaiProviderAdapter.ts` |
| 78 | 80 | 291 | 8 | 2.75% | `session/tasksDatabase/migrations.ts` |
| 79 | 79 | 298 | 11 | 3.69% | `feedback/feedbackLogArchive.ts` |
| 80 | 78 | 386 | 38 | 9.84% | `plugin-ui-bridge/pluginUiBridgeService.ts` |
| 81 | 77 | 392 | 41 | 10.46% | `terminal/terminalService.ts` |
| 82 | 74 | 297 | 16 | 5.39% | `conversation-share/conversationShareArtifactSource.ts` |
| 83 | 73 | 306 | 19 | 6.21% | `process/processTreeSnapshot.ts` |
| 84 | 73 | 305 | 19 | 6.23% | `project/index.ts` |
| 85 | 72 | 257 | 6 | 2.33% | `feedback/feedbackService.ts` |
| 86 | 71 | 258 | 7 | 2.71% | `session/claude-native/claudeNativeSessionImportRepo.ts` |
| 87 | 70 | 252 | 6 | 2.38% | `model-provider/providerFacadeServices.ts` |
| 88 | 69 | 356 | 38 | 10.67% | `zcode-agent/zcodeProtocolClient.ts` |
| 89 | 68 | 273 | 14 | 5.13% | `highspeed/highspeedHttpTransport.ts` |
| 90 | 68 | 408 | 55 | 13.48% | `zcode-session/zcodeSessionService.ts` |
| 91 | 67 | 257 | 11 | 4.28% | `bots/channelRuntime.ts` |
| 92 | 65 | 287 | 22 | 7.67% | `zcode-agent/cuaOperationTurnTracker.ts` |
| 93 | 62 | 326 | 36 | 11.04% | `index.ts` |
| 94 | 62 | 231 | 8 | 3.46% | `session/offPeakResidentExecutions.ts` |
| 95 | 61 | 295 | 28 | 9.49% | `hooks/hooksService.ts` |
| 96 | 59 | 215 | 6 | 2.79% | `bots/channelReply.ts` |
| 97 | 58 | 219 | 8 | 3.65% | `subagents/subagentRuntimeConfig.ts` |
| 98 | 57 | 226 | 11 | 4.87% | `providers/api/nodeApiNetwork.ts` |
| 99 | 57 | 194 | 2 | 1.03% | `providers/codexConfigToml.ts` |
| 100 | 57 | 234 | 14 | 5.98% | `runtime-tools/runtimeCommandEnv.ts` |
| 101 | 57 | 217 | 9 | 4.15% | `runtime-tools/runtimeLoginShellEnvCapture.ts` |
| 102 | 57 | 190 | 0 | 0.00% | `session/claude-native/claudeNativeSessionHeadParser.ts` |
| 103 | 57 | 200 | 3 | 1.50% | `session/tasksDatabase/source-server-schema-v5.ts` |
| 104 | 56 | 206 | 6 | 2.91% | `git/providers/gitCommandProvider.ts` |
| 105 | 56 | 184 | 0 | 0.00% | `git/repo/gitCheckpointHelpers.ts` |
| 106 | 56 | 343 | 47 | 13.70% | `session/automationService.ts` |
| 107 | 54 | 203 | 7 | 3.45% | `bots/bots.ts` |
| 108 | 53 | 304 | 39 | 12.83% | `model-provider/accountProviderConnectionResolver.ts` |
| 109 | 52 | 201 | 9 | 4.48% | `project-storage/migrate-projects.ts` |
| 110 | 51 | 329 | 48 | 14.59% | `zcode-agent/zcodeStdioTransport.ts` |
| 111 | 50 | 168 | 1 | 0.60% | `bot-project-runtime/index.ts` |
| 112 | 50 | 176 | 3 | 1.70% | `bots/providers/feishuAppRegistration.ts` |
| 113 | 50 | 200 | 10 | 5.00% | `model-provider/providerRuntime.ts` |
| 114 | 50 | 190 | 7 | 3.68% | `session/continuousStreamCoalescer.ts` |
| 115 | 50 | 169 | 1 | 0.59% | `session/tasksDatabase/schema-v1.ts` |
| 116 | 49 | 171 | 3 | 1.75% | `bigmodel/teamPlanApiKey.ts` |
| 117 | 49 | 167 | 2 | 1.20% | `bots/providers/weixinRegistration.ts` |
| 118 | 49 | 173 | 3 | 1.73% | `gen-ui/adapters/stateStorage.ts` |
| 119 | 49 | 166 | 1 | 0.60% | `task-facts/index.ts` |
| 120 | 48 | 230 | 21 | 9.13% | `broadcast/broadcastService.ts` |
| 121 | 48 | 216 | 17 | 7.87% | `onboarding/onboardingRecordService.ts` |
| 122 | 48 | 240 | 24 | 10.00% | `session/offPeakServerClient.ts` |
| 123 | 47 | 248 | 28 | 11.29% | `oauth/providers/bigmodelProviderAdapter.ts` |
| 124 | 47 | 181 | 8 | 4.42% | `process/windowsProcessListAsync.ts` |
| 125 | 47 | 174 | 6 | 3.45% | `zcode-agent/zcodeSessionEventCoalescer.ts` |
| 126 | 46 | 190 | 11 | 5.79% | `session/claude-native/importedClaudeHistoryRepair.ts` |
| 127 | 46 | 295 | 43 | 14.58% | `session/offPeakRuntimeModel.ts` |
| 128 | 46 | 218 | 20 | 9.17% | `source-server-workspace/sourceServerWorkspaceIdentityChannelServer.ts` |
| 129 | 46 | 199 | 14 | 7.04% | `zcode-agent/zcodeAgentPluginParams.ts` |
| 130 | 45 | 154 | 2 | 1.30% | `bots/topicResource.ts` |
| 131 | 45 | 147 | 0 | 0.00% | `cloud-content/cloudContentService.ts` |
| 132 | 44 | 167 | 7 | 4.19% | `model-provider/zaiStartPlanBilling.ts` |
| 133 | 44 | 165 | 6 | 3.64% | `process/processTreeOwnership.ts` |
| 134 | 44 | 153 | 2 | 1.31% | `session/claude-native/claudeNativeSessionImportService.ts` |
| 135 | 44 | 145 | 0 | 0.00% | `usage-stats/providers/bigmodelUsageMonitorRange.ts` |
| 136 | 44 | 152 | 2 | 1.32% | `usage-stats/providers/bigmodelUsageQuotaMapper.ts` |
| 137 | 42 | 158 | 6 | 3.80% | `bots/statusFormatting.ts` |
| 138 | 42 | 140 | 0 | 0.00% | `commands/commandFileParser.ts` |
| 139 | 42 | 201 | 19 | 9.45% | `cua-permission-broker/windowsCuaHelperHostSupport.ts` |
| 140 | 42 | 147 | 3 | 2.04% | `model-provider/accountProviderRequestAuthService.ts` |
| 141 | 42 | 148 | 3 | 2.03% | `process/processTreeSnapshotAsync.ts` |
| 142 | 42 | 212 | 22 | 10.38% | `process/processTreeWaiter.ts` |
| 143 | 41 | 157 | 7 | 4.46% | `project/legacy-single-root.ts` |
| 144 | 41 | 136 | 0 | 0.00% | `runtime-tools/runtimeToolResolver.ts` |
| 145 | 40 | 131 | 0 | 0.00% | `task-groups/index.ts` |
| 146 | 39 | 157 | 9 | 5.73% | `model-provider/providerProvisioningSource.ts` |
| 147 | 39 | 207 | 24 | 11.59% | `output-style/outputStyleService.ts` |
| 148 | 39 | 134 | 2 | 1.49% | `zcode-agent/topicResourceRelay.ts` |
| 149 | 38 | 134 | 3 | 2.24% | `conversation-share/conversationShareConnectionScope.ts` |
| 150 | 38 | 202 | 23 | 11.39% | `plugins/pluginManagementService.ts` |
| 151 | 37 | 122 | 0 | 0.00% | `bots/providers/types.ts` |
| 152 | 36 | 125 | 2 | 1.60% | `project-workspace-navigation/index.ts` |
| 153 | 36 | 184 | 20 | 10.87% | `storage/domain/storageCatalog.ts` |
| 154 | 36 | 145 | 8 | 5.52% | `zcode-session/zcodeSession.ts` |
| 155 | 35 | 114 | 0 | 0.00% | `bots/commandParser.ts` |
| 156 | 35 | 117 | 1 | 0.85% | `marketing-touch/marketingAssetRegistry.ts` |
| 157 | 35 | 568 | 136 | 23.94% | `session/zcodeTaskService.ts` |
| 158 | 34 | 140 | 8 | 5.71% | `bots/providers/feishuGroupMessages.ts` |
| 159 | 34 | 123 | 3 | 2.44% | `conversation-share/conversationShareInlineImages.ts` |
| 160 | 34 | 133 | 6 | 4.51% | `project-storage/legacy-tasks.ts` |
| 161 | 33 | 109 | 0 | 0.00% | `bots/workspaceHelpers.ts` |
| 162 | 33 | 110 | 0 | 0.00% | `git/repo/gitCliTypes.ts` |
| 163 | 33 | 108 | 0 | 0.00% | `system/integratedTerminalShells.ts` |
| 164 | 33 | 153 | 13 | 8.50% | `usage-stats/usageStatsService.ts` |
| 165 | 32 | 121 | 5 | 4.13% | `bigmodel/codingPlanEntitlement.ts` |
| 166 | 32 | 114 | 3 | 2.63% | `bots/botConfigHelpers.ts` |
| 167 | 32 | 114 | 3 | 2.63% | `conversation-share/sharedContextFormatter.ts` |
| 168 | 32 | 115 | 3 | 2.61% | `remote-projects/workspace-settings.ts` |
| 169 | 32 | 119 | 4 | 3.36% | `zcode-agent/groupRuntimeSnapshot.ts` |
| 170 | 32 | 122 | 5 | 4.10% | `zcode-agent/zcodeAgentBrowserAmbientContext.ts` |
| 171 | 31 | 157 | 17 | 10.83% | `fs/atomicFileUtils.ts` |
| 172 | 31 | 102 | 0 | 0.00% | `git/gitCheckpointService.ts` |
| 173 | 31 | 203 | 30 | 14.78% | `paths.ts` |
| 174 | 31 | 103 | 0 | 0.00% | `providers/zaiBusinessTokenResolver.ts` |
| 175 | 30 | 122 | 7 | 5.74% | `oauth/oauthProfileSchema.ts` |
| 176 | 30 | 118 | 6 | 5.08% | `session/taskChangeSummary.ts` |
| 177 | 30 | 118 | 6 | 5.08% | `zcode-session/zcodeSessionApiRetry.ts` |
| 178 | 29 | 120 | 7 | 5.83% | `coding-plan-subscription/codingPlanSubscription.ts` |
| 179 | 29 | 120 | 7 | 5.83% | `oauth/oauthUnauthorizedRequest.ts` |
| 180 | 28 | 100 | 2 | 2.00% | `feedback/feedbackLocalTicketStore.ts` |
| 181 | 28 | 118 | 8 | 6.78% | `project-storage/startup.ts` |
| 182 | 28 | 97 | 2 | 2.06% | `remote-projects/connection-membership.ts` |
| 183 | 28 | 103 | 3 | 2.91% | `zcode-agent/zcodeStorageStartupGate.ts` |
| 184 | 27 | 124 | 11 | 8.87% | `fileWatcher/fileWatcherService.ts` |
| 185 | 27 | 123 | 10 | 8.13% | `storage/adapters/fsWalker.ts` |
| 186 | 26 | 102 | 5 | 4.90% | `bots/topicContinuation.ts` |
| 187 | 26 | 84 | 0 | 0.00% | `git/commitMessageFileScope.ts` |
| 188 | 26 | 110 | 7 | 6.36% | `git/config.ts` |
| 189 | 26 | 86 | 0 | 0.00% | `git/repo/gitCheckpointStore.ts` |
| 190 | 26 | 85 | 0 | 0.00% | `media-preview/mediaPreview.ts` |
| 191 | 26 | 88 | 1 | 1.14% | `model-provider/accountProviderApiKeyResolver.ts` |
| 192 | 26 | 108 | 7 | 6.48% | `storage/adapters/fsCleaner.ts` |
| 193 | 26 | 100 | 4 | 4.00% | `storage/app/scanJob.ts` |
| 194 | 25 | 94 | 4 | 4.26% | `bots/channelMentionResolver.ts` |
| 195 | 25 | 87 | 2 | 2.30% | `client-config/clientConfigService.ts` |
| 196 | 25 | 123 | 12 | 9.76% | `model-provider/legacyPersonalProviderConfigImporter.ts` |
| 197 | 25 | 81 | 0 | 0.00% | `project-storage/schema.ts` |
| 198 | 25 | 81 | 0 | 0.00% | `providers/api/apiJson.ts` |
| 199 | 25 | 94 | 4 | 4.26% | `storage/domain/usageAggregate.ts` |
| 200 | 24 | 90 | 3 | 3.33% | `bots/repo.ts` |
| 201 | 24 | 93 | 4 | 4.30% | `credential/providers/credentialCipherProvider.ts` |
| 202 | 24 | 82 | 1 | 1.22% | `model-provider/accountProviderTeamPlanRequestKey.ts` |
| 203 | 24 | 84 | 2 | 2.38% | `zcode-agent/topicResourceRelayClient.ts` |
| 204 | 24 | 83 | 1 | 1.20% | `zcode-agent/topicResourceUpload.ts` |
| 205 | 23 | 85 | 3 | 3.53% | `memory/projectMemoryStableRead.ts` |
| 206 | 23 | 78 | 1 | 1.28% | `providers/sourceHeaders.ts` |
| 207 | 23 | 84 | 3 | 3.57% | `session/sessionModeOptions.ts` |
| 208 | 23 | 77 | 1 | 1.30% | `zcode-agent/topicResourceRelayChannel.ts` |
| 209 | 22 | 86 | 4 | 4.65% | `bots/groupResultDelivery.ts` |
| 210 | 22 | 115 | 13 | 11.30% | `file/workspaceFileMentionFilter.ts` |
| 211 | 22 | 71 | 0 | 0.00% | `gen-ui/adapters/service.ts` |
| 212 | 22 | 93 | 6 | 6.45% | `setting/legacyAccountConnectionSettings.ts` |
| 213 | 21 | 81 | 4 | 4.94% | `bots/config.ts` |
| 214 | 21 | 81 | 4 | 4.94% | `bots/storageMigration.ts` |
| 215 | 21 | 76 | 2 | 2.63% | `marketing-touch/marketingTouchService.ts` |
| 216 | 21 | 70 | 0 | 0.00% | `project-storage/index.ts` |
| 217 | 21 | 77 | 3 | 3.90% | `session/automationCronValidation.ts` |
| 218 | 21 | 79 | 3 | 3.80% | `zcode-agent/groupAttachmentUpload.ts` |
| 219 | 20 | 110 | 13 | 11.82% | `accessor.ts` |
| 220 | 20 | 70 | 1 | 1.43% | `bots/topicHistoryAttachment.ts` |
| 221 | 20 | 72 | 2 | 2.78% | `bots/topicPreparationState.ts` |
| 222 | 20 | 133 | 20 | 15.04% | `credential/credentialService.ts` |
| 223 | 20 | 370 | 91 | 24.59% | `git/repo/gitCheckpointRepo.ts` |
| 224 | 20 | 65 | 0 | 0.00% | `source-server-workspace/sourceServerWorkspaceService.ts` |
| 225 | 19 | 63 | 0 | 0.00% | `feedback/feedback.ts` |
| 226 | 19 | 62 | 0 | 0.00% | `highspeed/highspeedMockTransport.ts` |
| 227 | 19 | 68 | 2 | 2.94% | `model-provider/accountProviderCredentialService.ts` |
| 228 | 19 | 75 | 4 | 5.33% | `model-provider/providerConfigRuntime.ts` |
| 229 | 19 | 76 | 4 | 5.26% | `process/runtimeProcessLifecycle.ts` |
| 230 | 19 | 76 | 4 | 5.26% | `providers/api/networkErrorClassifier.ts` |
| 231 | 19 | 67 | 2 | 2.99% | `source-server-management/sourceServerManagement.ts` |
| 232 | 19 | 90 | 8 | 8.89% | `storage/app/storageService.ts` |
| 233 | 18 | 83 | 7 | 8.43% | `bots/topicHistory.ts` |
| 234 | 18 | 81 | 7 | 8.64% | `cua-permission-broker/cuaAgentAdmissionGate.ts` |
| 235 | 18 | 292 | 70 | 23.97% | `highspeed/highspeedCardService.ts` |
| 236 | 18 | 59 | 0 | 0.00% | `plugins/installedPluginRoots.ts` |
| 237 | 18 | 197 | 42 | 21.32% | `runtime-tools/providerRuntimeResolver.ts` |
| 238 | 18 | 58 | 0 | 0.00% | `usage-stats/providers/bigmodelSubscriptionProvider.ts` |
| 239 | 18 | 72 | 4 | 5.56% | `zcode-agent/topicResourceBridge.ts` |
| 240 | 18 | 67 | 3 | 4.48% | `zcode-agent/topicResourcePeers.ts` |
| 241 | 17 | 225 | 51 | 22.67% | `cua-permission-broker/cuaPipSessionService.ts` |
| 242 | 17 | 66 | 3 | 4.55% | `gen-ui/adapters/files.ts` |
| 243 | 17 | 263 | 62 | 23.57% | `session/automationCron.ts` |
| 244 | 17 | 55 | 0 | 0.00% | `subagents/subagentStorage.ts` |
| 245 | 17 | 59 | 1 | 1.69% | `zcode-agent/zcodeStdioTapDevConfig.ts` |
| 246 | 16 | 53 | 0 | 0.00% | `git/git.ts` |
| 247 | 16 | 103 | 15 | 14.56% | `plugins/pluginManagement.ts` |
| 248 | 16 | 52 | 0 | 0.00% | `plugins/plugins.ts` |
| 249 | 16 | 95 | 13 | 13.68% | `project-storage/contract.ts` |
| 250 | 16 | 61 | 3 | 4.92% | `session/claude-native/buildImportedClaudeTaskFile.ts` |
| 251 | 16 | 85 | 10 | 11.76% | `session/tasksDatabase/provider-selection-v2.ts` |
| 252 | 16 | 60 | 2 | 3.33% | `task-facts/contract.ts` |
| 253 | 16 | 71 | 6 | 8.45% | `window-controller/windowController.ts` |
| 254 | 15 | 54 | 2 | 3.70% | `git/providers/gitEnvironmentProvider.ts` |
| 255 | 15 | 57 | 3 | 5.26% | `logger/serviceLogger.ts` |
| 256 | 15 | 54 | 2 | 3.70% | `model-provider/accountProjectTokenClient.ts` |
| 257 | 15 | 53 | 1 | 1.89% | `project-catalog/index.ts` |
| 258 | 15 | 48 | 0 | 0.00% | `session/claude-native/sessionHistoryJsonl.ts` |
| 259 | 15 | 58 | 3 | 5.17% | `zcode-agent/localRuntimeNetworkCapture.ts` |
| 260 | 14 | 47 | 1 | 2.13% | `bots/groupQueueCard.ts` |
| 261 | 14 | 49 | 1 | 2.04% | `bots/taskStreamHub.ts` |
| 262 | 14 | 123 | 23 | 18.70% | `conversation-share/conversationShareIntegrity.ts` |
| 263 | 14 | 45 | 0 | 0.00% | `cua-permission-broker/stableCuaTransport.ts` |
| 264 | 14 | 45 | 0 | 0.00% | `oauth/oauthProviderLogout.ts` |
| 265 | 14 | 343 | 89 | 25.95% | `official-mcp/officialMcpCredentials.ts` |
| 266 | 14 | 46 | 0 | 0.00% | `remote-projects/validation.ts` |
| 267 | 14 | 45 | 0 | 0.00% | `session/claude-native/importedClaudeTaskFileFilter.ts` |
| 268 | 14 | 44 | 0 | 0.00% | `session/sessionRealtimePort.ts` |
| 269 | 13 | 44 | 1 | 2.27% | `bots/providers/groupMemberDirectory.ts` |
| 270 | 13 | 67 | 8 | 11.94% | `bots/providers/providerRequest.ts` |
| 271 | 13 | 42 | 0 | 0.00% | `plugin-sync/pluginSync.ts` |
| 272 | 13 | 46 | 1 | 2.17% | `plugin-ui-bridge/pluginUiAppToolsService.ts` |
| 273 | 13 | 49 | 2 | 4.08% | `runtime-tools/node-forge.d.ts` |
| 274 | 13 | 50 | 2 | 4.00% | `setting/settingsWriteQueue.ts` |
| 275 | 13 | 47 | 2 | 4.26% | `task-groups/contract.ts` |
| 276 | 12 | 47 | 3 | 6.38% | `bots/groupAdminAttention.ts` |
| 277 | 12 | 42 | 1 | 2.38% | `bots/providers/groupInputReaction.ts` |
| 278 | 12 | 39 | 0 | 0.00% | `cua-permission-broker/cuaStandaloneStatusLaunch.ts` |
| 279 | 12 | 48 | 3 | 6.25% | `oauth/providers/zaiProviderConfig.ts` |
| 280 | 12 | 40 | 0 | 0.00% | `plugin-sync/pluginSyncPath.ts` |
| 281 | 12 | 41 | 1 | 2.44% | `prompt-attachment-transfer/promptAttachmentTransferService.ts` |
| 282 | 12 | 50 | 3 | 6.00% | `session/claude-native/persistImportedClaudeTask.ts` |
| 283 | 12 | 39 | 0 | 0.00% | `settings-sync/settingsSync.ts` |
| 284 | 12 | 40 | 0 | 0.00% | `skill-sync/skillSyncPath.ts` |
| 285 | 12 | 37 | 0 | 0.00% | `startup-storage/index.ts` |
| 286 | 12 | 66 | 8 | 12.12% | `storage/domain/cleanPlan.ts` |
| 287 | 12 | 37 | 0 | 0.00% | `usage-stats/usageStats.ts` |
| 288 | 12 | 48 | 3 | 6.25% | `zcode-agent/modelTrajectoryFileTail.ts` |
| 289 | 11 | 46 | 3 | 6.52% | `model-provider/legacyTeamOrganizationResolver.ts` |
| 290 | 11 | 44 | 3 | 6.82% | `oauth/providers/bigmodelProviderConfig.ts` |
| 291 | 11 | 234 | 60 | 25.64% | `usage-stats/providers/zcodeMcpQuotaProvider.ts` |
| 292 | 11 | 51 | 5 | 9.80% | `zcode-agent/zcodeConfigOptions.ts` |
| 293 | 11 | 34 | 0 | 0.00% | `zcode-session/importedClaudeSessionRepair.ts` |
| 294 | 10 | 44 | 4 | 9.09% | `cua-permission-broker/cuaHelperInstaller.ts` |
| 295 | 10 | 37 | 2 | 5.41% | `file/workspaceFileSearch.ts` |
| 296 | 10 | 42 | 3 | 7.14% | `plugin-ui-bridge/contract.example.ts` |
| 297 | 10 | 38 | 2 | 5.26% | `plugin-ui-bridge/instanceAccounts.ts` |
| 298 | 10 | 37 | 2 | 5.41% | `project-storage/migration-order/migration.ts` |
| 299 | 10 | 31 | 0 | 0.00% | `providers/api/requestIdHeaders.ts` |
| 300 | 10 | 33 | 0 | 0.00% | `remote-sync/remoteSyncWriteAccess.ts` |
| 301 | 10 | 45 | 4 | 8.89% | `session/mcpWorkspaceScope.ts` |
| 302 | 10 | 82 | 15 | 18.29% | `skills/skillDiscoveryWalk.ts` |
| 303 | 10 | 47 | 5 | 10.64% | `storage/adapters/inProcessScanRunner.ts` |
| 304 | 10 | 39 | 2 | 5.13% | `zcode-agent/agentStderrCollector.ts` |
| 305 | 10 | 32 | 0 | 0.00% | `zcode-session/zcodeSessionDraftRegistry.ts` |
| 306 | 9 | 34 | 2 | 5.88% | `bot-project-runtime/contract.ts` |
| 307 | 9 | 30 | 0 | 0.00% | `feedback/compactLogArchive.ts` |
| 308 | 9 | 30 | 0 | 0.00% | `model-provider/accountProviderApiTypes.ts` |
| 309 | 9 | 54 | 8 | 14.81% | `process/processTreeTypes.ts` |
| 310 | 9 | 60 | 9 | 15.00% | `runtime-tools/appCaCert.ts` |
| 311 | 9 | 28 | 0 | 0.00% | `runtime-tools/clientPlatform.ts` |
| 312 | 9 | 28 | 0 | 0.00% | `session/zcodeTaskListTypes.ts` |
| 313 | 9 | 28 | 0 | 0.00% | `settings-sync/types.ts` |
| 314 | 9 | 28 | 0 | 0.00% | `skill-sync/skillSync.ts` |
| 315 | 9 | 30 | 0 | 0.00% | `terminal/terminalProfileTypes.ts` |
| 316 | 9 | 34 | 2 | 5.88% | `zcode-agent/agentTelemetryEnv.ts` |
| 317 | 9 | 36 | 2 | 5.56% | `zcode-agent/independentPlanSupport.ts` |
| 318 | 8 | 31 | 2 | 6.45% | `bots/groupSessions.ts` |
| 319 | 8 | 26 | 0 | 0.00% | `commands/commands.ts` |
| 320 | 8 | 31 | 2 | 6.45% | `oauth/providers/index.ts` |
| 321 | 8 | 38 | 4 | 10.53% | `prompt-attachment-transfer/promptAttachmentTransfer.ts` |
| 322 | 8 | 61 | 11 | 18.03% | `remote-projects/contract.ts` |
| 323 | 8 | 33 | 2 | 6.06% | `session/tasksDatabase/official-glm-selection-v3.ts` |
| 324 | 8 | 31 | 2 | 6.45% | `symlinkPointsToTarget.ts` |
| 325 | 8 | 34 | 3 | 8.82% | `task-facts/repairSubagentTaskIndex.ts` |
| 326 | 8 | 25 | 0 | 0.00% | `terminal/terminal.ts` |
| 327 | 7 | 25 | 1 | 4.00% | `gen-ui/contract.ts` |
| 328 | 7 | 40 | 5 | 12.50% | `mcp-sync/mcpSync.ts` |
| 329 | 7 | 25 | 1 | 4.00% | `model-provider/accountProviderApiClient.ts` |
| 330 | 7 | 40 | 5 | 12.50% | `model-provider/accountProviderCredentialStore.ts` |
| 331 | 7 | 36 | 4 | 11.11% | `model-provider/providerSettingsConnectivity.ts` |
| 332 | 7 | 32 | 3 | 9.38% | `project-workspace-navigation/contract.ts` |
| 333 | 7 | 75 | 16 | 21.33% | `setting/normalizeSettingsPatch.ts` |
| 334 | 7 | 21 | 0 | 0.00% | `source-server-workspace/sourceServerWorkspace.ts` |
| 335 | 7 | 39 | 5 | 12.82% | `storage/app/ports.ts` |
| 336 | 7 | 26 | 1 | 3.85% | `zcode-agent/pluginReferenceCatalogRequest.ts` |
| 337 | 6 | 20 | 0 | 0.00% | `git/gitCheckpoint.ts` |
| 338 | 6 | 17 | 0 | 0.00% | `highspeed/highspeedCard.ts` |
| 339 | 6 | 17 | 0 | 0.00% | `oauth/callbackAttribution.ts` |
| 340 | 6 | 30 | 3 | 10.00% | `oauth/providers/configUtils.ts` |
| 341 | 6 | 20 | 0 | 0.00% | `plugin-ui-bridge/pluginUiSamplingService.ts` |
| 342 | 6 | 26 | 2 | 7.69% | `project-storage/remote-policy.ts` |
| 343 | 6 | 50 | 9 | 18.00% | `project/contract.ts` |
| 344 | 6 | 40 | 6 | 15.00% | `skills/skills.ts` |
| 345 | 6 | 32 | 4 | 12.50% | `storage/adapters/rootsResolver.ts` |
| 346 | 6 | 34 | 5 | 14.71% | `storage/adapters/volumeProbe.ts` |
| 347 | 6 | 23 | 1 | 4.35% | `window-project-directory/contract.ts` |
| 348 | 6 | 29 | 3 | 10.34% | `zcode-agent/botTopicAdmission.ts` |
| 349 | 6 | 126 | 32 | 25.40% | `zcode-agent/zcodeV4HostCommand.ts` |
| 350 | 5 | 15 | 0 | 0.00% | `bots/commandOrder.ts` |
| 351 | 5 | 14 | 0 | 0.00% | `client-scenes/clientScenesService.ts` |
| 352 | 5 | 36 | 6 | 16.67% | `collection.ts` |
| 353 | 5 | 15 | 0 | 0.00% | `gen-ui/app/ports.ts` |
| 354 | 5 | 14 | 0 | 0.00% | `marketing-touch/marketingTouch.ts` |
| 355 | 5 | 34 | 6 | 17.65% | `model-provider/accountProviderCredentialKey.ts` |
| 356 | 5 | 17 | 1 | 5.88% | `model-provider/offPeakModelSelectionView.ts` |
| 357 | 5 | 20 | 1 | 5.00% | `model-provider/zcodeBuiltinRemoteConfig.ts` |
| 358 | 5 | 30 | 4 | 13.33% | `oauth/providers/providerAdapter.ts` |
| 359 | 5 | 20 | 1 | 5.00% | `official-mcp/officialMcpIssuanceAudit.ts` |
| 360 | 5 | 18 | 1 | 5.56% | `plugin-ui-bridge/samplingContract.ts` |
| 361 | 5 | 76 | 18 | 23.68% | `plugins/pluginsService.ts` |
| 362 | 5 | 14 | 0 | 0.00% | `project-catalog/contract.ts` |
| 363 | 5 | 25 | 3 | 12.00% | `project-storage/default-workspace/migration.ts` |
| 364 | 5 | 81 | 20 | 24.69% | `project/autoArchiveScheduler.ts` |
| 365 | 5 | 56 | 12 | 21.43% | `session/automationIntervalCarrier.ts` |
| 366 | 5 | 27 | 4 | 14.81% | `session/offPeakWorkspaceIdentityMigration.ts` |
| 367 | 5 | 15 | 0 | 0.00% | `session/sessionMailbox.ts` |
| 368 | 5 | 15 | 0 | 0.00% | `session/sessionTitle.ts` |
| 369 | 5 | 17 | 1 | 5.88% | `session/tasksDatabase/prepared.ts` |
| 370 | 5 | 31 | 5 | 16.13% | `subagents/subagents.ts` |
| 371 | 5 | 14 | 0 | 0.00% | `system/system.ts` |
| 372 | 5 | 15 | 0 | 0.00% | `types/yazl.d.ts` |
| 373 | 5 | 22 | 2 | 9.09% | `zcode-agent/zcodeAgentSpawnCwd.ts` |
| 374 | 5 | 15 | 0 | 0.00% | `zcode-agent/zcodeProtocolTransport.ts` |
| 375 | 4 | 12 | 0 | 0.00% | `cloud-content/cloudContent.ts` |
| 376 | 4 | 13 | 0 | 0.00% | `cua-permission-broker/cuaPipSession.ts` |
| 377 | 4 | 33 | 6 | 18.18% | `model-provider/accountRequestAuthService.ts` |
| 378 | 4 | 13 | 0 | 0.00% | `plugin-ui-bridge/index.ts` |
| 379 | 4 | 11 | 0 | 0.00% | `project/contract.example.ts` |
| 380 | 4 | 17 | 2 | 11.76% | `providers/api/apiKeyHeaders.ts` |
| 381 | 4 | 11 | 0 | 0.00% | `remote-projects/contract.example.ts` |
| 382 | 4 | 15 | 1 | 6.67% | `session/claude-native/claudeNativeImportedSessionTypes.ts` |
| 383 | 4 | 11 | 0 | 0.00% | `session/claude-native/jsonLineRecord.ts` |
| 384 | 4 | 16 | 1 | 6.25% | `session/tasksDatabase/controller-remote-schema-v4.ts` |
| 385 | 4 | 26 | 4 | 15.38% | `setting/observableSettingService.ts` |
| 386 | 4 | 21 | 3 | 14.29% | `setting/setting.ts` |
| 387 | 4 | 19 | 2 | 10.53% | `skill-sync/skillSyncErrors.ts` |
| 388 | 4 | 12 | 0 | 0.00% | `subagents/subagentModelSelection.ts` |
| 389 | 3 | 10 | 0 | 0.00% | `bots/modelSelectionHelpers.ts` |
| 390 | 3 | 12 | 1 | 8.33% | `client-config/clientConfig.ts` |
| 391 | 3 | 9 | 0 | 0.00% | `gen-ui/contract.example.ts` |
| 392 | 3 | 10 | 0 | 0.00% | `memory/index.ts` |
| 393 | 3 | 20 | 3 | 15.00% | `model-provider/bigmodelStartPlanZcodeJwt.ts` |
| 394 | 3 | 10 | 0 | 0.00% | `providers/api/index.ts` |
| 395 | 3 | 16 | 2 | 12.50% | `session/legacyTaskSessionFile.ts` |
| 396 | 3 | 35 | 8 | 22.86% | `session/offPeakTask.ts` |
| 397 | 3 | 8 | 0 | 0.00% | `startup-storage/contract.example.ts` |
| 398 | 3 | 24 | 5 | 20.83% | `storage/contract.example.ts` |
| 399 | 3 | 8 | 0 | 0.00% | `window-project-directory/contract.example.ts` |
| 400 | 3 | 13 | 1 | 7.69% | `window-project-directory/index.ts` |
| 401 | 3 | 18 | 3 | 16.67% | `zcode-agent/automationToolPolicy.ts` |
| 402 | 3 | 15 | 2 | 13.33% | `zcode-agent/zcodeAgentErrors.ts` |
| 403 | 3 | 18 | 3 | 16.67% | `zcode-agent/zcodeAgentPresentationSurface.ts` |
| 404 | 2 | 5 | 0 | 0.00% | `bot-project-runtime/contract.example.ts` |
| 405 | 2 | 9 | 1 | 11.11% | `bots/groupReply.ts` |
| 406 | 2 | 46 | 12 | 26.09% | `client-scenes/clientScenes.ts` |
| 407 | 2 | 6 | 0 | 0.00% | `gen-ui/module.ts` |
| 408 | 2 | 6 | 0 | 0.00% | `hooks/workspaceHookConfigMutation.ts` |
| 409 | 2 | 29 | 7 | 24.14% | `model-provider/accountProviderInvalidation.ts` |
| 410 | 2 | 10 | 1 | 10.00% | `model-provider/providerProvisioning.ts` |
| 411 | 2 | 35 | 9 | 25.71% | `plugin-ui-bridge/appToolsContract.ts` |
| 412 | 2 | 50 | 13 | 26.00% | `plugins/officialPluginCache.ts` |
| 413 | 2 | 13 | 2 | 15.38% | `process/windowsTaskkillRunner.ts` |
| 414 | 2 | 5 | 0 | 0.00% | `project-catalog/contract.example.ts` |
| 415 | 2 | 6 | 0 | 0.00% | `project-storage/startup-entry.ts` |
| 416 | 2 | 4 | 0 | 0.00% | `project-workspace-navigation/contract.example.ts` |
| 417 | 2 | 6 | 0 | 0.00% | `providers/api/apiEndpoints.ts` |
| 418 | 2 | 5 | 0 | 0.00% | `session/toolPlanAdapter.ts` |
| 419 | 2 | 13 | 2 | 15.38% | `startup-storage/contract.ts` |
| 420 | 2 | 4 | 0 | 0.00% | `task-groups/contract.example.ts` |
| 421 | 2 | 9 | 1 | 11.11% | `task-groups/migration-v6.ts` |
| 422 | 2 | 6 | 0 | 0.00% | `usage-stats/usageStatsConfig.ts` |
| 423 | 1 | 10 | 2 | 20.00% | `bots/groupDeliveryThrottle.ts` |
| 424 | 1 | 2 | 0 | 0.00% | `gen-ui/index.ts` |
| 425 | 1 | 1 | 0 | 0.00% | `gen-ui/node.ts` |
| 426 | 1 | 2 | 0 | 0.00% | `hooks/index.ts` |
| 427 | 1 | 24 | 7 | 29.17% | `oauth/runtimeConfig.ts` |
| 428 | 1 | 2 | 0 | 0.00% | `output-style/index.ts` |
| 429 | 1 | 6 | 1 | 16.67% | `project-workspace-navigation/module.ts` |
| 430 | 1 | 13 | 3 | 23.08% | `runtime-tools/nodeEnv.ts` |
| 431 | 1 | 4 | 1 | 25.00% | `task-facts/contract.example.ts` |

## 4. 分批计划

按「目录归属 + 缺口大小」切批，每批单独快照到 `d:\code\_annot_baseline\ZC-deep-svc-bN\`（`packages/services/src/...` 相对路径 + `_files.txt`），批内逐文件过双校验后才更新索引。

| 批次 | 范围 | 预估缺口 | 说明 |
| --- | --- | ---: | --- |
| b1 | `bots/botsService.ts` | 2464 | 单文件近万行，按「文件头 INV 表 + 主干锚点 + 公开 item 级」分层，不灌水 |
| b2 | `zcode-agent/zcodeAgentService.ts`、`zcodeTaskServiceAdapter.ts` | 2536 | 进程生命周期 / V4 协议转换两条主链路 |
| b3 | `bots/providers/**`、`bots/**` 其余 | 2423 | 渠道适配（飞书/微信/Telegram）与群消息投递时序 |
| b4 | `session/**` | 2748 | 任务库 schema/迁移、automation、off-peak、Claude 导入 |
| b5 | `conversation-share/**`、`settings-sync/**`、`model-provider/**` | 3258 | 分享包完整性、设置同步合并、provider 凭据与路由 |
| b6 | `git/**`、`usage-stats/**`、`process/**`、`node.ts`、`telemetry/**` | 2944 | 子进程/命令行、用量统计、进程树所有权 |
| b7 | 其余小目录 | ~1787 | 按目录逐个清零 |

每批完成后在 `docs/annotation/ZC-DEEP-svc-bN.md` 记录「路径｜职责｜注释主题｜+行数」，明细合计必须与 `deep-density` 的 `newComments` 对齐。

## 5. 每批固定校验

1. 快照：`ZC-deep-svc-bN/packages/services/src/...` + `_files.txt`；
2. 增量：逐文件 `git --no-pager diff --no-index --numstat <基线> <当前>`，删除列必须为 0；
3. 新增行仅整行 `//` 注释（不含 `*/`），不改代码 token / 缩进 / 字符串 / import 顺序；
4. 语法：TypeScript compiler API `parseDiagnostics === 0`，缺解析器即 fail-closed；
5. 密度：`deep-density.mjs --mode code --threshold 30`，逐文件达标；
6. 抽查 5 处最复杂逻辑，确认 INV 表与 `[并发]`/`[事务]`/`[资源]`/`[失败路径]`/`[权衡]` 标记覆盖。

本计划不做 git 提交。
