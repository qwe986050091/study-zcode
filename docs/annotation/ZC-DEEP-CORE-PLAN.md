# ZCode 深度注释计划（DEEP-PLAN）

> 规范母本：[DEEP-SPEC.md](../../../opensource/redb/docs/annotation/DEEP-SPEC.md)（v1，2026-11-06）。
> 本文只负责「测量口径 + 缺口排序 + 批次划分」，写作规范与验收判据一律以母本为准。
> 生成时间：2026-11-06。数据来自 `deep-density.mjs`（`--mode code --threshold 30`）口径的只读扫描。

## 1. 测量口径

### 1.1 命令

```powershell
# 只读基线（baseline 指向仓库自身：diff 恒为空，只取当前状态的度量）
node d:\code\_annot_baseline\deep-density.mjs d:\code\ZCode `
  --baseline d:\code\ZCode --root apps,packages,scripts,docs `
  --ext .ts,.tsx --threshold 30 --mode code --quiet --json <out>.json
```

批次验收时 `--baseline` 换成该批次的快照目录（`d:\code\_annot_baseline\ZC-deep-bN\orig`），
且 `--root` 收窄到该批次涉及的目录，避免 5,000 文件的 diff 开销。

### 1.2 范围（仅生产代码）

在脚本自带跳过（`node_modules` / `dist` / `build` / `target` / `.git`）之上，额外排除：

| 类别 | 匹配 |
| --- | --- |
| 测试文件 | `*.test.ts` `*.test.tsx` `*.spec.ts` `*.spec.tsx` `*.e2e.*` |
| 测试目录 | `__tests__/` `tests/` `test/` |
| 夹具与示例 | `fixtures/` `examples/` `__mocks__/` `mocks/` |
| 生成物 | `generated/` `*.generated.ts` `*.gen.ts` `*.d.ts` |
| 测试装配 | `wdio.conf.ts` |
| 构建配置 | `vite.config.ts` `tsup.config.ts` `vitest.config.ts`（保留在分母里，缺口均为 1~2 行，归入收尾批） |

### 1.3 L0 判定（不计密度）

`packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` 与 `apps/zcode-cli/packages/i18n/src/locales/{en-US,zh-CN}.ts`
是逐字键值字典（共 4 文件、15,489 代码行）。按母本第 2 节 L0「机器生成或逐字重复的数据，密度门槛不适用」处理：
**不计入 `coreBelow30` 分母**，只要求文件头一行说明来源。若强行按 30% 计，这 4 个文件要写 4,592 行注释，
必然滑向母本 4.1 反例 1 的同义反复，故不纳入。

### 1.4 归属划分

| 归属 | 范围 | 文件数 | coreBelow30 | needLines |
| --- | --- | ---: | ---: | ---: |
| **本会话** | `packages/**`（除 `services`）+ `apps/**` + `scripts/` + `docs/` | 4,562 | 3,224 | 141,590 |
| 另一会话 | `packages/services/**` | 466 | 430 | 26,159 |
| L0 豁免 | 4 个 i18n 字典 | 4 | — | — |
| **全仓合计** | 以上全部 | 5,032 | 3,658 | 172,341 |

## 2. 全仓基线（2026-11-06 首次测量）

```
SUMMARY files=5032 coreBelow30=3658 needLines=172341 min=0.00 median=10.53
代码行=917,944  注释行=139,187  注释率(总行口径)=13.2%
```

本会话范围（排除 services 与 L0 字典）：

```
SUMMARY files=4562 coreBelow30=3224 needLines=141590 min=0.00 median=12.02
```

读数说明：

- `median=10.53` 说明**半数生产文件的注释/代码比不到 11%**，L1/L2 历史批次覆盖的是「函数级契约」，
  远没到母本要求的「不变量 + 失败路径 + 权衡」密度。
- `min=0.00` 是 0 注释文件（如 `packages/ui/src/settings/ExternalAgentImportDialog.tsx` 的 4/1393）。
- `needLines=172,341` 是逐文件求和的缺口，**不允许**用大文件的超额注释抵扣。

### 2.1 按区域分布（本会话范围）

| 区域 | 文件数 | coreBelow30 | needLines |
| --- | ---: | ---: | ---: |
| `packages/ui/src` | 1,923 | 1,762 | 82,883 |
| `packages/desktop/src` | 351 | 280 | 14,797 |
| `packages/shared/src` | 301 | 230 | 8,009 |
| `apps/zcode-cli/packages/core` | 568 | 187 | 7,188 |
| `apps/zcode-cli/packages/bootstrap` | 283 | 128 | 5,078 |
| `apps/zcode-cli/packages/adapters` | 226 | 104 | 3,887 |
| `packages/server/src` | 53 | 51 | 2,525 |
| `packages/desktop/scripts` | 45 | 45 | 2,353 |
| `packages/web/src` | 48 | 46 | 1,932 |
| `apps/zcode-cli/packages/cli` | 85 | 57 | 1,544 |
| `packages/zcode-server-cli/src` | 49 | 45 | 1,537 |
| `apps/zcode-cli/packages/tui` | 91 | 65 | 1,472 |
| 其余（provider / office-runtime / tui 以下等） | 739 | ~424 | ~12,385 |

UI 占本会话缺口的 58.5%，是主要战场；`apps/zcode-cli/packages/core` 虽然历史注释最厚（568 文件里只有
187 个不达标），但按母本 L1 判据它才是「必须写深」的主体。

## 3. 缺口前 40 名（本会话范围）

按 `need` 降序；`code/comment/%` 为当前状态，`累计` 是前 N 名的缺口和。

| # | 缺口行 | code | comment | 当前% | 累计 | 文件 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1168 | 5425 | 460 | 8.5 | 1168 | `packages/ui/src/v4/SessionPane.tsx` |
| 2 | 891 | 3797 | 249 | 6.6 | 2059 | `packages/desktop/src/host/index.ts` |
| 3 | 855 | 3283 | 130 | 4.0 | 2914 | `packages/ui/src/lib/zcodeSessionProjection.ts` |
| 4 | 853 | 3881 | 312 | 8.0 | 3767 | `packages/shared/src/zcode-protocol/index.ts` |
| 5 | 841 | 4054 | 376 | 9.3 | 4608 | `packages/desktop/src/main/browserView/browserGuestManager.ts` |
| 6 | 789 | 3735 | 332 | 8.9 | 5397 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` |
| 7 | 741 | 2760 | 87 | 3.2 | 6138 | `packages/ui/src/settings/AutomationEditView.tsx` |
| 8 | 656 | 2589 | 121 | 4.7 | 6794 | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` |
| 9 | 572 | 2153 | 74 | 3.4 | 7366 | `packages/ui/src/SettingsPage.tsx` |
| 10 | 558 | 1986 | 38 | 1.9 | 7924 | `apps/zcode-cli/packages/core/src/subagent/runner.ts` |
| 11 | 550 | 1863 | 9 | 0.5 | 8474 | `packages/ui/src/settings/RemotePluginSyncDialog.tsx` |
| 12 | 535 | 2056 | 82 | 4.0 | 9009 | `packages/ui/src/remote-connection-flow/index.ts` |
| 13 | 534 | 2236 | 137 | 6.1 | 9543 | `packages/ui/src/root/useRemoteWorkspaceHistory.ts` |
| 14 | 513 | 2200 | 147 | 6.7 | 10056 | `packages/ui/src/v4/ConversationRowView.tsx` |
| 15 | 511 | 2343 | 192 | 8.2 | 10567 | `packages/desktop/src/main/index.ts` |
| 16 | 495 | 1792 | 43 | 2.4 | 11062 | `packages/ui/src/settings/SubagentsSection.tsx` |
| 17 | 493 | 1848 | 62 | 3.4 | 11555 | `packages/desktop/src/main/webRemoteControlManager.ts` |
| 18 | 492 | 2486 | 254 | 10.2 | 12047 | `packages/ui/src/v4/ConversationComposer.tsx` |
| 19 | 491 | 1932 | 89 | 4.6 | 12538 | `packages/web/src/main.tsx` |
| 20 | 485 | 1693 | 23 | 1.4 | 13023 | `packages/ui/src/settings/SourceServerManagementPanel.tsx` |
| 21 | 479 | 2025 | 129 | 6.4 | 13502 | `packages/ui/src/v4/ConversationStatusPanel.tsx` |
| 22 | 475 | 1693 | 33 | 1.9 | 13977 | `packages/ui/src/PreviewPane.tsx` |
| 23 | 462 | 1868 | 99 | 5.3 | 14439 | `packages/ui/src/settings/AutomationsSection.tsx` |
| 24 | 452 | 1697 | 58 | 3.4 | 14891 | `packages/server/src/remote/remoteAssetCache.ts` |
| 25 | 428 | 1809 | 115 | 6.4 | 15319 | `packages/desktop/src/main/autoUpdater.ts` |
| 26 | 422 | 1532 | 38 | 2.5 | 15741 | `packages/desktop/src/main/desktopRemoteSessions.ts` |
| 27 | 414 | 1393 | 4 | 0.3 | 16155 | `packages/ui/src/settings/ExternalAgentImportDialog.tsx` |
| 28 | 412 | 1670 | 89 | 5.3 | 16567 | `packages/shared/src/validation.ts` |
| 29 | 410 | 1425 | 18 | 1.3 | 16977 | `packages/ui/src/settings/PluginsSection.tsx` |
| 30 | 402 | 1483 | 43 | 2.9 | 17379 | `apps/zcode-cli/packages/debug/src/App.tsx` |
| 31 | 398 | 1505 | 54 | 3.6 | 17777 | `packages/ui/src/settings/McpSettingsSection.tsx` |
| 32 | 390 | 1735 | 131 | 7.6 | 18167 | `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` |
| 33 | 380 | 1310 | 13 | 1.0 | 18547 | `packages/ui/src/GitActionMenu.tsx` |
| 34 | 364 | 1220 | 2 | 0.2 | 18911 | `packages/ui/src/lib/conversationTelemetryParityScenarioDefinitions.ts` |
| 35 | 364 | 1918 | 212 | 11.1 | 19275 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` |
| 36 | 358 | 1497 | 92 | 6.1 | 19633 | `packages/ui/src/Root.tsx` |
| 37 | 354 | 1374 | 59 | 4.3 | 19987 | `packages/ui/src/lib/messageTelemetry.ts` |
| 38 | 351 | 2678 | 453 | 16.9 | 20338 | `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` |
| 39 | 345 | 1266 | 35 | 2.8 | 20683 | `apps/dev-docs/src/data/protocolDocs.ts` |
| 40 | 344 | 1405 | 78 | 5.6 | 21027 | `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` |

前 40 名合计缺口 21,027 行，只占全部缺口的 14.8%——尾部 3,184 个文件才是主要体量，
因此批次划分不能只做头部。

## 4. 批次划分

### 4.1 装箱规则

1. 对「本会话范围内 `need > 0`」的 3,224 个文件按 `need` 降序排列；
2. 顺序贪心装箱，单批上限 **2,000 行缺口** 或 **20 个文件**，先到先切；
3. 不跨批重排顺序 —— 因此批次号即「缺口从大到小」的推进顺序（满足任务书的缺口排序要求）。

结果：**181 批**，平均每批 782 行缺口 / 17.8 个文件。

### 4.2 批次总表

﻿| 批次 | 文件数 | 缺口行 | 主要目录 |
| --- | ---: | ---: | --- |
| B1 | 1 | 1168 | packages/ui/src/v4 |
| B2 | 2 | 1746 | packages/desktop/src/host、packages/ui/src/lib |
| B3 | 2 | 1694 | packages/shared/src/zcode-protocol、packages/desktop/src/main/browserView |
| B4 | 2 | 1530 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol、packages/ui/src/settings |
| B5 | 3 | 1786 | packages/ui/src/app-shell、packages/ui/src 等 3 个目录 |
| B6 | 3 | 1619 | packages/ui/src/settings、packages/ui/src/remote-connection-flow 等 3 个目录 |
| B7 | 3 | 1519 | packages/ui/src/v4、packages/desktop/src/main 等 3 个目录 |
| B8 | 4 | 1961 | packages/desktop/src/main、packages/ui/src/v4 等 4 个目录 |
| B9 | 4 | 1868 | packages/ui/src/v4、packages/ui/src 等 4 个目录 |
| B10 | 4 | 1676 | packages/desktop/src/main、packages/ui/src/settings 等 3 个目录 |
| B11 | 5 | 1980 | packages/ui/src/settings、apps/zcode-cli/packages/debug/src 等 4 个目录 |
| B12 | 5 | 1791 | packages/ui/src/lib、apps/zcode-cli/packages/bootstrap/src/zcode-protocol 等 4 个目录 |
| B13 | 5 | 1713 | apps/dev-docs/src/data、packages/ui/src/app-shell 等 4 个目录 |
| B14 | 6 | 1952 | packages/ui/src/hooks、packages/ui/src/lib 等 6 个目录 |
| B15 | 6 | 1824 | packages/ui/src/settings/model-provider-section、packages/ui/src/v4 等 5 个目录 |
| B16 | 7 | 1951 | apps/dev-docs/src、packages/ui/src/settings/usage-stats 等 5 个目录 |
| B17 | 7 | 1862 | apps/zcode-cli/packages/core/src/browser-client、packages/ui/src/remote-connection 等 7 个目录 |
| B18 | 8 | 1973 | packages/desktop/src/host、packages/ui/src/v4/composer 等 7 个目录 |
| B19 | 8 | 1834 | packages/ui/src/store、packages/desktop/src/host 等 8 个目录 |
| B20 | 9 | 1921 | apps/zcode-cli/packages/adapters/src/fs、packages/shared/src 等 8 个目录 |
| B21 | 9 | 1819 | packages/ui/src/v4、packages/desktop/src/host 等 9 个目录 |
| B22 | 10 | 1878 | apps/zcode-cli/packages/adapters/src/storage/session-store、packages/ui/src 等 7 个目录 |
| B23 | 11 | 1950 | packages/ui/src/v4、packages/provider/src 等 10 个目录 |
| B24 | 12 | 1983 | packages/ui/src/workspace-file-tree、packages/desktop/src/main 等 12 个目录 |
| B25 | 13 | 1970 | packages/ui/src/components/ai-elements、packages/ui/src/project-sidebar 等 12 个目录 |
| B26 | 14 | 1997 | packages/ui/src/project-sidebar、packages/ui/src/settings 等 11 个目录 |
| B27 | 14 | 1897 | packages/ui/src/feedback、packages/ui/src/ToolCallBlocks/renderers 等 12 个目录 |
| B28 | 15 | 1947 | packages/ui/src、packages/ui/src/hooks 等 11 个目录 |
| B29 | 16 | 1975 | packages/ui/src、packages/ui/src/components/ai-elements 等 13 个目录 |
| B30 | 16 | 1895 | packages/ui/src、packages/ui/src/chat-input-toolbar 等 12 个目录 |
| B31 | 17 | 1935 | packages/ui/src/settings、packages/ui/src/v4/telemetry 等 13 个目录 |
| B32 | 18 | 1970 | packages/ui/src/lib、packages/server/src 等 15 个目录 |
| B33 | 18 | 1902 | apps/zcode-cli/packages/core/src/runtime/methods、packages/shared/src 等 14 个目录 |
| B34 | 19 | 1930 | packages/ui/src、packages/ui/src/git-graph 等 15 个目录 |
| B35 | 20 | 1984 | packages/ui/src/settings/model-provider-section、packages/server/src/source-server 等 16 个目录 |
| B36 | 20 | 1927 | apps/zcode-cli/packages/core/src/runtime/methods、packages/ui/src/settings/saved-workflows 等 16 个目录 |
| B37 | 20 | 1868 | packages/ui/src/settings、packages/ui/src/remote-connection 等 16 个目录 |
| B38 | 20 | 1798 | packages/desktop/src/main、packages/ui/src/root 等 18 个目录 |
| B39 | 20 | 1740 | packages/shared/src、packages/ui/src/components/ui 等 15 个目录 |
| B40 | 20 | 1688 | packages/ui/src/v4、apps/zcode-cli/packages/core/src/workflow 等 16 个目录 |
| B41 | 20 | 1625 | packages/ui/src/store、apps/zcode-cli/packages/adapters/src/mcp 等 16 个目录 |
| B42 | 20 | 1559 | packages/ui/src/ToolCallBlocks/renderers、packages/ui/src/gen-ui/components 等 14 个目录 |
| B43 | 20 | 1512 | packages/desktop/scripts/mcp-apps-host-fixture、packages/desktop/src/main 等 17 个目录 |
| B44 | 20 | 1472 | packages/ui/src/store、apps/zcode-cli/packages/office-runtime/ui/viewers 等 18 个目录 |
| B45 | 12（实际） | 1159 | packages/ui/src、apps/zcode-cli（两波续做收尾） |
| B46 | 12（实际） | 1127 | packages/ui/src、packages/shared/src、adapters/src（复算后重排） |
| B47 | 12（实际） | 1102 | desktop/src/main、ui/src、ai-elements、core/tool/handlers（复算后重排） |
| B48 | 12（实际） | 1090 | core/tool、core/workflow、core/mcp、core/runtime、ui/lib、ui/v4、ui/quickpick、cli/command-center（复算后重排） |
| B49 | 12（实际） | 1060 | ui/src、ui/src/ToolCallBlocks、ui/src/settings、ui/src/app-shell、ui/src/quickpick、ui/src/store、shared/src/zcode-protocol-v4、server/src/remote（复算后重排） |
| B50 | 12（实际） | 1033 | ui/src、ui/src/components/ai-elements、ui/src/feedback、ui/src/v4、ui/src/lib、ui/src/remote-connection、ui/src/settings/saved-workflows、core/runtime/methods、tui/src（复算后重排） |
| B51 | 12（实际） | 1000 | ui/src/ToolCallBlocks、ui/src/lib、ui/src/settings、ui/src/v4、ui/src/gen-ui、ui/src/login、desktop/scripts/mcp-apps-host-fixture、desktop/main/mcpUserDirectory、desktop/main（复算后重排） |
| B52 | 12（实际） | 987 | desktop/src/main、desktop/src/main/browserView、desktop/src/main/pluginSandbox、ui/src/components/ai-elements、ui/src/ToolCallBlocks/renderers、shared/src、rpc/src、server/src/remote（复算后重排） |
| B53 | 12（实际） | 969 | ui/src/project-sidebar、ui/src/app-shell、ui/src/feedback、ui/src/lib、ui/src/rewards、shared/src、client/src、desktop/scripts/mcp-apps-host-fixture、desktop/src/main、apps/zcode-cli/packages/i18n（复算后重排） |
| B54 | 12（实际） | 1039 | stream-animate/src/server、bootstrap/src、bootstrap/src/app、bootstrap/src/zcode-protocol-v4、adapters/src/mcp、zcode-server-cli/src/server-core、core/tool/handlers、shared/src、ui/src、ui/src/v4、ui/src/ToolCallBlocks/renderers（复算后重排） |
| B55 | 12（实际） | 972 | e2e-report/src/viewer、node-repl-host/src、ui/src/settings/usage-stats、office-runtime/ui/viewers、desktop/src/main、ui/src/components/ai-elements、ui/src/settings、ui/src/store、adapters/src/model、desktop/src/main/web-remote-relay、shared/src/zcode-protocol-v4（复算后重排） |
| B56 | 12（实际） | 926 | ui/src/components/ai-elements、ui/src/root、ui/src/ToolCallBlocks、ui/src/v4/composer、core/src/runtime/methods、desktop/src/main/browserView、desktop/src/main/mcpUserDirectory、desktop/src/main、ui/src/app-shell、ui/src/git-graph、ui/src/lib、ui/src/settings（复算后重排） |
| B57 | 12（实际） | 927 | e2e-report/src/viewer、ui/src/feedback、ui/src/lib、ui/src（ModelTrajectoryPaneDetails）、ui/src/settings/model-provider-section、ui/src/settings/saved-workflows、ui/src/v4、ui/src（WindowsCaptionMenuButton）、bootstrap/src/app、core/src/tool/handlers、desktop/src/main、ui/src/app-shell（复算后重排） |
| B58 | 12（实际） | 901 | ui/src/git-graph、ui/src/root、ui/src/settings、zcode-server-cli/src/platform、bootstrap/src/app、telemetry、desktop/scripts/gen-ui-fixture、ui/src/app-shell、ui/src/BotsDialog、ui/src/components/cloud-content-dialog、ui/src/i18n、shared/src（复算后重排） |
| B59 | 12（实际） | 862 | ui/src/ToolCallBlocks/renderers、ui/src/v4、ui/src/store、desktop/scripts/mcp-apps-host-fixture、desktop/src/main、shared/src、ui/src/hooks（复算后重排） |
| B60 | 12（实际） | 859 | ui/src/settings/model-provider-section、ui/src/workspace-plugin-preview、desktop/src/main、desktop/src/renderer、ui/src/plugin-ui、desktop/src/host、desktop/src/renderer/plugin-sandbox、ui/src/components/ui、ui/src/lib、ui/src/v4（复算后重排） |
| B61 | 12（实际） | 840 | apps/zcode-cli/packages/core（hooks、session-context、tool/handlers）、dynamic-workflow/src、bootstrap/src/app、shared/src（gen-ui、subagent-profile-frontmatter）、ui/src/store、ui/src/lib、ui/src/components/ai-elements、desktop/src/main（复算后重排） |
| B62 | 12（实际） | 821 | ui/src/project-sidebar（grouped）、ui/src/root、ui/src/store、ui/src/lib、ui/src/components/ai-elements、ui/src/settings、desktop/src/main/browserView、desktop/src/main、rpc/src（复算后重排） |
| B63 | 12（实际） | 815 | dev-docs/src/capability-map、adapters/src/browser、adapters/src/model、tui/src、bootstrap/src/zcode-protocol、desktop/scripts/mcp-apps-host-fixture、model-option-map/src、desktop/src/main/browserView、desktop/src/main、ui/src/components/ai-elements、ui/src/lib、ui/src/store（复算后重排） |
| B64 | 12（实际） | 807 | cli/src/command-center、desktop/src/scheduler、ui/src/browser-use、ui/src/project-sidebar、ui/src/ToolCallBlocks/renderers、ui/src/v4/composer、zcode-server-cli/src、zcode-server-cli/src/runtime、core/src/runtime/methods、desktop/src/main、ui/src/components/cloud-content-dialog、ui/src/settings（复算后重排） |
| B65 | 12（实际） | 792 | ui/src/v4、desktop/src/main、ui/src/components/ai-elements、ui/src/feedback、ui/src/resource-manager、ui/src/settings/usage-stats、ui/src/ToolCallBlocks/renderers、zcode-server-cli/src/packaging、adapters/src/exec、cli/src、core/src/runtime/methods、server/src/remote（复算后重排） |
| B66 | 12（实际） | 787 | ui/src/components/ui、ui/src/ToolCallBlocks/renderers、ui/src、ui/src/app-shell、ui/src/hooks、ui/src/root、ui/src/store、dynamic-workflow/src/testing、tui/src、shared/src（复算后重排） |
| B67 | 12（实际） | 787 | ui/src/app-shell、ui/src/components/ai-elements、ui/src/lib、ui/src、ui/src/settings/saved-workflows、ui/src/ToolCallBlocks/renderers、ui/src/v4、adapters/src/config、core/src/runtime/methods、core/src/workflow/scheduler、desktop/src/host（复算后重排） |
| B68 | 12（实际） | 769 | ui/src/settings/usage-stats、ui/src/ToolCallBlocks、debug/src、desktop/scripts/mcp-apps-host-fixture、ui/src/components/ui、ui/src/feedback、ui/src/lib、ui/src/resource-manager/storage、ui/src/v4、adapters/src/model（复算后重排） |
| B69 | 12（实际） | 762 | ui/src/components/cloud-content-dialog、ui/src/lib、ui/src/ToolCallBlocks/renderers、ui/src/v4、ui/src/v4/highspeed、web/src/share、adapters/src/browser、core/src/tool/handlers、desktop/src/main、shared/src、ui/src/app-shell（复算后重排） |
| B70 | 12（实际） | 753 | ui/src/settings、ui/src/project-sidebar/grouped、desktop/scripts/mcp-apps-host-fixture、shared/src、ui/src/components/ai-elements、ui/src/store、ui/src/feedback、ui/src/lib、ui/src/hooks、ui/src/v4、cli/src（复算后重排） |
| B71 | 12（实际） | 751 | ui/src/git-graph、ui/src/presentation、core/src/browser-client、desktop/src/main/browserView、server/src/remote、ui/src（根）、ui/src/v4、adapters/src/exec、core/src/runtime/methods、ui/src/project-workflow（复算后重排） |
| B72 | 12（实际） | 739 | ui/src/settings/model-provider-section、ui/src/settings/saved-workflows、ui/src/ToolCallBlocks、ui/src（根）、dev-docs/src/capability-map、bootstrap/src、core/src/tool、client/src、desktop/src/main、server/src/remote、shared/src、ui/src/onboarding（复算后重排） |
| B73 | 12（实际） | 729 | desktop/scripts/mcp-apps-host-fixture、desktop/src/main、desktop/src/main/pluginSandbox、stream-animate/src/client、ui/src/project-sidebar/grouped、ui/src/settings、ui/src（根）、web/src/auth、zcode-server-cli/src/runtime、core/src/tool/handlers、tui/src（复算后重排） |
| B74 | 12（实际） | 729 | ui/src/settings/model-provider-section、ui/src/settings、ui/src/store、ui/src/ToolCallBlocks/renderers、ui/src/v4、zcode-server-cli/src/packaging、bootstrap/src/app、desktop/scripts/mcp-apps-host-fixture、shared/src/zcode-protocol-v4（复算后重排） |
| B75 | 12（实际） | 712 | core/src/tool/handlers、shared/src、server/src/remote、desktop/src/renderer/src/plugin-sandbox、web/src/web-remote-control/app、ui/src/v4、ui/src/app-shell/workflow-artifacts/presets、ui/src/chat-input-toolbar、ui/src/components/ai-elements、ui/src/lib、ui/src/plugin-ui/adapters、ui/src/ToolCallBlocks/renderers（复算后重排） |
| B76 | 6（实际） | 358 | bootstrap/src/app、core/src/hooks、core/src/runtime/methods、tui/src、ui/src/components/ai-elements、ui/src（根）（复算后重排，单批降至 6） |
| B77 | 6（实际） | 351 | ui/src/hooks、ui/src/lib、ui/src/mentions/providers、ui/src/remote-connection、ui/src/ToolCallBlocks（复算后重排，单批 6） |
| B78 | 6（实际） | 351 | ui/src/git-branch-switcher、ui/src（根）、ui/src/browser-use、ui/src/cua-permission、ui/src/gen-ui/adapters、ui/src/ToolCallBlocks（复算后重排，单批 6） |
| B79 | 6（实际） | 349 | ui/src/ToolCallBlocks/renderers、desktop/src/renderer/src、shared/src/zcode-protocol-v4、ui/src/components/ai-elements、ui/src/components/coding-plan-quota-reset（复算后重排，单批 6） |
| B80 | 6（实际） | 344 | ui/src/hooks、zcode-server-cli/src/runtime、ui/src/conversation-share-interaction、ui/src/components/workflow-timeline（复算后重排，单批 6） |
| B81 | 6（实际） | 343 | shared/src、shared/src/node、e2e-report/src/viewer、core/src/errors、bootstrap/src/zcode-protocol（复算后重排，单批 6） |
| B82 | 6（实际） | 339 | ui/src/project-sidebar、ui/src/store、ui/src/v4、ui/src/v4/telemetry（复算后重排，单批 6） |
| B83 | 6（实际） | 328 | desktop/src/main、desktop/src/main/mcpUserDirectory、shared/src、desktop/scripts/gen-ui-fixture、desktop/scripts/mcp-apps-host-fixture（复算后重排，单批 6） |
| B84 | 6（实际） | 331 | ui/src/lib、ui/src/components/workflow-timeline、ui/src/settings/model-provider-section（复算后重排，单批 6） |
| B85 | 6（实际） | 327 | ui/src（根）、ui/src/v4（复算后重排，单批 6） |
| B86 | 6（实际） | 337 | ui/src 组件、plugin-ui、office-runtime、settings（复算后重排，单批 6） |
| B87 | 6（实际） | 325 | ui/src 文件树、侧栏、终端、设置；provider/src/config（复算后重排，单批 6） |
| B88 | 6（实际） | 319 | ui/src/lib、ui/src/resource-manager、ui/src/components/ai-elements（复算后重排，单批 6） |
| B89 | 6（实际） | 320 | ui/src/settings、ui/src/settings/model-provider-section、shared/src、shared/src/zcode-protocol-v4（复算后重排，单批 6） |
| B90 | 6（实际） | 319 | ui/src 组件、预览、项目侧栏、settings-sync、v4 投递动作（复算后重排，单批 6） |
| B91 | 6（实际） | 322 | tui/src、office-runtime/ui、desktop/scripts 夹具（复算后重排，单批 6） |
| B92 | 6（实际） | 314 | ui/src/components/marketing-touch、ui/src 归档删除、ui/src/hooks、ui/src/mentions、ui/src 预览、ui/src/resource-manager（复算后重排，单批 6） |
| B93 | 6（实际） | 318 | core/src/tool/handlers、desktop/src/main 托盘与权限桥、崩溃转储注解（复算后重排，单批 6） |
| B94 | 6（实际） | 314 | ui/src/v4 传输与埋点、ui/src/settings、ui/src/root 家族连接刷新（复算后重排，单批 6） |
| B95 | 6（实际） | 317 | adapters/src 执行、诊断、浏览器动作、zip 插件源、desktop TOML（复算后重排，单批 6） |
| B96 | 6（实际） | 302 | ui/src 会话选择器、终端状态、动作目录、远端投影、侧栏偏好、市场源弹窗（复算后重排，单批 6） |
| B97 | 6（实际） | 325 | cli/src 插件输出、provider-node 远端同步、web/src 鉴权与多连接选择层、zcode-server-cli 打包、core/tool 校验（复算后重排，单批 6） |
| B98 | 6（实际） | 306 | packages/ui/src 的 workflow-timeline、workflow-artifacts、components/ui、conversation-share-interaction（复算后重排，单批 6） |
| B99 | 6（实际） | 303 | ui/src 轨迹展开、交互徽标、远控入口、工具块渲染、任务列表钩子、闲时历史（复算后重排，单批 6） |
| B100 | 6（实际） | 295 | packages/shared/src 家族、wire codec、观察卡 schema、实时合约 + provider 账号解析 + ui 远控展示（复算后重排，单批 6） |
| B101 | 6（实际） | 297 | dynamic-workflow schema 发射与校验、ui/src/settings 参数表/作用域/迁移报告、app-shell run 详情（复算后重排，单批 6） |
| B102 | 6（实际） | 303 | workflow scheduler 节点执行、Desktop 截图像素校正与构建配置、能力地图视图、响应式视口 hook、会话打开埋点（复算后重排，单批 6） |
| B103 | 6（实际） | 296 | 文件提及搜索、会话目标表、git 只读子命令白名单、定时自动化工具、代码评论卡片、工作流运行行（复算后重排，单批 6） |
| B104 | 6（实际） | 292 | 插件页面工具转发、侧栏任务行、代码评论附件 hook、会话输入账本、插件引用提醒、本地抓包服务（复算后重排，单批 6） |
| B105 | 6（实际） | 283 | 应用外壳状态、标题溢出文本、全局通知存储、高速分享卡片、工具调用树、mention Markdown（复算后重排，单批 6） |
| B106 | 6（实际） | 284 | TUI diff 高亮视图、knip 插件文档生成、Desktop 运行时探针、托管模型夹具、scheduler 进程托管、插件沙箱注册表（复算后重排，单批 6） |
| B107 | 6（实际） | 285 | 内置 Provider 配置来源、MCP 类型与 CUA 识别、远控中继契约、确认窗设置零件、配置文件路径 hook、存储分类详情（复算后重排，单批 6） |
| B108 | 6（实际） | 285 | 供应商模板选择、运行记录工具卡、只读 flag 白名单、闲时任务工具、iOS 模拟器 MCP、docx 查看器（复算后重排，单批 6） |
| B109 | 20 | 380 | packages/ui/src/lib、packages/ui/src/v4 等 16 个目录 |
| B110 | 20 | 368 | packages/ui/src/app-shell、packages/ui/src/v4 等 17 个目录 |
| B111 | 20 | 360 | packages/ui/src/v4、packages/desktop/src/main 等 14 个目录 |
| B112 | 20 | 360 | packages/web/src/web-remote-control/app、packages/ui/src/lib 等 18 个目录 |
| B113 | 20 | 346 | apps/zcode-cli/packages/dynamic-workflow/src/analysis、packages/shared/src/zcode-protocol-v4 等 18 个目录 |
| B114 | 20 | 340 | packages/ui/src/hooks、packages/ui/src/workspace-grouped-tasks 等 18 个目录 |
| B115 | 20 | 340 | packages/shared/src、packages/ui/src/v4/composer 等 16 个目录 |
| B116 | 20 | 320 | apps/zcode-cli/packages/core/src/compact、packages/desktop/scripts/gen-ui-fixture 等 17 个目录 |
| B117 | 20 | 320 | packages/ui/src/plugin-ui/adapters、packages/desktop/src/main/web-remote-relay 等 16 个目录 |
| B118 | 20 | 307 | apps/zcode-cli/packages/tui/src、apps/zcode-cli/packages/cli/src 等 15 个目录 |
| B119 | 20 | 300 | packages/ui/src/v4、packages/ui/src/workspace-config-catalog 等 19 个目录 |
| B120 | 20 | 300 | packages/shared/src、packages/ui/src/lib 等 16 个目录 |
| B121 | 20 | 283 | apps/zcode-cli/packages/office-runtime/src/app、apps/zcode-cli/packages/tui/src 等 14 个目录 |
| B122 | 20 | 280 | packages/ui/src/workspace-config-catalog、packages/ui/src 等 13 个目录 |
| B123 | 20 | 280 | packages/desktop/src/main、packages/shared/src 等 17 个目录 |
| B124 | 20 | 266 | apps/zcode-cli/packages/bootstrap/src/app、packages/desktop/src/main 等 18 个目录 |
| B125 | 20 | 260 | packages/desktop/scripts/gen-ui-fixture、packages/ui/src/chat-input-toolbar 等 17 个目录 |
| B126 | 20 | 260 | packages/web/src/web-remote-control/ui、apps/zcode-cli/packages/core/src/tool/handlers/guarded 等 13 个目录 |
| B127 | 20 | 252 | packages/shared/src/mcp-apps、packages/ui/src/components/workflow-timeline 等 18 个目录 |
| B128 | 20 | 240 | packages/ui/src/gen-ui、packages/ui/src/hooks 等 11 个目录 |
| B129 | 20 | 240 | packages/ui/src/v4、packages/desktop/src/main 等 16 个目录 |
| B130 | 20 | 237 | packages/ui/src/settings、packages/ui/src/lib 等 17 个目录 |
| B131 | 20 | 220 | packages/shared/src、packages/shared/src/gen-ui 等 12 个目录 |
| B132 | 20 | 220 | packages/ui/src/side-pane-full-view、packages/ui/src/WorkspaceHeaderSections 等 15 个目录 |
| B133 | 20 | 220 | packages/shared/src、packages/ui/src/components/workflow-timeline 等 17 个目录 |
| B134 | 20 | 212 | packages/desktop/src/host/database-startup、apps/zcode-cli/packages/bootstrap/src/app 等 18 个目录 |
| B135 | 20 | 200 | packages/ui/src/project-sidebar/grouped、packages/ui/src/project-sidebar 等 14 个目录 |
| B136 | 20 | 200 | packages/desktop/src/main、packages/ui/src/ToolCallBlocks/renderers 等 15 个目录 |
| B137 | 20 | 200 | apps/zcode-cli/packages/core/src/tool/handlers、apps/zcode-cli/packages/office-runtime/ui/shell 等 17 个目录 |
| B138 | 20 | 184 | apps/zcode-cli/packages/core/src/tool/handlers、packages/ui/src/components/workflow-timeline 等 16 个目录 |
| B139 | 20 | 180 | packages/ui/src/settings、packages/ui/src/ToolCallBlocks 等 14 个目录 |
| B140 | 20 | 180 | packages/web/src/web-remote-control/adapters、apps/zcode-cli/packages/core/src/subagent 等 16 个目录 |
| B141 | 20 | 180 | apps/dev-docs/src/capability-map、packages/desktop/src/main/browserView 等 19 个目录 |
| B142 | 20 | 165 | apps/zcode-cli/packages/tui/src、apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui 等 19 个目录 |
| B143 | 20 | 160 | packages/ui/src、packages/shared/src/web-remote-relay/domain 等 11 个目录 |
| B144 | 20 | 160 | packages/shared/src、packages/ui/src/lib 等 14 个目录 |
| B145 | 20 | 160 | packages/ui/src/components/coding-plan-quota-reset、packages/ui/src/components/mobile-ui 等 15 个目录 |
| B146 | 20 | 152 | packages/desktop/src/main/pluginSandbox、apps/zcode-cli/packages/bootstrap/src/zcode-protocol 等 19 个目录 |
| B147 | 20 | 140 | packages/ui/src/components/cloud-content-dialog、packages/ui/src/git-graph 等 14 个目录 |
| B148 | 20 | 140 | packages/shared/src/zcode-protocol-v4、packages/ui/src/root 等 16 个目录 |
| B149 | 20 | 140 | packages/ui/src/browser-use、packages/ui/src/settings 等 18 个目录 |
| B150 | 20 | 140 | packages/desktop/src/scheduler、packages/ui/src/v4 等 18 个目录 |
| B151 | 20 | 123 | apps/zcode-cli/packages/core/src/workflow、apps/zcode-cli/packages/adapters/src/model 等 16 个目录 |
| B152 | 20 | 120 | packages/ui/src、packages/ui/src/plugin-ui/adapters 等 16 个目录 |
| B153 | 20 | 120 | packages/ui/src/settings、packages/ui/src/side-pane-full-view 等 14 个目录 |
| B154 | 20 | 120 | packages/ui/src/lib、packages/ui/src/app-shell 等 17 个目录 |
| B155 | 20 | 112 | packages/ui/src/v4、packages/ui/src/ToolCallBlocks/renderers 等 19 个目录 |
| B156 | 20 | 100 | packages/shared/src、packages/ui/src/components/ui 等 12 个目录 |
| B157 | 20 | 100 | packages/zcode-server-cli/src/server-core、apps/zcode-cli/packages/adapters/src 等 15 个目录 |
| B158 | 20 | 100 | apps/zcode-cli/packages/contracts/src/interfaces、packages/ui/src/hooks 等 18 个目录 |
| B159 | 20 | 100 | packages/ui/src/settings/saved-workflows、packages/ui/src/highspeed 等 15 个目录 |
| B160 | 20 | 92 | packages/ui/src/hooks、packages/ui/src/lib 等 14 个目录 |
| B161 | 20 | 80 | packages/ui/src/gen-ui、packages/ui/src/hooks 等 15 个目录 |
| B162 | 20 | 80 | packages/shared/src/zcode-protocol-v4、packages/ui/src/components/icons 等 16 个目录 |
| B163 | 20 | 80 | packages/ui/src/plugin-ui/app、packages/ui/src 等 18 个目录 |
| B164 | 20 | 75 | apps/zcode-cli/packages/tui/src、apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4 等 20 个目录 |
| B165 | 20 | 60 | packages/shared/src、packages/shared/src/request-security-edition 等 12 个目录 |
| B166 | 20 | 60 | packages/ui/src/request-security-edition、packages/ui/src 等 17 个目录 |
| B167 | 20 | 60 | packages/desktop/src/main/browserView、packages/ui/src/lib 等 14 个目录 |
| B168 | 20 | 60 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol、packages/shared/src 等 15 个目录 |
| B169 | 20 | 57 | apps/zcode-cli/packages/tui/src、apps/zcode-cli/packages/adapters/src/model 等 16 个目录 |
| B170 | 20 | 40 | packages/desktop/src/main、packages/desktop/src/main/web-remote-relay 等 17 个目录 |
| B171 | 20 | 40 | packages/ui/src/lib、packages/ui/src 等 17 个目录 |
| B172 | 20 | 40 | packages/ui/src/v4、packages/web/src/web-remote-control/ui 等 15 个目录 |
| B173 | 20 | 40 | packages/ui/src/lib、packages/desktop/src/main 等 15 个目录 |
| B174 | 20 | 40 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4、packages/ui/src/components/workflow-timeline 等 14 个目录 |
| B175 | 20 | 36 | packages/web、apps/zcode-cli/packages/core/src/tool/handlers 等 16 个目录 |
| B176 | 20 | 20 | apps/zcode-cli/packages/core/src/subagent、apps/zcode-cli/packages/office-runtime 等 18 个目录 |
| B177 | 20 | 20 | packages/shared/src、packages/shared/src/web-remote-relay 等 17 个目录 |
| B178 | 20 | 20 | packages/desktop/src/renderer/src、packages/server/src/remote 等 19 个目录 |
| B179 | 20 | 20 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol、packages/desktop/src/main 等 18 个目录 |
| B180 | 20 | 20 | apps/zcode-cli/packages/core/src、packages/ui/src 等 18 个目录 |
| B181 | 8 | 8 | packages/desktop/src/main/browserView、apps/zcode-cli/packages/adapters/src/auth 等 8 个目录 |


### 4.3 前 10 批的文件清单

> 后续批次清单按 4.1 的规则可由当前 `zc-measure-all.json` 复算；执行时以 `docs/annotation/ZC-DEEP-bN.md`
> 落地的实际文件为准（批次内文件若被其他会话改动，按 5.4 剔除并顺延）。

**B1**（1 文件，缺口 1168 行）
- `packages/ui/src/v4/SessionPane.tsx`

**B2**（2 文件，缺口 1746 行）
- `packages/desktop/src/host/index.ts` — 891
- `packages/ui/src/lib/zcodeSessionProjection.ts` — 855

**B3**（2 文件，缺口 1694 行）
- `packages/shared/src/zcode-protocol/index.ts` — 853
- `packages/desktop/src/main/browserView/browserGuestManager.ts` — 841

**B4**（2 文件，缺口 1530 行）
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` — 789
- `packages/ui/src/settings/AutomationEditView.tsx` — 741

**B5**（3 文件，缺口 1786 行）
- `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` — 656
- `packages/ui/src/SettingsPage.tsx` — 572
- `apps/zcode-cli/packages/core/src/subagent/runner.ts` — 558

**B6**（3 文件，缺口 1619 行）
- `packages/ui/src/settings/RemotePluginSyncDialog.tsx` — 550
- `packages/ui/src/remote-connection-flow/index.ts` — 535
- `packages/ui/src/root/useRemoteWorkspaceHistory.ts` — 534

**B7**（3 文件，缺口 1519 行）
- `packages/ui/src/v4/ConversationRowView.tsx` — 513
- `packages/desktop/src/main/index.ts` — 511
- `packages/ui/src/settings/SubagentsSection.tsx` — 495

**B8**（4 文件，缺口 1961 行）
- `packages/desktop/src/main/webRemoteControlManager.ts` — 493
- `packages/ui/src/v4/ConversationComposer.tsx` — 492
- `packages/web/src/main.tsx` — 491
- `packages/ui/src/settings/SourceServerManagementPanel.tsx` — 485

**B9**（4 文件，缺口 1868 行）
- `packages/ui/src/v4/ConversationStatusPanel.tsx` — 479
- `packages/ui/src/PreviewPane.tsx` — 475
- `packages/ui/src/settings/AutomationsSection.tsx` — 462
- `packages/server/src/remote/remoteAssetCache.ts` — 452

**B10**（4 文件，缺口 1676 行）
- `packages/desktop/src/main/autoUpdater.ts` — 428
- `packages/desktop/src/main/desktopRemoteSessions.ts` — 422
- `packages/ui/src/settings/ExternalAgentImportDialog.tsx` — 414
- `packages/shared/src/validation.ts` — 412

## 5. 每批固定动作（与母本第 7 节对齐）

### 5.1 基线

```
d:\code\_annot_baseline\ZC-deep-bN\orig\<相对路径>    # 快照
d:\code\_annot_baseline\ZC-deep-bN\_files.txt         # 本批文件清单（相对仓库根，一行一个）
```

### 5.2 三重校验（缺一不可，全部 fail-closed）

1. **零删除**：`deletedNonZero = 0`。逐文件 `git --no-pager diff --no-index --numstat <基线> <当前>`，
   删除列必须为 0。
2. **语法**：TS/TSX 用 TypeScript compiler API 的 `ts.createSourceFile(...).parseDiagnostics`，
   `syntaxErrorFiles = 0`。**解析器不可用即判失败**（找不到 `typescript` 包时不得跳过）。
3. **密度**：`deep-density.mjs --mode code --threshold 30`，本批每个文件 `measured ≥ 30`
   且 `newComments` 合计等于索引文档自报的 `+行数`。

### 5.3 写作要求（母本 C2 的七类，按 TS 语境落地）

- 文件头 **INV 不变量表**：`INV-nn：<断言>（守住它的位置：<函数/行区间>）`；
- 五个标记前缀按需使用：`[并发]` `[事务]` `[资源]` `[失败路径]` `[权衡]`（TS 无 `unsafe`，第六类不适用；
  React 组件的渲染副作用归入 `[资源]` / `[失败路径]`）；
- 每条必须回答「为什么不能反过来 / 改错了会怎样」，禁止翻译代码；
- 单块 1~6 行，超 6 行说明在讲另一件事，拆块或上移；
- 只新增整行 `//`，新增注释正文不得出现 `*/`；不碰代码 token、缩进、字符串、既有 JSDoc、import 顺序。

### 5.4 冲突处理

- 开工前对每个文件检查 `git status` 与 mtime：最近 30 分钟内被改过、或有未提交改动的文件**剔除本批**，
  记入索引的「顺延」段，下一批重排；
- 批次内被剔除的文件不计入该批的 `+行数`，但仍要在 `ZC-DEEP-bN.md` 里列出并给出去向。

## 6. 索引模板（`docs/annotation/ZC-DEEP-bN.md`）

```markdown
# ZC-DEEP-bN（<主题>）

基线：d:\code\_annot_baseline\ZC-deep-bN\orig｜校验时间：YYYY-MM-DD

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| packages/ui/src/... | 一句话说明该文件在链路中的位置 | INV-01..05 + [事务]/[失败路径] | 0 |

校验 SUMMARY：deletedNonZero=0｜syntaxErrorFiles=0｜files=K｜coreBelow30=0｜needLines=0｜newComments=Σ
顺延：<文件>（原因）
```

## 7. 里程碑定义

| 里程碑 | 判据 |
| --- | --- |
| M0 基线 | 本文档落地，全仓数字与前 40 表可复现 |
| M1 | B1–B10 全部 `coreBelow30=0`，累计 +行数 ≥ 17,000 |
| M2 | 前 40 名全部达标，累计缺口下降到 ≤ 120,000 |
| M3 | `packages/ui/src` 达标（缺口 82,883 → 0） |
| M4 | `apps/zcode-cli/packages/{core,bootstrap,adapters}` 达标 |
| M5 | 本会话范围 `coreBelow30 = 0`（全仓只剩 `packages/services`，由另一会话收口） |

## 8. 执行进展

> 完成度总表与逐批链接维护在 [README-summary.md](./README-summary.md)；本节只记录里程碑判据。

截至 B44（2026-11-07）：

| 指标 | 值 |
| --- | --- |
| 已完成批次 | B1–B44，共 350 个文件 |
| 累计新增注释行 | 71,438 |
| 批次验收 | 全部 `deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`、`needLines=0` |
| 追加自查 | 新增行无代码样式残留（关键字开头 / 行尾分号 / 箭头函数）、锚点均落在语法允许的注释位置 |
| 单批上限 | 注释总量 >1,500 行时拆子批（如 B37-A/B、B38-A/B、B39-A/B），每文件独立 spec 且 ≤150 行，逐文件校验 |
| 推导剩余缺口 | ≈ 70,152 行（基线 141,590 − 已完成 71,438） |
| 当前里程碑 | 完成度 50.5%；节奏 10~12 文件/批、密度卡 31%~33% |

说明：M1 的 17,000 行门槛按 B1–B10 计划缺口给出；实际执行中 B1–B10 的逐个文件缺口与计划表存在少量偏差，
以各批 `ZC-DEEP-bN.md` 的 `added` 为准。B1–B22 的实际累计为 41,144 行，已超过 M1 的量级目标。

B15 实际拆成 b15a（`packages/ui` 视图层 3 文件）与 b15b（远程连接字段 / Bot 弹窗 / debug analyzer 3 文件），
计划缺口 1,824 行，实际新增 1,860 行，逐文件密度 30.03%~32.24%，详见 [ZC-DEEP-b15.md](./ZC-DEEP-b15.md)。

B16 计划 7 文件 / 缺口 1,951 行，实际新增 2,194 行，逐文件密度 30.00%~36.81%，
覆盖桌面主进程实时总线、UI 设置页编排层与开发者文档站单入口，详见 [ZC-DEEP-b16.md](./ZC-DEEP-b16.md)。
B17 开工前对 `taskRealtimeBus.ts` 补厚 10 行（30.00% → 31.03%，避免贴线抖动），B16 累计记为 2,204 行。

B17 计划 7 文件 / 缺口 1,862 行，实际新增 2,146 行，逐文件密度 30.81%~42.48%，
覆盖 browser-client 门面、远程连接向导、模型供应商状态卡、命令中心、v4 工具条、会话分享面板与 context 用量弹层，
详见 [ZC-DEEP-b17.md](./ZC-DEEP-b17.md)。断电中断后的半插入风险已用三重手段排除，全部按基线快照从零重建。

B18 计划 8 文件 / 缺口 1,973 行，实际新增 2,161 行，逐文件密度 31.15%~36.07%，
覆盖窗口级远程连接注册表、composer 附件队列、PPTX 预览、桌面稳定性遥测、形式化验证 UI 与模型、
远端产物安装器与 runtime steering，详见 [ZC-DEEP-b18.md](./ZC-DEEP-b18.md)。

B19 计划 8 文件 / 缺口 1,834 行，实际新增 1,952 行，逐文件密度 31.10%~32.14%，
覆盖会话分叉、远端目录服务、任务查询缓存、日志导出脱敏、旧版遥测对齐桥、任务列表行、Web 远程控制协议
与工作区文件树，详见 [ZC-DEEP-b19.md](./ZC-DEEP-b19.md)。

B20 计划 9 文件 / 缺口 1,921 行（按 5+4 两段并行执行），实际新增 2,251 行，逐文件密度 31.19%~34.19%，
覆盖 CLI fs 适配器、v4 产物投影、Bot schema、插件商店、分享落地页、会话 store 两个切片、
内联 Provider 卡与远程连接对话框，详见 [ZC-DEEP-b20.md](./ZC-DEEP-b20.md)。

B21 计划 9 文件 / 缺口 1,948 行（按 5+4 两段并行执行），实际新增 1,999 行，逐文件密度 31.60%~32.95%，
覆盖 UI 工作台分组 store、桌面 Host 物理连接管理、CLI 协议服务端、侧栏分组项、会话冷恢复水合、
远控 RPC 传输切片、远端 workspace 历史、项目编辑器与模型选择器，详见 [ZC-DEEP-b21.md](./ZC-DEEP-b21.md)。

B22 计划 9 文件 / 缺口 1,878 行（按 4+5 两段并行执行），实际新增 1,797 行，逐文件密度 31.18%~32.39%，
覆盖 SQLite 迁移与组合写事务、权限确认弹窗、工作区头部动作、文档站能力图、图表预览、错峰任务编辑、
主进程远控 IPC 与 Provider 配置服务，详见 [ZC-DEEP-b22.md](./ZC-DEEP-b22.md)。

B23 计划 11 文件，本批取缺口前 8 个 / 缺口 1,431 行（按 4+4 两段并行执行），实际新增 1,513 行，
逐文件密度 31.26%~31.97%，覆盖 Chrome 数据导入、Host 任务投影代际、Provider 门面串行写、
只读代码视图、Web 远控传输、桌面命令分发与强制升级提示窗，详见 [ZC-DEEP-b23.md](./ZC-DEEP-b23.md)。
剩余 3 个文件（`TerminalSession.tsx`、`webElementPickerScript.ts`、`TreemappingPane.tsx`，缺口 527 行）顺延到下一批。

B24 计划 11 文件，本批取缺口前 8 个 / 缺口 1,379 行（按 4+4 两段并行执行），实际新增 1,448 行，
逐文件密度 31.32%~31.44%，覆盖终端 PTY 生命周期、DOM 拾取器注入脚本、文件活动树、远端 MCP 同步弹窗、
本地 Host 进程管理、workspace 文件树加载、CLI 入口与推荐语料，详见 [ZC-DEEP-b24.md](./ZC-DEEP-b24.md)。
剩余 3 个文件（`browser-client/manifest.ts`、`UnifiedBrowserView.tsx`、`useCodingPlanQuotaResetUi.ts`，
缺口 495 行）顺延到下一批。

B25 计划 12 文件，本批取缺口前 8 个（含 B24 顺延 3 个）/ 缺口 1,304 行（按 4+4 两段并行执行），
实际新增 1,388 行，逐文件密度 31.41%~31.54%，覆盖浏览器 API manifest 与 Proxy 门面、webview guest 宿主、
额度重置跨入口对账、Provider 卡片区块、Lexical mention、App 装配入口、文件活动投影与手机远控弹窗，
详见 [ZC-DEEP-b25.md](./ZC-DEEP-b25.md)。剩余 4 个文件顺延到下一批。

B26 计划 11 文件，本批取缺口前 7 个 / 缺口 1,104 行（按 4+3 两段并行执行），
实际新增 1,136 行，逐文件密度 31.43%~31.52%，覆盖媒体预览下载降级、侧栏项目菜单、
Root 工作区动作、分组视图纯函数、WSL 远端后端、代码预览投影与 zcode-server CLI，
详见 [ZC-DEEP-b26.md](./ZC-DEEP-b26.md)。

B27 计划 12 文件，本批取缺口前 8 个 / 缺口 1,199 行（按 4+4 两段并行执行），
实际新增 1,256 行，逐文件密度 31.46%~31.54%，覆盖用量库三表合并语义、v4 会话传输、
电脑控制设置、Provider 导航派生、会话门面、远端部署、设置 schema 与分组列表投影，
详见 [ZC-DEEP-b27.md](./ZC-DEEP-b27.md)。

B28 计划 14 文件，本批取缺口前 8 个 / 缺口 1,145 行（按 4+4 两段并行执行），
实际新增 1,208 行，逐文件密度 31.43%~31.57%，覆盖插件商店详情、MCP UI 状态仓库、
v4 权限 broker 与 wire 重组器、语音选择器、MCP App 保活 fixture 与 Bot provider 卡片，
详见 [ZC-DEEP-b28.md](./ZC-DEEP-b28.md)。

B29 计划 16 文件，本批取 11 文件 / 缺口 1,439 行，实际新增 1,539 行，逐文件密度 31.42%~31.59%，
覆盖 UI 设置页与 `ui/src` 视图组件，详见 [ZC-DEEP-b29.md](./ZC-DEEP-b29.md)。

B30 计划 16 文件，本批取 12 文件 / 缺口 1,525 行（拆 B30-A 6 文件 / B30-B 6 文件），
实际新增 1,641 行，逐文件密度 31.39%~31.54%，覆盖 ai-elements 展示原语、项目侧栏分组视图、
hooks / store / 侧栏用量 / 对话宿主与草稿配置控制，详见 [ZC-DEEP-b30.md](./ZC-DEEP-b30.md)。

B31 计划 14 文件，本批取 12 文件 / 缺口 1,612 行（拆 B31-A 6 文件 / B31-B 6 文件），
实际新增 1,707 行，逐文件密度 31.40%~31.55%，覆盖任务实时通道共享核心、编码套餐与 legacy 协议类型、
遥测事实派生、模型生成流、runtime 事件方法、反馈提交任务、根组件平台副作用、CUA 结果渲染、
MCP App fixture 渲染器、外部编辑器探测与预加载桥，
详见 [ZC-DEEP-b31.md](./ZC-DEEP-b31.md)。
剩余 2 文件（`packages/provider/src/config/model-config.ts`、`session-history-hydrator.ts`，缺口 268 行）顺延到 B32。

B32 计划 16 文件，本批取 12 文件 / 缺口 1,495 行（拆 B32-A 7 文件 / B32-B 5 文件），
实际新增 1,577 行，逐文件密度 31.30%~31.46%，覆盖 Provider 模型能力与访问配置叠加、
会话历史冷恢复水合、消息回滚两阶段、Playwright 链式定位、浏览器命令 schema、
Windows App-Bound 密钥、待确认命令账本、插件 store、edit diff 渲染、代码块展示与编码套餐用量条，
详见 [ZC-DEEP-b32.md](./ZC-DEEP-b32.md)。
剩余 4 文件（`FeatureBoundaryGraphView.tsx`、`gen-ui-fixture/main.ts`、`zcodeAgentDevDeploy.ts`、
`CodingPlanUsageRemainingPanel.tsx`，缺口 486 行）顺延到 B33。

B33 计划 16 文件，本批取 12 文件（全部 `packages/ui`）/ 缺口 1,416 行（拆 B33-A 6 文件 / B33-B 6 文件），
实际新增 1,485 行，逐文件密度 31.30%~31.51%，覆盖模型元数据表单、供应商设置导航与家族三态、
Hook 表单、浏览器设置、办公推荐语料、Toast 队列、轨迹面板、分支切换、插件托管页、
@ 提及面板与编码套餐剩余额度面板，详见 [ZC-DEEP-b33.md](./ZC-DEEP-b33.md)。
剩余 8 文件（缺口 958 行，含 B32 顺延的 3 个非 UI 文件）顺延到 B34。

B34 计划 17 文件，本批取 12 文件（含 B32/B33 全部 8 个顺延）/ 缺口 1,414 行（拆 B34-A 8 文件 / B34-B 4 文件），
实际新增 1,504 行，逐文件密度 31.33%~31.51%，覆盖开发者文档能力边界图、桌面 UI fixture、
开发 agent 远端部署、Chrome Cookie 导入、CLI 权限决策、Electron 页面录制、server supervisor、
协议 v4 传输、已安装插件管理、标签 store、AI 输入框与会话索引 store，
详见 [ZC-DEEP-b34.md](./ZC-DEEP-b34.md)。
剩余 5 文件（缺口 571 行）顺延到 B35。

B35 计划 17 文件，本批取 12 文件（含 B34 全部 5 个顺延）/ 缺口 1,357 行（拆 B35-A 6 文件 / B35-B 6 文件），
实际新增 1,423 行，逐文件密度 31.28%~31.52%，覆盖 MCP App 宿主 fixture、UI 展示回归断言、
远程控制确认中继、Source Server 契约、Office 运行时入口、本地 HTTP 鉴权、遥测一致性 E2E、
分支对话框、项目树节点与侧栏、子代理 store、新手引导，
详见 [ZC-DEEP-b35.md](./ZC-DEEP-b35.md)。
剩余 5 文件（缺口 552 行）顺延到 B36。

B36 计划 18 文件，本批取 12 文件（含 B35 全部 5 个顺延）/ 缺口 1,318 行（拆 B36-A 5 文件 / B36-B 7 文件），
实际新增 1,383 行，逐文件密度 31.28%~31.52%，覆盖分享错误归一化、会话文件摘要面板、窗口外壳与导航策略、
数据体积遥测、SSH 后端、DOM 快照、MCP 表单、任务搜索、文件树模型、营销触达、反馈表单、用量柱状图，
详见 [ZC-DEEP-b36.md](./ZC-DEEP-b36.md)。
剩余 6 文件（缺口 649 行）顺延到 B37。

B37 计划 19 文件，本批取 12 文件（含 B36 全部 6 个顺延）/ 缺口 1,291 行（拆 B37-A 5 文件 / B37-B 7 文件），
实际新增 1,358 行，逐文件密度 31.28%~31.48%，覆盖文件回滚补偿、Office 服务端适配与外壳、shared barrel、
后台任务控件、预览产物归一、用量权益、聊天附件、欢迎页四态、会话队列拖拽、时间线查找、IPC 平台，
详见 [ZC-DEEP-b37.md](./ZC-DEEP-b37.md)。
剩余 7 文件（缺口 738 行）顺延到 B38。

B38 计划 19 文件，本批取 12 文件（含 B37 全部 7 个顺延）/ 缺口 1,253 行（拆 B38-A 6 文件 / B38-B 6 文件），
实际新增 1,312 行，逐文件密度 31.28%~31.51%，覆盖 deep link 安全闸门、网络遥测聚合、本地 tar.gz 解包、
工具条展示、供应商模型元数据、工作流详情、ToolCallBlocks 三个渲染器、功能请求弹窗、提示词编辑器与
ai-elements 分享入口，详见 [ZC-DEEP-b38.md](./ZC-DEEP-b38.md)。
剩余 7 文件（缺口 715 行）顺延到 B39。

B39 计划 19 文件，本批取 12 文件（含 B38 全部 7 个顺延）/ 缺口 1,223 行（拆 B39-A 6 文件 / B39-B 6 文件），
实际新增 1,287 行，逐文件密度 31.27%~31.53%，覆盖白板画布、Git 提交图、助手预览卡、提问解析、
任务变更摘要、文件树行视图、通用 PDF 预览、子代理会话查询、插件管理 store、V4 聊天区、
CLI prompt 命令与 Office PDF 查看器，详见 [ZC-DEEP-b39.md](./ZC-DEEP-b39.md)。
剩余 7 文件（缺口 707 行）顺延到 B40。

B40 计划 19 文件，本批取 12 文件（含 B39 全部 7 个顺延）/ 缺口 1,206 行（三波 5+5+2），
实际新增 1,277 行，逐文件密度 31.27%~31.55%，覆盖端点解析、CLI 遥测初始化、源码服务传输适配、
远程连接表单、窗口控制投影、Bash 工具、CLI 插件适配、Provider 配置解析、侧栏标签触发、
斜杠命令插件、Gen-UI 页面适配与模型轨迹面板，详见 [ZC-DEEP-b40.md](./ZC-DEEP-b40.md)。
剩余 7 文件（缺口 697 行）顺延到 B41。

B41 计划 20 文件，本批取 12 文件（含 B40 全部 7 个顺延）/ 缺口 1,188 行（三波 5+5+2），
实际新增 1,248 行，逐文件密度 31.27%~31.51%，覆盖供应商表单控件、企业编码套餐目录、
运行时方法装配表、新手引导弹窗、计划模式工具、设置页导航、趋势视图数据、崩溃转储捕获、
截图表面协调、已存工作流分组、MCP 索引与会话分享选择面板，详见 [ZC-DEEP-b41.md](./ZC-DEEP-b41.md)。
剩余 8 文件（缺口 782 行）顺延到 B42。

B42 计划 20 文件，本批取 12 文件（含 B41 全部 8 个顺延）/ 缺口 1,168 行（三波 5+5+2），
实际新增 1,230 行，逐文件密度 31.30%~31.55%，覆盖 MCP Apps 采样与展示夹具、外部编辑器打开、
高速轮次指标 store、用量统计 hook、模型轨迹消息、设置页帮助层、思考档位控件、模型选择菜单、
文件类工具摘要、v4 工作台面板与内嵌浏览器部件，详见 [ZC-DEEP-b42.md](./ZC-DEEP-b42.md)。
剩余 8 文件（缺口 764 行）顺延到 B43。

B43 计划 20 文件，本批取 12 文件（含 B42 顺延中的 4 个）/ 缺口 1,138 行（三波 5+5+2），
实际新增 1,190 行，逐文件密度 31.29%~31.50%，覆盖远程连接向导与展示投影、网页元素上下文、
远程同步操作区、错峰任务列表、Hooks 列表、用量热力图、上下文用量组件、附件展示、麦克风选择、
终端面板与开发者工具面板，详见 [ZC-DEEP-b43.md](./ZC-DEEP-b43.md)。
剩余 8 文件（缺口 758 行）顺延到 B44。

B44 计划 20 文件，本批取 12 文件（含 B43 全部 8 个顺延）/ 缺口 1,130 行（三波 5+5+2），
实际新增 1,184 行，逐文件密度 31.28%~31.52%，覆盖 Git 分支切换 hook、演示文稿 PDF 打印导出、
Playwright 执行器、远控设备列表页、插件 UI 宿主控制器、项目树 hook、远程连接选择、TTFT 观测、
v4 交互弹窗、工具身份判定、根级 OAuth 副作用与职业引导弹窗，详见 [ZC-DEEP-b44.md](./ZC-DEEP-b44.md)。
开工前用逐文件基线密度确认 `newComments=0`，排除「输出窗口超限」残留的半插入文件。
剩余 8 文件（缺口 737 行）顺延到 B45。

B45 计划 20 文件，本批取 12 文件（含 B44 全部 8 个顺延）/ 缺口 1,159 行（三波 4+4+4），
实际新增 1,159 行，逐文件密度 31.32%~31.86%，覆盖 Agent 消息历史、TUI 根组件与会话生命周期、
gh 多词只读策略、Bash 权限前缀策略、组件缓存安全解包、手机远控失败页文案、聊天错误横幅、
Chrome 安装探测、测试结果原语、用户操作埋点与 Source 升级通知，
详见 [ZC-DEEP-b45.md](./ZC-DEEP-b45.md)。
上一会话中断在最后 2 个文件前，本次续做前用 `zc-verify` 确认前 10 个文件无半插入残留（`nonCommentAdded=0`）。
剩余 8 个候选留待后续批次复算时重新排序（缺口均约 91 行）。

B46 复算后按「同类同目录优先」取 12 文件 / 缺口 1,071 行（三波 4+4+4），实际新增 1,127 行，
逐文件密度 31.30%~31.56%，覆盖执行状态机、模型失败分类、草稿推荐提示词、工作流工作区卡片、
目录浏览器、Composer 草稿持久化、项目访问令牌客户端、聊天错误归因、远端目录确认、
node_repl 展示模型、权限请求预览与 Chart 组件族，详见 [ZC-DEEP-b46.md](./ZC-DEEP-b46.md)。
开工前 12 文件均为 `newComments=0`，基线干净。

B47 复算后按「同类同目录优先」取 12 文件 / 缺口 1,051 行（三波 4+4+4），实际新增 1,102 行，
逐文件密度 31.25%~31.52%，覆盖文件关联应用探测、浏览器虚拟剪贴板、原生菜单装配、Windows CUA 浮层、
Markdown 图片渲染、营销投放控制器、分享通知卡、图片预览面板、提示词动作菜单、套餐优惠与状态元信息、
只读命令 flag 白名单，详见 [ZC-DEEP-b47.md](./ZC-DEEP-b47.md)。

B48 复算后按「同类同目录优先」取 12 文件 / 缺口 1,031 行（三波 4+4+4），实际新增 1,090 行，
逐文件密度 31.27%~31.48%，覆盖 Edit 工具精确替换、工作流快照生命周期、MCP 图片归一化、
一轮对话方法契约面、助手指令解析、错误遥测归因、工具 diff 文本生成、更新状态弹窗、
assistant 工作项投影、快速选择命令表、TUI 命令中心出口与斜杠命令解析，详见 [ZC-DEEP-b48.md](./ZC-DEEP-b48.md)。

B49 复算后按「同类同目录优先」取 12 文件 / 缺口 1,009 行（三波 4+4+4），实际新增 1,060 行，
逐文件密度 31.23%~31.53%，覆盖内嵌浏览器权限弹层、反馈补充输入、Coding Plan 内嵌 webview、
会话迁移候选卡、变更分组渲染、MCP 结果渲染、工作流结果卡片、assistant 预览卡、任务检索弹窗、
闲时任务存储、v4 协议控制器契约、远程资产部署决策，详见 [ZC-DEEP-b49.md](./ZC-DEEP-b49.md)。

B50 复算后按「同类同目录优先」取 12 文件 / 缺口 980 行（三波 4+4+4），实际新增 1,033 行，
逐文件密度 31.25%~31.55%，覆盖设置页代码预览、环境变量展示、PPTX 元素引用编解码、
连接配置编辑弹窗、提交信息卡片、反馈时间线、轮次导航纯函数、全局工作流分组 hook、
TUI 主视图、配额重置弹窗、响应式浏览器视口、子代理执行方法，详见 [ZC-DEEP-b50.md](./ZC-DEEP-b50.md)。

B51 复算后按「同类同目录优先」取 12 文件 / 缺口 953 行（三波 4+4+4），实际新增 1,000 行，
逐文件密度 31.31%~31.52%，覆盖配额重置协调器、插件商店卡片、会话分享内容、生成式 UI 卡片、
API Key 登录表单、工具调用分派、CUA 步骤分组、工具结果展示纯函数、MCP Apps host 夹具入口与
托管环境、MCP 用户目录、桌面窗口生命周期，详见 [ZC-DEEP-b51.md](./ZC-DEEP-b51.md)。

B52 复算后按「同类同目录优先」取 12 文件 / 缺口 939 行（三波 4+4+4），实际新增 987 行，
逐文件密度 31.23%~31.54%，覆盖本地 TTFT 导出、浏览器命令执行、CUA 授权设置、插件沙箱宿主、
截图活动控制器、浏览器视图 IPC、Finder 打开文件夹工作流、文件树、会话上下文结果、git 解析、
RPC 通道服务端、Docker 远端后端，详见 [ZC-DEEP-b52.md](./ZC-DEEP-b52.md)。

B53 复算后按「同类同目录优先」取 12 文件 / 缺口 927 行（三波 4+4+4），实际新增 969 行，
逐文件密度 31.25%~31.44%，覆盖新建项目编排、页签概览、任务导航历史、后台反馈浮层、
ui_perf 埋点、额度刷新策略、积分页 webview、钩子摘要、远端服务装配、MCP Apps 托管生命周期夹具、
渲染端动作 trace 中转、CLI i18n 类型契约，详见 [ZC-DEEP-b53.md](./ZC-DEEP-b53.md)。

B54 复算后取 12 文件 / 缺口 944 行（三波 4+4+4），实际新增 1,039 行，
逐文件密度 31.27%~31.58%，覆盖流式运行器与本地 HTTP 服务、插件编排、CLI 输入门面、
冷事件合并、MCP 适配、服务端核心 HTTP/WS、ApplyPatch 工具、钩子配置解析、
渲染错误边界、轮次导航、工作流渲染，详见 [ZC-DEEP-b54.md](./ZC-DEEP-b54.md)。

B55 复算后取 12 文件 / 缺口 917 行（三波 4+4+4），实际新增 972 行，
逐文件密度 31.23%~31.60%，覆盖报告查看器、Node REPL 宿主、用量趋势图、PPTX 查看器、
Chrome 可执行文件与配置发现、行内引用、插件资源分组、额度重置 store、模型执行适配、
手机远控 relay 传输、协议遥测校验，详见 [ZC-DEEP-b55.md](./ZC-DEEP-b55.md)。

B56 复算后取 12 文件 / 缺口 880 行（三波 4+4+4），实际新增 926 行，
逐文件密度 31.32%~31.54%，覆盖 Mermaid 渲染、远程重连历史、工具块布局、草稿预热 hook、
压缩时间线持久化、页签崩溃恢复存储、Claude MCP 目录适配、Windows 安装资源锁、
壳层类型契约、Git 图布局、代码评论上下文、自动化格式化，详见 [ZC-DEEP-b56.md](./ZC-DEEP-b56.md)。

B57 复算后取 12 文件 / 缺口 872 行（三波 4+4+4），实际新增 927 行，
逐文件密度 31.23%~31.48%，覆盖报告趋势图、工单列表、选区引用、轨迹明细、供应商模式头、
已保存工作流、会话投影 store、Windows 标题栏菜单、工作流方法门面、Bash 只读策略、
桌面运行时环境解析、工作流侧边面板，详见 [ZC-DEEP-b57.md](./ZC-DEEP-b57.md)。

B58 复算后取 12 文件 / 缺口 855 行（三波 4+4+4），实际新增 901 行，
逐文件密度 31.38%~31.56%，覆盖 Git 图车道布局、远程工作区 tab 生命周期、命令表单、
系统服务注册、内置插件缓存、OTLP 导出、UI 夹具 React 替身、工作流产物侧栏、
机器人摘要卡片、云内容 Hero 展示位、国际化 Provider、会话分享内容规范，
详见 [ZC-DEEP-b58.md](./ZC-DEEP-b58.md)。

B59 复算后取 12 文件 / 缺口 823 行（三波 4+4+4），首轮插入后密度 30.07%~30.40% 贴线，
按 31.3% 目标追加补厚 39 行，最终新增 862 行、密度 31.25%~31.60%，
覆盖 read 工具渲染、工作流片段渲染、agent 会话索引传输、CUA 分组、回合渲染单元、
全局 store 与 hooks store、MCP apps 夹具行数据与组合场景、关于窗口、消息投影策略、
Claude 会话迁移 hook，详见 [ZC-DEEP-b59.md](./ZC-DEEP-b59.md)。

B60 复算后取 12 文件 / 30% 缺口 818 行；本批起目标行数统一按 `round(code × 0.314) − 当前注释行`
计算（不再沿用 30% 口径的 need），最终新增 859 行、密度 31.22%~31.60%，
覆盖编码计划权益 hook、工作区插件预览、资源管理器窗口、renderer 引导、插件承载平面、
会话索引观察者、沙箱别名运行时、下拉菜单、文件引用解析、文件展示、插件启动项、
会话草稿空态，详见 [ZC-DEEP-b60.md](./ZC-DEEP-b60.md)。

B61 复算后取 12 文件 / 30% 缺口 794 行，按 31.4% 口径目标 840 行并精确落地，
实测密度 31.30%~31.60%，覆盖钩子执行器、bash 只读回调、会话上下文读取、动态工作流出口、
脚本工作流工具端口、Gen-UI 契约、子代理 frontmatter、插件管理加载态、侧栏偏好、
语音输入、深链 URL 解析与 Linux 深链注册，详见 [ZC-DEEP-b61.md](./ZC-DEEP-b61.md)。

B62 复算后取 12 文件 / 按 31.4% 口径目标 821 行并精确落地，
实测密度 31.33%~31.63%，覆盖分组任务右键菜单、分组拖拽手势、项目未读信号、
Bot 广播订阅副作用、命令注册表 store、编码计划漏斗埋点、JSX 源码预览、迁移设置区块、
CDP 输入事件翻译、内置浏览器数据导入、桌面资源采样上报与 RPC 通道客户端，
详见 [ZC-DEEP-b62.md](./ZC-DEEP-b62.md)。

B63 复算后取 12 文件 / 按 31.4% 口径目标 815 行并精确落地，
实测密度 31.19%~31.56%，覆盖能力地图视图、CLI 浏览器适配器、TUI 侧栏、MCP apps 夹具渲染进程、
受限表达式解析器、供应商业务码分类、协议消息投影、浏览器交互命令派发、远控用法遥测、
Web 预览组件、会话恢复流程与技能投影 store，详见 [ZC-DEEP-b63.md](./ZC-DEEP-b63.md)。

B64 复算后取 12 文件 / 按 31.4% 口径目标 807 行并精确落地，
实测密度 31.22%~31.63%，覆盖命令中心类型契约、常驻 cron 调度、浏览器视口工具条、远程项目列表、
CUA 列表结果渲染、V4 模式控件、server-cli 控制面契约、在线更新准备、单次模型步、
保存文件 IPC、云端内容弹窗与 MCP 服务器列表，详见 [ZC-DEEP-b64.md](./ZC-DEEP-b64.md)。

B65 复算后取 12 文件 / 按 31.4% 口径目标 792 行并精确落地，
实测密度 31.19%~31.58%，覆盖任务列表观察器注册表、强制更新闸门、package-info 卡片族、
反馈截图选择器、资源管理器外壳、App Usage 面板、agent 工具节点解析、发行目录组装、
后台任务门面、CLI 参数解析、上下文 token 估算与远端组件身份契约，详见 [ZC-DEEP-b65.md](./ZC-DEEP-b65.md)。

B66 复算后取 12 文件 / 按 31.4% 口径目标 787 行并精确落地，
实测密度 31.25%~31.60%，覆盖轮播组件族、模型列表卡渲染、手机远控外壳、工作区头部、
journal 读面契约用例、TUI 事件归约、用量统计协议、子代理目录侧栏、
task 服务实例代理、远程工作区持久化、白板 store 与数字滚动展示，详见 [ZC-DEEP-b66.md](./ZC-DEEP-b66.md)。

B67 复算后取 12 文件 / 按 31.4% 口径目标 741 行，`SavedWorkflowCard.tsx` 首轮 31.00 偏贴线补 2 行，
最终 787 行、实测密度 31.23%~31.88%；覆盖运行阶段脊线、音频播放器、Markdown 文件链接、
变更汇总面板、已保存工作流卡、运行详情卡、额度横幅 hook、配置端口实现、
目标完成校验、集合扩张 planner、远端媒体代理与远端连接封装，详见 [ZC-DEEP-b67.md](./ZC-DEEP-b67.md)。

B68 复算后取 12 文件 / 按 31.4% 口径目标 769 行并一次落地，
实测密度 31.19%~31.60%；覆盖用量折线图、工具摘要单行、调试台共享契约、
MCP Apps 夹具校验、Select 组件族、工单详情、输入触发解析、工具展示投影、
白板纯函数、存储 tab、文件回退弹层与 wire 消息投影，详见 [ZC-DEEP-b68.md](./ZC-DEEP-b68.md)。

B69 复算后取 12 文件 / 按 31.4% 口径目标 762 行并一次落地，
实测密度 31.19%~31.53%；覆盖云媒体 Hero、错误归一化、send_message 详情、
技能渲染器、会话搜索索引、扩散画布、分享预览客户端、浏览器命令翻译、
Bash 读文件提取、关于窗口、子代理档案解析与运行侧栏分区，详见 [ZC-DEEP-b69.md](./ZC-DEEP-b69.md)。

B70 复算后取 12 文件 / 按 31.4% 口径目标 753 行并一次落地，
实测密度 31.16%~31.58%；覆盖 MCP Apps 夹具页面、CEL 求值器、斜杠命令帮助表、
CoT 展示族、Memory 只读列表、子代理快照仓库、吸顶分组头、反馈提交区、
ARMS 埋点、模型选择 hook、分屏布局持久化与 plugins 子命令，详见 [ZC-DEEP-b70.md](./ZC-DEEP-b70.md)。

B71 复算后取 12 文件 / 按 31.4% 口径目标 751 行并一次落地，
实测密度 31.22%~31.50%；覆盖提交图对话框、PPTX 预览引擎、演示元素投影、
浏览器能力文档、tab 驻留协调、远端 Agent 部署、更新弹窗控制器、配额横幅状态、
v4 会话上下文、登录 shell 快照、Goal 续跑核算与 run 保存控件，详见 [ZC-DEEP-b71.md](./ZC-DEEP-b71.md)。

B72 复算后取 12 文件 / 按 31.4% 口径目标 739 行并一次落地，
实测密度 31.19%~31.61%；覆盖 Coding Plan webview、全局工作流分组、工具调用主体、
任务右键动作、能力地图详情、进程入口装配、编辑定位匹配、远程控制中继协议、
应用图标解析、远端连接编排、工具摘要纯函数与向导迁移 hook，详见 [ZC-DEEP-b72.md](./ZC-DEEP-b72.md)。

B73 复算后取 12 文件 / 按 31.4% 口径目标 729 行并一次落地，
实测密度 31.22%~31.61%；覆盖插件宿主保留夹具、清单更新 Provider、沙箱协议解析、
帧统计图表、分组任务窗口化、自动化模板目录、工作区记忆设置、任务操作菜单、
Web OAuth 归一、data root 锁、bash 命令解析与 TUI 按键分发，详见 [ZC-DEEP-b73.md](./ZC-DEEP-b73.md)。

B74 复算后取 12 文件 / 按 31.4% 口径目标 729 行并一次落地，
实测密度 31.19%~31.63%；覆盖体验套餐卡、插件配置控件、商店纯函数层、CodingPlan 展示模型、
会话 store 类型契约、分享选择草稿、工作流清单卡、find 高亮 DOM、CLI 发行装配、
workflow 门面、MCP Apps 宿主夹具与 hook 审核协议，详见 [ZC-DEEP-b74.md](./ZC-DEEP-b74.md)。

B75 复算后取 12 文件 / 按 31.4% 口径目标 712 行并一次落地，
实测密度 31.19%~31.58%；覆盖 git 只读子命令白名单、本地首字时延采样、远端部署互斥锁、
GenUI 沙箱宿主、Web 远程控制入口、轮次工时分段、图表产物预览、provider 菜单、
终端输出块、任务模型恢复、插件 UI 工具卡模型与 task_stop 卡片，详见 [ZC-DEEP-b75.md](./ZC-DEEP-b75.md)。

B76 复算后取 6 文件（单批上限下调到 6，两波 3+3）/ 按 31.4% 口径目标 358 行并一次落地，
实测密度 31.33%~31.63%；覆盖脚本工作流运行时、workspace hook 审核流程、上下文初始化、
TUI 工具流水、队列卡片组件组与桌面顶部浮层，详见 [ZC-DEEP-b76.md](./ZC-DEEP-b76.md)。

B77 复算后取 6 文件 / 按 31.4% 口径目标 351 行并一次落地，
实测密度 31.22%~31.61%；覆盖 Composer 连接切换 hook、子会话分页 hook、内置技能文案映射、
会话 @ 提及 provider、远程连接历史输入框与工具调用文件摘要，详见 [ZC-DEEP-b77.md](./ZC-DEEP-b77.md)。

B78 复算后取 6 文件 / 按 31.4% 口径目标 351 行并一次落地，
实测密度 31.25%~31.47%；覆盖 Git 变更卡片、排队摘要、浏览器缩放把手、CUA 权限观察附件、
GenUI 保留页适配与分支切换展示纯函数，详见 [ZC-DEEP-b78.md](./ZC-DEEP-b78.md)。

B79 复算后取 6 文件 / 按 31.4% 口径目标 349 行并一次落地，
实测密度 31.22%~31.52%；覆盖定时任务与目标工具块、桌面平台能力工厂、协议快照 schema、
模型选择弹层与配额重置动作，详见 [ZC-DEEP-b79.md](./ZC-DEEP-b79.md)。

B80 复算后取 6 文件 / 按 31.4% 口径目标 344 行并一次落地，
实测密度 31.25%~31.56%；覆盖模型供应商与插件清单 Hook、本地归档更新命令与交接重启、
会话分享弹层动作集与工作流保存表单，详见 [ZC-DEEP-b80.md](./ZC-DEEP-b80.md)。

B81 复算后取 6 文件 / 按 31.4% 口径目标 343 行并一次落地，
实测密度 31.33%~31.67%；覆盖桌面菜单双语文案字典、跨进程文件锁、埋点维度白名单与清洗、
错误链投影、覆盖率报告面板与插件引用协议 handler，详见 [ZC-DEEP-b81.md](./ZC-DEEP-b81.md)。

B82 复算后取 6 文件 / 按 31.4% 口径目标 339 行并一次落地，
实测密度 31.15%~31.61%；覆盖侧栏远端同步动作、项目树纯派生、归档管理页、远端会话登记 store、
附件分片上传事务与会话遥测监督器挂载，详见 [ZC-DEEP-b82.md](./ZC-DEEP-b82.md)。

B83 复算后取 6 文件 / 按 31.4% 口径目标 328 行并一次落地，
实测密度 31.22%~31.52%；覆盖远程控制 host 附着、网络指标聚合上报、旧版 MCP 配置只读迁移、
设置同步类型契约、外链手势校验与插件卡片交互夹具，详见 [ZC-DEEP-b83.md](./ZC-DEEP-b83.md)。

B84 复算后取 6 文件 / 按 31.4% 口径目标 331 行并一次落地，
实测密度 31.25%~31.53%；覆盖侧栏用量来源归一、助手 code-comment 指令提取、
tasks-index 归属集合读取与缓存、确认窗可调设置两行、运行设置弹层与厂商设置常量，
详见 [ZC-DEEP-b84.md](./ZC-DEEP-b84.md)。

B85 复算后取 6 文件 / 按 31.4% 口径目标 327 行并一次落地，
实测密度 31.22%~31.67%；覆盖确认对话框唯一宿主、模型轨迹虚拟时间线、
工作区编辑器按钮组、文档预览渲染层、回合 hook 明细气泡与分享成功面板，
详见 [ZC-DEEP-b85.md](./ZC-DEEP-b85.md)。

B86 复算后取 6 文件 / 按 31.4% 口径目标 337 行并一次落地，
实测密度 31.19%~31.52%；覆盖上下文配额重置提醒、高速粒子背景、
插件面板侧栏模型、office 面板双语文案与定位符、云端描述受控渲染、
工作流启动窗，详见 [ZC-DEEP-b86.md](./ZC-DEEP-b86.md)。

B87 复算后取 6 文件 / 按 31.4% 口径目标 325 行并一次落地，
实测密度 31.25%~31.64%；覆盖工作区文件树虚拟列表与吸顶遮罩、
模型与 Provider 规则 schema、归档分组折叠卡、开始计划余额卡、
终端组合输入兜底纯函数、远程项目详情浮层，详见 [ZC-DEEP-b87.md](./ZC-DEEP-b87.md)。

B88 复算后取 6 文件 / 按 31.4% 口径目标 318 行（实际 319，含 1 行补厚）并一次落地，
实测密度 31.15%~31.89%；覆盖输入框计划分组合成、跨平台快捷键、远程连接错误展示分类、
轨迹搜索索引与偏移回填、资源用量指标卡与分组、Rive 角色动画封装，
详见 [ZC-DEEP-b88.md](./ZC-DEEP-b88.md)。

B89 复算后取 6 文件 / 按 31.4% 口径目标 320 行并一次落地，
实测密度 31.15%~31.63%；覆盖设置页分组与分区配置、工作区忽略规则编辑、
模型推理档位编辑器、营销投放 schema 与解析、流式工具输入半截预览、
协议物理分片重组，详见 [ZC-DEEP-b89.md](./ZC-DEEP-b89.md)。

B90 复算后取 6 文件 / 按 31.4% 口径目标 319 行并一次落地，
实测密度 31.28%~31.67%；覆盖命令面板样式封装、只读 Excel 预览、
侧栏项目行装配、设置同步分类勾选、群投递操作栏、预览与目录组合面板，
详见 [ZC-DEEP-b90.md](./ZC-DEEP-b90.md)。

B91 复算后取 6 文件 / 按 31.4% 口径目标 322 行并一次落地，
实测密度 31.18%~31.48%；覆盖 TUI 主布局与建议面板、会话内容渲染、
只读 Excel 查看器、面板抽屉与状态界面、本地模型夹具与行渲染夹具，
详见 [ZC-DEEP-b91.md](./ZC-DEEP-b91.md)。

B92 复算后取 6 文件 / 按 31.4% 口径目标 314 行并一次落地，
实测密度 31.18%~32.11%；覆盖营销触达资源目录、归档任务批量删除入口、
子智能体上下文解析 hook、提示词提及行内节点、只读 DOCX 预览、
网络采集快照页，详见 [ZC-DEEP-b92.md](./ZC-DEEP-b92.md)。

B93 复算后取 6 文件 / 按 31.4% 口径目标 318 行并一次落地，
实测密度 31.28%~31.60%；覆盖持久 Node REPL 工具、git 只读 flag 表、
Bash 语义汇总、崩溃转储注解解析、桌面托盘与未读角标、内置浏览器权限桥，
详见 [ZC-DEEP-b93.md](./ZC-DEEP-b93.md)。

B94 复算后取 6 文件 / 按 31.4% 口径目标 314 行并一次落地，
实测密度 31.28%~31.61%；覆盖换代期传输门面、会话打开埋点、
用户输入消息渲染、竖切聊天区入口、设置页通用部件、登录后家族连接刷新，
详见 [ZC-DEEP-b94.md](./ZC-DEEP-b94.md)。

B95 复算后取 6 文件 / 按 31.4% 口径目标 317 行并一次落地，
实测密度 31.20%~31.44%；覆盖执行结果装配、Bash 执行器探测、模型调用诊断、
Playwright 动作执行、远程 zip 插件源、MCP 用户目录 TOML 读写，
详见 [ZC-DEEP-b95.md](./ZC-DEEP-b95.md)。

B96 复算后取 6 文件 / 按 31.4% 口径目标 302 行并一次落地，
实测密度 31.14%~31.58%；覆盖会话状态选择器、终端面板状态、用户动作目录、
远端工作区投影、侧栏偏好 hook、插件市场源弹窗，
详见 [ZC-DEEP-b96.md](./ZC-DEEP-b96.md)。

B97 复算后取 6 文件 / 按 31.4% 口径目标 325 行并一次落地，
实测密度 31.15%~34.38%；覆盖插件命令输出格式化、内置远端版本同步租约、
Web OAuth 登录编排、同机多连接选择层、发行依赖装配、工具契约 Schema 校验，
详见 [ZC-DEEP-b97.md](./ZC-DEEP-b97.md)。

B98 复算后取 6 文件 / 按 31.4% 口径目标 306 行并一次落地，
实测密度 31.20%~33.14%；覆盖轻量 diff 预览、站脸微动效、时间线主组件与
站头轨道行、产物缩略预览、分享预检诊断，
详见 [ZC-DEEP-b98.md](./ZC-DEEP-b98.md)。

B99 复算后取 6 文件 / 按 31.4% 口径目标 303 行并一次落地，
实测密度 31.38%~32.95%；覆盖轨迹展开正文、任务交互徽标、远控入口、
工具块渲染函数、全局任务列表钩子、闲时任务历史表，
详见 [ZC-DEEP-b99.md](./ZC-DEEP-b99.md)。

B100 复算后取 6 文件 / 按 31.4% 口径目标 295 行并一次落地，
实测密度 31.15%~31.61%；覆盖供应商家族元数据、V4 wire 计量与分片、
观察卡 display schema、任务实时合约、账号 Provider 解析、远控状态展示派生，
详见 [ZC-DEEP-b100.md](./ZC-DEEP-b100.md)。

B101 复算后取 6 文件 / 按 31.4% 口径目标 297 行并一次落地，
实测密度 31.25%~31.81%；覆盖 JSON Schema 发射器与子集校验器、
保存工作流参数表、插件作用域下拉、来源迁移报告面板、workflow run 详情页，
详见 [ZC-DEEP-b101.md](./ZC-DEEP-b101.md)。

B102 复算后取 6 文件 / 按 31.4% 口径目标 303 行并一次落地，
实测密度 31.25%~31.58%；覆盖 workflow 调度器节点结算、截图 CSS 像素校正、
Desktop 构建配置、能力地图节点与连线视图、响应式视口 hook、会话打开埋点载荷，
详见 [ZC-DEEP-b102.md](./ZC-DEEP-b102.md)。

B103 复算后取 6 文件 / 目标 296 行并一次落地，实测密度 31.16%~31.67%；
覆盖文件提及搜索、会话目标表读写、git 只读子命令白名单、定时自动化工具、
代码评论卡片与工作流运行行，详见 [ZC-DEEP-b103.md](./ZC-DEEP-b103.md)。

B104 复算后取 6 文件 / 目标 292 行并一次落地，实测密度 31.21%~31.64%；
覆盖插件页面工具转发、侧栏任务行、代码评论附件 hook、会话输入账本、
插件引用提醒与本地抓包服务，详见 [ZC-DEEP-b104.md](./ZC-DEEP-b104.md)。

B105 复算后取 6 文件 / 目标 283 行并一次落地，实测密度 31.21%~31.43%；
覆盖应用外壳状态与更新就绪监听、任务标题溢出滚动、全局通知存储、
高速分享卡片、工具调用树复用、mention Markdown 序列化与解析，
详见 [ZC-DEEP-b105.md](./ZC-DEEP-b105.md)。

B106 复算后取 6 文件 / 目标 284 行并一次落地，实测密度 31.29%~31.58%；
覆盖 TUI 语法高亮 diff 视图、knip 插件参考文档生成、桌面运行时交互探针、
托管模型夹具检查、cron scheduler 进程托管、插件沙箱注册表，
详见 [ZC-DEEP-b106.md](./ZC-DEEP-b106.md)。

B107 复算后取 6 文件 / 目标 294 行，落地 285 行，实测密度 31.28%~31.63%；
覆盖内置 Provider 配置来源、MCP 类型与 CUA 识别、远控中继 V2 契约、
确认窗设置零件、配置文件路径 hook、存储分类详情，
详见 [ZC-DEEP-b107.md](./ZC-DEEP-b107.md)。

B108 复算后取 6 文件 / 目标 285 行并一次落地，实测密度 31.21%~31.90%；
覆盖供应商模板选择页、运行记录工具卡、只读命令 flag 白名单、闲时任务工具、
iOS 模拟器 MCP 服务、docx 分页查看器；其中 shebang 文件的文件头插在首行之后，
其余文件仍从首行前插入，详见 [ZC-DEEP-b108.md](./ZC-DEEP-b108.md)。

B109 复算后取 6 文件 / 目标 276 行并一次落地，实测密度 31.25%~31.64%；
覆盖终端选区弹层、带确认远控中继契约、桌面上下文提示开关、
内嵌浏览器原生弹窗接管、本地首字耗时转跨度、数据库启动状态契约，
详见 [ZC-DEEP-b109.md](./ZC-DEEP-b109.md)。

B110 复算后取 6 文件 / 目标 277 行，落地 276 行，实测密度 31.10%~31.68%；
覆盖计划工具解析适配器、Start Plan 余额面板、统一差异查看器、
群任务状态同步、任务终态与交互通知、远程连接向导外壳；
其中余额面板初始 32.22% 已删 1 行新增注释回调，
详见 [ZC-DEEP-b110.md](./ZC-DEEP-b110.md)。

B111 复算后取 6 文件 / 目标 275 行，落地 273 行，实测密度 31.08%~31.61%；
覆盖数据库启动加载界面、MCP 配置与表单互转、远程技能同步候选列表、
任务计划面板、检索类工具卡、会话额度告警横幅；
其中计划面板与同步列表各超 32% 已删 1 行新增注释回调，
详见 [ZC-DEEP-b111.md](./ZC-DEEP-b111.md)。

B112 复算后取 6 文件 / 目标 278 行，落地 281 行，实测密度 31.31%~31.74%；
覆盖标题栏帮助菜单、OAuth state 编解码、本地服务卸载、自定义命令发现与读取、
插件 MCP 服务器汇总、插件 UI 协议入口；
原第 6 项为子进程源码字符串，插入注释会改字符串故顺延，详见 [ZC-DEEP-b112.md](./ZC-DEEP-b112.md)。

B113 复算后取 6 文件 / 目标 294 行并一次落地，实测密度 31.28%~31.63%；
覆盖 /plugins 子命令与选择器、运行时核心方法类型契约、computer-use 桥接、
遥测 span 运行时、输入区状态行、模型候选浮层，
详见 [ZC-DEEP-b113.md](./ZC-DEEP-b113.md)。

B114 复算后取 6 文件 / 目标 270 行并一次落地，实测密度 31.25%~31.69%；
覆盖插件沙箱 retention 压测 fixture、未读角标换算与任务栏 overlay、
数据目录字节统计、Provider 与 Model 配置解析、反馈文本脱敏管道、GenUI tweak 协议；
首选项为子进程源码字符串，插入注释会改字符串故顺延，详见 [ZC-DEEP-b114.md](./ZC-DEEP-b114.md)。

B115 复算后取 6 文件 / 目标 274 行并一次落地，实测密度 31.21%~31.61%；
覆盖项目访问令牌缓存、远端使用埋点、网络调试状态事件、旧协议可见消息投影、
workflow 运行目录侧边页、聊天媒体附件预览；
首选项为子进程源码字符串，插入注释会改字符串故顺延，详见 [ZC-DEEP-b115.md](./ZC-DEEP-b115.md)。

B116 复算后取 6 文件 / 目标 271 行并一次落地，实测密度 31.13%~31.51%；
覆盖带高亮的轻量 diff 预览、时间线边檐与滚动条、反馈元数据、
标签页持久化、工作区活动任务状态、自动化埋点；
首选项为子进程源码字符串，插入注释会改字符串故顺延，详见 [ZC-DEEP-b116.md](./ZC-DEEP-b116.md)。

B117 复算后取 6 文件 / 目标 297 行并一次落地，实测密度 31.08%~31.69%；
覆盖最近提交偏好存取、文件图标名称解析、工作区文件拖拽载荷、
侧边栏类型契约、分组视图顶层虚拟化、工作区壳层组合根；
首选项为子进程源码字符串，插入注释会改字符串故顺延，详见 [ZC-DEEP-b117.md](./ZC-DEEP-b117.md)。

B118 复算后取 6 文件 / 目标 263 行并一次落地，实测密度 31.08%~31.40%；
覆盖插件能力投影、快捷键设置分区、添加市场源弹窗、资源头部操作区、
使用统计展示部件、项目节点排序与拖入；
首选项为子进程源码字符串，插入注释会改字符串故顺延，详见 [ZC-DEEP-b118.md](./ZC-DEEP-b118.md)。

B119 复算后取 6 文件 / 目标 263 行并一次落地，实测密度 31.08%~31.64%；
覆盖终端 HTTP 链接定位、shell 探查判定、系统服务与内网探测 hooks、
远端身份悬停卡、CUA 详情卡、待办折叠卡；
首选项为子进程源码字符串，插入注释会改字符串故顺延，详见 [ZC-DEEP-b119.md](./ZC-DEEP-b119.md)。

B120a 复算后取 4 文件 / 目标 192 行并一次落地，实测密度 31.25%~31.58%；
覆盖时间线补全渲染、Git 差异预览降级、更新状态入口、闲时任务入口；
原 6 文件批量按步数预算拆为 B120a（4）+ B120b（2），详见 [ZC-DEEP-b120a.md](./ZC-DEEP-b120a.md)。

B120b 为拆分后的第二子批，2 文件 / 目标 85 行，实测密度 31.11%~31.62%；
覆盖机器人弹窗共享工具与输入组样式封装，详见 [ZC-DEEP-b120b.md](./ZC-DEEP-b120b.md)。

B121 复算后取 4 文件 / 目标 176 行并一次落地，实测密度 31.37%~31.60%；
覆盖助手展示投影、工作区文件模糊搜索、聊天准备错误、补丁降级预览，详见 [ZC-DEEP-b121.md](./ZC-DEEP-b121.md)。

B122 复算后取 4 文件 / 目标 171 行并一次落地，实测密度 31.11%~31.72%；
覆盖 PDF 缩放比例与叠加层、工作流保存弹层、反馈展示层、远端连接日志 hook，详见 [ZC-DEEP-b122.md](./ZC-DEEP-b122.md)。

B122 开工前修正了 README §3 的口径错误：旧「剩余 3,566 文件 / 28,573 行」分别是
「未注释文件数」与「基线减新增行」的推导值，不是缺口；实测本会话范围为
`files=4562 coreBelow30=2224 needLines=34401`（全仓 `files=5032 coreBelow30=2229 needLines=39010`）。
此后完成度一律以 `zc-measure.mjs` 实测为准，不再用减法推导。

B123 复算后取 4 文件 / 目标 173 行并一次落地，实测密度 31.23%~31.55%；
覆盖侧栏分区编排、远端连接进度、断线横幅与草稿回显、SaveWorkflow 确认块，详见 [ZC-DEEP-b123.md](./ZC-DEEP-b123.md)。

B123 起在 README §4 增加「范围声明与总账断言」，并用
`d:\code\_annot_baseline\ledger-check.mjs zcode` 固化：
`scopeFiles 4562 + excludedFiles 555 = 全仓源码 5117`（PASS）。
该断言暴露了此前密度分母未覆盖的 85 个文件（`.agents/**` 83 + 根 `vitest.config.ts`/`vitest.setup.ts` 2），
已在 excluded 中显式登记，不再隐身；密度分母仍为 5032 = 4562 + services 466 + L0 字典 4。

B124 复算后取 4 文件 / 目标 169 行并一次落地，实测密度 31.08%~31.22%；
覆盖任务通知载荷编排、MCP 存储辅助、CUA 结果解析与磁盘占用卡片，详见 [ZC-DEEP-b124.md](./ZC-DEEP-b124.md)。
落地后全仓复扫 `files=5032 coreBelow30=2220 needLines=38665 median=31.23`；
本会话范围 `files=4562 coreBelow30=2216 needLines=34073`，累计 1,008 文件 / 113,530 行。

B125 取 4 文件 / 目标 177 行并一次落地，实测密度 31.25%~31.51%；
覆盖用量快照投影、bash 只读策略表、TUI 提交落地与剪贴板图片读取，详见 [ZC-DEEP-b125.md](./ZC-DEEP-b125.md)。
落地后全仓复扫 `files=5032 coreBelow30=2216 needLines=38499 median=31.25`；
本会话范围 `files=4562 coreBelow30=2212 needLines=33907`，累计 1,012 文件 / 113,707 行。

B126 取 4 文件 / 目标 171 行并一次落地，实测密度 31.21%~31.65%；
覆盖 E2E 报告共享类型、docker 探测、CLI Provider 运行环境与桌面 ARMS 事件环，详见 [ZC-DEEP-b126.md](./ZC-DEEP-b126.md)。
落地后全仓复扫 `files=5032 coreBelow30=2212 needLines=38335 median=31.25`；
本会话范围 `files=4562 coreBelow30=2208 needLines=33743`，累计 1,016 文件 / 113,878 行。

B127 取 4 文件 / 目标 184 行并一次落地，实测密度 31.33%~31.69%；
覆盖 SQLite 迁移备份、工作区会话重建、插件沙箱 guest 策略与个人 Provider 配置仓库，详见 [ZC-DEEP-b127.md](./ZC-DEEP-b127.md)。
落地后全仓复扫 `files=5032 coreBelow30=2208 needLines=38174 median=31.25`；
本会话范围 `files=4562 coreBelow30=2204 needLines=33582`，累计 1,020 文件 / 114,062 行。

B128 取 4 文件 / 目标 173 行并一次落地，实测密度 31.32%~31.64%；
覆盖 Gen UI 夹具渲染、设置服务缓存、会话库迁移执行与 TUI 提问状态机，详见 [ZC-DEEP-b128.md](./ZC-DEEP-b128.md)。
落地后全仓复扫 `files=5032 coreBelow30=2204 needLines=38013 median=31.25`；
本会话范围 `files=4562 coreBelow30=2200 needLines=33421`，累计 1,024 文件 / 114,235 行。

B129 取 4 文件 / 目标 170 行并一次落地，实测密度 31.17%~31.60%；
覆盖 Grep 工具、工作区文本生成、模型配置同步与错误横幅遥测，详见 [ZC-DEEP-b129.md](./ZC-DEEP-b129.md)。
落地后全仓复扫 `files=5032 coreBelow30=2200 needLines=37852 median=31.25`；
本会话范围 `files=4562 coreBelow30=2196 needLines=33260`，累计 1,028 文件 / 114,405 行。

B130 取 4 文件 / 目标 176 行并一次落地，实测密度 31.22%~31.48%；
覆盖 Provider 配置运行时、PPTX 文件监听、工作流看板折叠与企业套餐目录加载，详见 [ZC-DEEP-b130.md](./ZC-DEEP-b130.md)。
落地后全仓复扫 `files=5032 coreBelow30=2196 needLines=37692 median=31.25`；
本会话范围 `files=4562 coreBelow30=2192 needLines=33100`，累计 1,032 文件 / 114,581 行。

B131 取 4 文件 / 目标 174 行并一次落地，实测密度 31.33%~31.65%；
覆盖 Provider 反馈条、模型顺序拖拽、来源服务器更新活动与独立登录态 Provider 运行时桥，详见 [ZC-DEEP-b131.md](./ZC-DEEP-b131.md)。
落地后全仓复扫 `files=5032 coreBelow30=2192 needLines=37529 median=31.25`；
本会话范围 `files=4562 coreBelow30=2188 needLines=32937`，累计 1,036 文件 / 114,755 行。

B132 取 4 文件 / 目标 168 行并一次落地，实测密度 31.11%~31.54%；
覆盖工作流产物正文分派、确认弹窗包装、工作区服务解析与首页工作区列表，详见 [ZC-DEEP-b132.md](./ZC-DEEP-b132.md)。
落地后全仓复扫 `files=5032 coreBelow30=2188 needLines=37369 median=31.25`；
本会话范围 `files=4562 coreBelow30=2184 needLines=32777`，累计 1,040 文件 / 114,923 行。

B133 取 3 文件 / 目标 130 行并一次落地，实测密度 31.27%~31.34%；
覆盖工作流运行确认块、浏览器站点权限页与闲时创建卡片，详见 [ZC-DEEP-b133.md](./ZC-DEEP-b133.md)。
落地后全仓复扫 `files=5032 coreBelow30=2185 needLines=37249 median=31.25`；
本会话范围 `files=4562 coreBelow30=2181 needLines=32657`，累计 1,043 文件 / 115,053 行。

B134 取 3 文件 / 目标 121 行并一次落地，实测密度 31.11%~31.30%；
覆盖侧边栏标签展示、后台 bash 输出面板与远程控制连接过程页，详见 [ZC-DEEP-b134.md](./ZC-DEEP-b134.md)。
落地后全仓复扫 `files=5032 coreBelow30=2182 needLines=37131 median=31.25`；
本会话范围 `files=4562 coreBelow30=2178 needLines=32539`，累计 1,046 文件 / 115,174 行。

B135 取 3 文件 / 目标 120 行并一次落地，实测密度 31.25%~31.50%；
覆盖 WSL 探测与代理地址工具、受限 CEL 词法分析，详见 [ZC-DEEP-b135.md](./ZC-DEEP-b135.md)。
落地后全仓复扫 `files=5032 coreBelow30=2179 needLines=37014 median=31.25`；
本会话范围 `files=4562 coreBelow30=2175 needLines=32422`，累计 1,049 文件 / 115,294 行。

B136 取 4 文件 / 目标 165 行并一次落地，实测密度 31.21%~31.51%；
覆盖通用弹窗包装、运行脊线展示件、时间线轨道层与 Git 自动刷新，详见 [ZC-DEEP-b136.md](./ZC-DEEP-b136.md)。
落地后全仓复扫 `files=5032 coreBelow30=2175 needLines=36858 median=31.25`；
本会话范围 `files=4562 coreBelow30=2171 needLines=32266`，累计 1,053 文件 / 115,459 行。

B137 取 4 文件 / 目标 170 行并一次落地，实测密度 31.22%~31.52%；
覆盖配置 hook 进程执行、/rewind 编排、Agent 工具入口与 effort 建议面板，详见 [ZC-DEEP-b137.md](./ZC-DEEP-b137.md)。
落地后全仓复扫 `files=5032 coreBelow30=2171 needLines=36702 median=31.25`；
本会话范围 `files=4562 coreBelow30=2167 needLines=32110`，累计 1,057 文件 / 115,629 行。

B138 取 4 文件 / 目标 177 行并一次落地，实测密度 31.27%~31.63%；
覆盖 CLI 配置 schema、Android MCP 入口、工作流配置字段与 MCP 资源采样源，详见 [ZC-DEEP-b138.md](./ZC-DEEP-b138.md)。
落地后全仓复扫 `files=5032 coreBelow30=2167 needLines=36541 median=31.25`；
本会话范围 `files=4562 coreBelow30=2163 needLines=31949`，累计 1,061 文件 / 115,806 行。

B139 取 4 文件 / 目标 191 行并一次落地，实测密度 31.21%~31.54%；
覆盖渲染进程动作追踪 IPC、Provider 注册服务、注册表视图与演示页，详见 [ZC-DEEP-b139.md](./ZC-DEEP-b139.md)。
落地后全仓复扫 `files=5032 coreBelow30=2163 needLines=36385 median=31.26`；
本会话范围 `files=4562 coreBelow30=2159 needLines=31793`，累计 1,065 文件 / 115,997 行。

B140 取 4 文件 / 目标 161 行并一次落地，实测密度 30.71%~31.58%；
覆盖网页元素选择 hook、推荐插件适配器、模型配置解析与用量饼图，详见 [ZC-DEEP-b140.md](./ZC-DEEP-b140.md)。
落地后全仓复扫 `files=5032 coreBelow30=2159 needLines=36229 median=31.27`；
本会话范围 `files=4562 coreBelow30=2155 needLines=31637`，累计 1,069 文件 / 116,158 行。

B141 取 4 文件 / 目标 163 行并一次落地，实测密度 31.08%~31.61%；
覆盖自动化设置基础组件、计划指导渲染、网页元素附件 hook 与分享预检缓存，详见 [ZC-DEEP-b141.md](./ZC-DEEP-b141.md)。
落地后全仓复扫 `files=5032 coreBelow30=2155 needLines=36073 median=31.27`；
本会话范围 `files=4562 coreBelow30=2151 needLines=31481`，累计 1,073 文件 / 116,321 行。

B142 取 4 文件 / 目标 167 行并一次落地，实测密度 31.33%~31.58%；
覆盖页面快照、命令 shell 展开、子代理加载与 Node REPL 会话，详见 [ZC-DEEP-b142.md](./ZC-DEEP-b142.md)。
落地后全仓复扫 `files=5032 coreBelow30=2151 needLines=35921 median=31.27`；
本会话范围 `files=4562 coreBelow30=2147 needLines=31329`，累计 1,077 文件 / 116,488 行。

B143 取 4 文件 / 目标 162 行并一次落地，实测密度 31.25%~31.60%；
覆盖助手预览卡片派生、工作区 fork、持久记忆提示词与模式候选浮层，详见 [ZC-DEEP-b143.md](./ZC-DEEP-b143.md)。
落地后全仓复扫 `files=5032 coreBelow30=2147 needLines=35768 median=31.27`；
本会话范围 `files=4562 coreBelow30=2143 needLines=31176`，累计 1,081 文件 / 116,650 行。

B144 取 4 文件 / 目标 165 行并一次落地，实测密度 31.19%~31.78%；
覆盖导出页独立校验、浏览器控制桥、远端工作区服务集合与桌面网络策略，详见 [ZC-DEEP-b144.md](./ZC-DEEP-b144.md)。
落地后全仓复扫 `files=5032 coreBelow30=2143 needLines=35616 median=31.28`；
本会话范围 `files=4562 coreBelow30=2139 needLines=31024`，累计 1,085 文件 / 116,815 行。

B145 取 4 文件 / 目标 156 行并一次落地，实测密度 31.20%~31.50%；
覆盖旧档位改名表、Provider 配置编解码、渠道提及与渲染动作追踪协议，详见 [ZC-DEEP-b145.md](./ZC-DEEP-b145.md)。
落地后全仓复扫 `files=5032 coreBelow30=2139 needLines=35464 median=31.28`；
本会话范围 `files=4562 coreBelow30=2135 needLines=30872`，累计 1,089 文件 / 116,971 行。

B146 取 4 文件 / 目标 163 行并一次落地，实测密度 31.11%~31.45%；
覆盖 Bot 工作区访问卡、工作流 run 摘要卡、反馈时间线摘要翻译与生成式界面调参面板，详见 [ZC-DEEP-b146.md](./ZC-DEEP-b146.md)。
落地后全仓复扫 `files=5032 coreBelow30=2135 needLines=35312 median=31.28`；
本会话范围 `files=4562 coreBelow30=2131 needLines=30720`，累计 1,093 文件 / 117,134 行。

B147 取 4 文件 / 目标 158 行并一次落地，实测密度 31.20%~31.58%；
覆盖 Mermaid 渲染预算、Office 预览识别与链接净化、插件页面生命周期管理与 Office 预览组合，详见 [ZC-DEEP-b147.md](./ZC-DEEP-b147.md)。
落地后全仓复扫 `files=5032 coreBelow30=2131 needLines=35160 median=31.28`；
本会话范围 `files=4562 coreBelow30=2127 needLines=30568`，累计 1,097 文件 / 117,292 行。

B148 取 4 文件 / 目标 158 行并一次落地，实测密度 31.20%~31.54%；
覆盖远端连接进度卡、数据目录设置控件、代码评论预览 store 与插件启停乐观更新，详见 [ZC-DEEP-b148.md](./ZC-DEEP-b148.md)。
落地后全仓复扫 `files=5032 coreBelow30=2127 needLines=35008 median=31.28`；
本会话范围 `files=4562 coreBelow30=2123 needLines=30416`，累计 1,101 文件 / 117,450 行。

B149 取 4 文件 / 目标 157 行并一次落地，实测密度 31.11%~31.58%；
覆盖 TaskOutput 工具块、对话选区引用菜单、用户输入正文折叠与建议提示轮换，详见 [ZC-DEEP-b149.md](./ZC-DEEP-b149.md)。
落地后全仓复扫 `files=5032 coreBelow30=2123 needLines=34856 median=31.28`；
本会话范围 `files=4562 coreBelow30=2119 needLines=30264`，累计 1,105 文件 / 117,607 行。

B150 取 4 文件 / 目标 160 行并一次落地，实测密度 31.35%~31.68%；
覆盖分屏分隔条、发布包下载、服务器核心启动与能力地图 ELK 布局，详见 [ZC-DEEP-b150.md](./ZC-DEEP-b150.md)。
落地后全仓复扫 `files=5032 coreBelow30=2119 needLines=34705 median=31.28`；
本会话范围 `files=4562 coreBelow30=2115 needLines=30113`，累计 1,109 文件 / 117,767 行。

B151 处理 1,361 行的 `turn.ts`（单独成批，1 文件 / 目标 55 行），实测密度 31.42%；详见 [ZC-DEEP-b151.md](./ZC-DEEP-b151.md)。
落地后全仓复扫 `files=5032 coreBelow30=2118 needLines=34665 median=31.28`；
本会话范围 `files=4562 coreBelow30=2114 needLines=30073`，累计 1,110 文件 / 117,822 行。

B152 取 4 文件 / 目标 162 行并一次落地，实测密度 31.35%~31.47%；
覆盖单轮状态机、workflow 通知文案、会话标题旁路与 git 运行时安全，详见 [ZC-DEEP-b152.md](./ZC-DEEP-b152.md)。
落地后全仓复扫 `files=5032 coreBelow30=2114 needLines=34517 median=31.28`；
本会话范围 `files=4562 coreBelow30=2110 needLines=29925`，累计 1,114 文件 / 117,984 行。

B153 取 4 文件 / 目标 157 行并一次落地，实测密度 31.19%~31.71%；
覆盖 exec 输出编码、commands 子命令、远端资产预检与云端内容 schema，详见 [ZC-DEEP-b153.md](./ZC-DEEP-b153.md)。
落地后全仓复扫 `files=5032 coreBelow30=2110 needLines=34369 median=31.28`；
本会话范围 `files=4562 coreBelow30=2106 needLines=29777`，累计 1,118 文件 / 118,141 行。

B154 取 4 文件 / 目标 155 行并一次落地，实测密度 31.10%~31.50%；
覆盖截图 surface 就绪验证、控件提示、内置浏览器 URL 工具与会话滚动记忆，详见 [ZC-DEEP-b154.md](./ZC-DEEP-b154.md)。
落地后全仓复扫 `files=5032 coreBelow30=2106 needLines=34221 median=31.28`；
本会话范围 `files=4562 coreBelow30=2102 needLines=29629`，累计 1,122 文件 / 118,296 行。

B155 取 4 文件 / 目标 152 行并一次落地，实测密度 31.08%~31.40%；
覆盖模式切换回包守卫、提及搜索、分组任务行与工作区 hooks 行内信任，详见 [ZC-DEEP-b155.md](./ZC-DEEP-b155.md)。
落地后全仓复扫 `files=5032 coreBelow30=2102 needLines=34073 median=31.28`；
本会话范围 `files=4562 coreBelow30=2098 needLines=29481`，累计 1,126 文件 / 118,448 行。

B156 取 4 文件 / 目标 155 行并一次落地，实测密度 31.15%~31.78%；
覆盖 switch_mode 计划卡片、会话选择引用、TTFT 结算记录与会话调试旁路，详见 [ZC-DEEP-b156.md](./ZC-DEEP-b156.md)。
落地后全仓复扫 `files=5032 coreBelow30=2098 needLines=33926 median=31.29`；
本会话范围 `files=4562 coreBelow30=2094 needLines=29334`，累计 1,130 文件 / 118,603 行。

B157 取 4 文件 / 目标 163 行并一次落地，实测密度 31.36%~31.62%；
覆盖标题生成旁路、后台任务追踪、推文正文改写与 sampling 夹具检查，详见 [ZC-DEEP-b157.md](./ZC-DEEP-b157.md)。
落地后全仓复扫 `files=5032 coreBelow30=2094 needLines=33782 median=31.29`；
本会话范围 `files=4562 coreBelow30=2090 needLines=29190`，累计 1,134 文件 / 118,766 行。

B158 取 4 文件 / 目标 154 行并一次落地，实测密度 31.29%~31.68%；
覆盖 Source Server 管理服务、任务实时桥、数据库启动遥测与远程资产 CDN，详见 [ZC-DEEP-b158.md](./ZC-DEEP-b158.md)。
落地后全仓复扫 `files=5032 coreBelow30=2090 needLines=33638 median=31.29`；
本会话范围 `files=4562 coreBelow30=2086 needLines=29046`，累计 1,138 文件 / 118,920 行。

B159 取 4 文件 / 目标 151 行并一次落地，实测密度 31.28%~31.75%；
覆盖传输运行时、反馈工单共享类型、营销横幅与翻页数字组件，详见 [ZC-DEEP-b159.md](./ZC-DEEP-b159.md)。
落地后全仓复扫 `files=5032 coreBelow30=2086 needLines=33494 median=31.29`；
本会话范围 `files=4562 coreBelow30=2082 needLines=28902`，累计 1,142 文件 / 119,071 行。

B160 取 4 文件 / 目标 150 行并一次落地，实测密度 30.86%~31.62%；
覆盖 Shiki 高亮缓存、文件引用投影、会话事件排序闸门与工作流保存控制器，详见 [ZC-DEEP-b160.md](./ZC-DEEP-b160.md)。
落地后全仓复扫 `files=5032 coreBelow30=2082 needLines=33350 median=31.29`；
本会话范围 `files=4562 coreBelow30=2078 needLines=28758`，累计 1,146 文件 / 119,221 行。

B161 取 4 文件 / 目标 154 行并一次落地，实测密度 31.09%~31.58%；
覆盖工作流基本信息表单、运行历史列表、远程控制失败页与 CLI 产物存储适配器，详见 [ZC-DEEP-b161.md](./ZC-DEEP-b161.md)。
落地后全仓复扫 `files=5032 coreBelow30=2078 needLines=33207 median=31.30`；
本会话范围 `files=4562 coreBelow30=2074 needLines=28615`，累计 1,150 文件 / 119,375 行。

B162 取 4 文件 / 目标 147 行并一次落地，实测密度 31.13%~31.43%；
覆盖工作流脚本子进程宿主、OAuth 登录主流程、/login 选择器与 slash 命令类型，详见 [ZC-DEEP-b162.md](./ZC-DEEP-b162.md)。
落地后全仓复扫 `files=5032 coreBelow30=2074 needLines=33067 median=31.30`；
本会话范围 `files=4562 coreBelow30=2070 needLines=28475`，累计 1,154 文件 / 119,522 行。

B163 取 4 文件 / 目标 153 行并一次落地，实测密度 31.06%~31.35%；
覆盖 runtime 依赖门面、工具结果展示投影、Bash 输出映射与 git 破坏性操作判定，详见 [ZC-DEEP-b163.md](./ZC-DEEP-b163.md)。
落地后全仓复扫 `files=5032 coreBelow30=2070 needLines=32927 median=31.30`；
本会话范围 `files=4562 coreBelow30=2066 needLines=28335`，累计 1,158 文件 / 119,675 行。

B164 取 4 文件 / 目标 149 行并一次落地，实测密度 31.30%~31.39%；
覆盖产物「作为文件打开」按钮、产物索引、完成卡与套餐入口清单 hook，详见 [ZC-DEEP-b164.md](./ZC-DEEP-b164.md)。
落地后全仓复扫 `files=5032 coreBelow30=2066 needLines=32787 median=31.30`；
本会话范围 `files=4562 coreBelow30=2062 needLines=28195`，累计 1,162 文件 / 119,824 行。

B165 取 4 文件 / 目标 146 行并一次落地，实测密度 31.15%~31.58%；
覆盖统一风格校验、托管式 MCP 应用夹具、存储清理检查与 Source Server 发行包解析器，详见 [ZC-DEEP-b165.md](./ZC-DEEP-b165.md)。
落地后全仓复扫 `files=5032 coreBelow30=2062 needLines=32647 median=31.30`；
本会话范围 `files=4562 coreBelow30=2058 needLines=28055`，累计 1,166 文件 / 119,970 行。

B166 取 4 文件 / 目标 147 行并一次落地，实测密度 31.03%~31.78%；
覆盖任务分组 hook、账号连接失效通知、工作区钩子审核命令与侧栏远程连接详情，详见 [ZC-DEEP-b166.md](./ZC-DEEP-b166.md)。
落地后全仓复扫 `files=5032 coreBelow30=2058 needLines=32507 median=31.30`；
本会话范围 `files=4562 coreBelow30=2054 needLines=27915`，累计 1,170 文件 / 120,117 行。

B167 取 4 文件 / 目标 152 行并一次落地，实测密度 31.29%~31.58%；
覆盖遥测错误清洗器、TUI 文件提及控制器、macOS 授权引导 IPC 与帧率预测，详见 [ZC-DEEP-b167.md](./ZC-DEEP-b167.md)。
落地后全仓复扫 `files=5032 coreBelow30=2054 needLines=32367 median=31.30`；
本会话范围 `files=4562 coreBelow30=2050 needLines=27775`，累计 1,174 文件 / 120,269 行。

B168 取 4 文件 / 目标 155 行并一次落地，实测密度 31.30%~31.52%；
覆盖执行适配器基类、模型 I/O 诊断落盘、脚本工作流明细仓储与旧 CLI 提供方迁移，详见 [ZC-DEEP-b168.md](./ZC-DEEP-b168.md)。
落地后全仓复扫 `files=5032 coreBelow30=2050 needLines=32231 median=31.30`；
本会话范围 `files=4562 coreBelow30=2046 needLines=27639`，累计 1,178 文件 / 120,424 行。

B169 取 4 文件 / 目标 154 行并一次落地，实测密度 31.21%~31.62%；
覆盖 UI 包公共出口、内嵌浏览器视口外壳、工具卡片与转写段落组件，详见 [ZC-DEEP-b169.md](./ZC-DEEP-b169.md)。
落地后全仓复扫 `files=5032 coreBelow30=2046 needLines=32094 median=31.30`；
本会话范围 `files=4562 coreBelow30=2042 needLines=27502`，累计 1,182 文件 / 120,578 行。

B170 取 4 文件 / 目标 142 行并一次落地，实测密度 31.25%~31.53%；
覆盖简化反馈提交、插件引用目录 hook、任务侧栏内存与时间线身份键，详见 [ZC-DEEP-b170.md](./ZC-DEEP-b170.md)。
落地后全仓复扫 `files=5032 coreBelow30=2042 needLines=31958 median=31.30`；
本会话范围 `files=4562 coreBelow30=2038 needLines=27366`，累计 1,186 文件 / 120,720 行。

B171 取 4 文件 / 目标 142 行并一次落地，实测密度 31.15%~31.54%；
覆盖套餐状态动作、模型草稿 hook、设置顶栏面包屑与账号连接失效建议，详见 [ZC-DEEP-b171.md](./ZC-DEEP-b171.md)。
落地后全仓复扫 `files=5032 coreBelow30=2038 needLines=31822 median=31.31`；
本会话范围 `files=4562 coreBelow30=2034 needLines=27230`，累计 1,190 文件 / 120,862 行。

下一步：复算 B172 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B172 取 4 文件 / 目标 147 行并一次落地，实测密度 31.30%~31.50%；
覆盖压缩摘要请求的流式降级、Goal 摘要标题生成、工作区检点账本与 Bash 模型可见内容，详见 [ZC-DEEP-b172.md](./ZC-DEEP-b172.md)。
落地后全仓复扫 `files=5032 coreBelow30=2034 needLines=31689 median=31.31`；
本会话范围 `files=4562 coreBelow30=2030 needLines=27097`，累计 1,194 文件 / 121,009 行。

下一步：复算 B173 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B173 取 4 文件 / 目标 143 行并一次落地，实测密度 31.25%~31.45%；
覆盖服务端目录布局与控制端点、命令编译、进程执行适配器与 Bash 读状态回填，详见 [ZC-DEEP-b173.md](./ZC-DEEP-b173.md)。
落地后全仓复扫 `files=5032 coreBelow30=2030 needLines=31555 median=31.31`；
本会话范围 `files=4562 coreBelow30=2026 needLines=26963`，累计 1,198 文件 / 121,152 行。

下一步：复算 B174 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B174 取 4 文件 / 目标 145 行并一次落地，实测密度 31.21%~31.60%；
覆盖 MCP App 页面宿主适配、页面工具条目、工作流存储契约用例与 Word 解析器，详见 [ZC-DEEP-b174.md](./ZC-DEEP-b174.md)。
落地后全仓复扫 `files=5032 coreBelow30=2026 needLines=31421 median=31.31`；
本会话范围 `files=4562 coreBelow30=2022 needLines=26829`，累计 1,202 文件 / 121,297 行。

下一步：复算 B175 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B175 取 4 文件 / 目标 138 行并一次落地，实测密度 31.09%~31.82%；
覆盖侧栏套餐升级入口推导、导航历史栈、记忆更新时间格式化与机器人绑定群 hook，详见 [ZC-DEEP-b175.md](./ZC-DEEP-b175.md)。
落地后全仓复扫 `files=5032 coreBelow30=2022 needLines=31289 median=31.31`；
本会话范围 `files=4562 coreBelow30=2018 needLines=26697`，累计 1,206 文件 / 121,435 行。

下一步：复算 B176 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B176 取 4 文件 / 目标 139 行并一次落地，实测密度 31.09%~31.62%；
覆盖轨迹搜索高亮、MCP 存储迁移、browser-use 共享 schema 与 RPC 网络遥测中间件，详见 [ZC-DEEP-b176.md](./ZC-DEEP-b176.md)。
落地后全仓复扫 `files=5032 coreBelow30=2018 needLines=31155 median=31.31`；
本会话范围 `files=4562 coreBelow30=2014 needLines=26563`，累计 1,210 文件 / 121,574 行。

下一步：复算 B177 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B177 取 4 文件 / 目标 139 行并一次落地，实测密度 30.97%~31.55%；
覆盖 Open Collective 月度汇总脚本、闲时任务展示映射、ACK 激活屏障与工作区钩子评审 store，详见 [ZC-DEEP-b177.md](./ZC-DEEP-b177.md)。
落地后全仓复扫 `files=5032 coreBelow30=2014 needLines=31022 median=31.31`；
本会话范围 `files=4562 coreBelow30=2010 needLines=26430`，累计 1,214 文件 / 121,713 行。

下一步：复算 B178 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B178 取 4 文件 / 目标 140 行并一次落地，实测密度 31.41%~31.78%；
覆盖命令组与兜底工具块、子代理花名册、工作流脊线药丸接线，详见 [ZC-DEEP-b178.md](./ZC-DEEP-b178.md)。
落地后全仓复扫 `files=5032 coreBelow30=2010 needLines=30889 median=31.31`；
本会话范围 `files=4562 coreBelow30=2006 needLines=26297`，累计 1,218 文件 / 121,853 行。

下一步：复算 B179 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B179 取 4 文件 / 目标 137 行并一次落地，实测密度 31.21%~31.58%；
覆盖快捷命令弹层、右键菜单统一样式、PPTX 选择操作条与斜杠命令提及分区，详见 [ZC-DEEP-b179.md](./ZC-DEEP-b179.md)。
落地后全仓复扫 `files=5032 coreBelow30=2006 needLines=30756 median=31.31`；
本会话范围 `files=4562 coreBelow30=2002 needLines=26164`，累计 1,222 文件 / 121,990 行。

下一步：复算 B180 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B180 取 4 文件 / 目标 137 行并一次落地，实测密度 31.11%~31.78%；
覆盖会话分享预检响应、模型元数据弹窗小件、远端连接向导外壳与工作流完成卡，详见 [ZC-DEEP-b180.md](./ZC-DEEP-b180.md)。
落地后全仓复扫 `files=5032 coreBelow30=2002 needLines=30624 median=31.32`；
本会话范围 `files=4562 coreBelow30=1998 needLines=26032`，累计 1,226 文件 / 122,127 行。

下一步：复算 B181 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B181 取 4 文件 / 目标 138 行并一次落地，实测密度 31.19%~31.78%；
覆盖 Markdown 选区操作条、工作区文件监听 hook、侧栏可拖分区外壳与分享站入口，详见 [ZC-DEEP-b181.md](./ZC-DEEP-b181.md)。
落地后全仓复扫 `files=5032 coreBelow30=1998 needLines=30492 median=31.32`；
本会话范围 `files=4562 coreBelow30=1994 needLines=25900`，累计 1,230 文件 / 122,265 行。

下一步：复算 B182 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B182 取 4 文件 / 目标 138 行并一次落地，实测密度 31.25%~31.50%；
覆盖远控 IPC 接线、主进程打开路径助手、截图表面契约与内置浏览器权限闸门，详见 [ZC-DEEP-b182.md](./ZC-DEEP-b182.md)。
落地后全仓复扫 `files=5032 coreBelow30=1994 needLines=30361 median=31.32`；
本会话范围 `files=4562 coreBelow30=1990 needLines=25769`，累计 1,234 文件 / 122,403 行。

下一步：复算 B183 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B183 取 4 文件 / 目标 131 行并一次落地，实测密度 30.30%~31.73%；
覆盖机器人绑定群卡片、插件创建 hook、反馈中心弹窗与插件提及提供者，详见 [ZC-DEEP-b183.md](./ZC-DEEP-b183.md)。
落地后全仓复扫 `files=5032 coreBelow30=1990 needLines=30233 median=31.32`；
本会话范围 `files=4562 coreBelow30=1986 needLines=25641`，累计 1,238 文件 / 122,534 行。

下一步：复算 B184 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B184 取 4 文件 / 目标 139 行并一次落地，实测密度 31.16%~31.65%；
覆盖进程 Provider Registry 装配、MCP UI 应用工具注册表、协议存储启动与内置搜索前缀，详见 [ZC-DEEP-b184.md](./ZC-DEEP-b184.md)。
落地后全仓复扫 `files=5032 coreBelow30=1986 needLines=30105 median=31.32`；
本会话范围 `files=4562 coreBelow30=1982 needLines=25513`，累计 1,242 文件 / 122,673 行。

下一步：复算 B185 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B185 取 4 文件 / 目标 132 行并一次落地，实测密度 31.25%~31.53%；
覆盖新引导流场渲染器、项目任务导航 hook、Provider 登录入口守卫与待处理交互适配器，详见 [ZC-DEEP-b185.md](./ZC-DEEP-b185.md)。
落地后全仓复扫 `files=5032 coreBelow30=1982 needLines=29977 median=31.32`；
本会话范围 `files=4562 coreBelow30=1978 needLines=25385`，累计 1,246 文件 / 122,805 行。

B186 取 4 文件 / 目标 136 行并一次落地，实测密度 31.25%~31.48%；
覆盖输入区后台工作徽标、对话引用标签、草稿模型门禁与 SaveWorkflow 卡片，详见 [ZC-DEEP-b186.md](./ZC-DEEP-b186.md)。
落地后全仓复扫 `files=5032 coreBelow30=1978 needLines=29849 median=31.32`；
本会话范围 `files=4562 coreBelow30=1974 needLines=25257`，累计 1,250 文件 / 122,941 行。

B187 取 4 文件 / 目标 138 行并一次落地，实测密度 30.97%~31.72%；
覆盖测速新建表单、TUI 子代理分区、远端附件物化与本地媒体预览协议，详见 [ZC-DEEP-b187.md](./ZC-DEEP-b187.md)。
落地后全仓复扫 `files=5032 coreBelow30=1974 needLines=29719 median=31.32`；
本会话范围 `files=4562 coreBelow30=1970 needLines=25127`，累计 1,254 文件 / 123,079 行。

B188 取 4 文件 / 目标 134 行并一次落地，实测密度 31.25%~31.47%；
覆盖桌面渲染层构建配置、内置发行包下载、模型数据合同与 V4 物理帧模式，详见 [ZC-DEEP-b188.md](./ZC-DEEP-b188.md)。
落地后全仓复扫 `files=5032 coreBelow30=1970 needLines=29591 median=31.33`；
本会话范围 `files=4562 coreBelow30=1966 needLines=24999`，累计 1,258 文件 / 123,213 行。

B189 取 4 文件 / 目标 133 行并一次落地，实测密度 31.11%~31.62%；
覆盖工作区连接注册表、分享预览模拟客户端、控制套接字服务端与不可变发布晋升，详见 [ZC-DEEP-b189.md](./ZC-DEEP-b189.md)。
落地后全仓复扫 `files=5032 coreBelow30=1966 needLines=29463 median=31.33`；
本会话范围 `files=4562 coreBelow30=1962 needLines=24871`，累计 1,262 文件 / 123,346 行。

B190 取 4 文件 / 目标 133 行并一次落地，实测密度 31.33%~31.61%；
覆盖发布指针管理、工作流脚本元数据、专家命令处理与观测事件流，详见 [ZC-DEEP-b190.md](./ZC-DEEP-b190.md)。
落地后全仓复扫 `files=5032 coreBelow30=1962 needLines=29338 median=31.33`；
本会话范围 `files=4562 coreBelow30=1958 needLines=24746`，累计 1,266 文件 / 123,479 行。

B191 取 4 文件 / 目标 129 行并一次落地，实测密度 31.13%~31.78%；
覆盖应用遥测运行时、MCP 遥测上报、任务通知派发与沙箱权限闸门，详见 [ZC-DEEP-b191.md](./ZC-DEEP-b191.md)。
落地后全仓复扫 `files=5032 coreBelow30=1958 needLines=29214 median=31.33`；
本会话范围 `files=4562 coreBelow30=1954 needLines=24622`，累计 1,270 文件 / 123,608 行。

B192 取 4 文件 / 目标 129 行并一次落地，实测密度 30.97%~31.54%；
覆盖资源管理器网络采集、远端 Source Server 探测、后台任务通知解析与采样模式，详见 [ZC-DEEP-b192.md](./ZC-DEEP-b192.md)。
落地后全仓复扫 `files=5032 coreBelow30=1954 needLines=29090 median=31.33`；
本会话范围 `files=4562 coreBelow30=1950 needLines=24498`，累计 1,274 文件 / 123,737 行。

B193 取 4 文件 / 目标 132 行并一次落地，实测密度 31.07%~31.78%；
覆盖共享运行环境键与清洗、Source Server 兼容性清单、终端面板动画与人类浏览器显示偏好，详见 [ZC-DEEP-b193.md](./ZC-DEEP-b193.md)。
落地后全仓复扫 `files=5032 coreBelow30=1950 needLines=28966 median=31.33`；
本会话范围 `files=4562 coreBelow30=1946 needLines=24374`，累计 1,278 文件 / 123,869 行。

B194 取 4 文件 / 目标 128 行并一次落地，实测密度 31.03%~31.68%；
覆盖配额重置机会徽标、当前会话提交范围、远端插件同步刷新与主活动判定，详见 [ZC-DEEP-b194.md](./ZC-DEEP-b194.md)。
落地后全仓复扫 `files=5032 coreBelow30=1946 needLines=28842 median=31.33`；
本会话范围 `files=4562 coreBelow30=1942 needLines=24250`，累计 1,282 文件 / 123,997 行。

下一步：复算 B195 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B195 取 4 文件 / 目标 130 行并一次落地，实测密度 31.03%~31.75%；
覆盖提及图标 DOM 数据与 SVG 构建、引导曝光埋点、远端连接流程契约与「移到项目」对话框，详见 [ZC-DEEP-b195.md](./ZC-DEEP-b195.md)。
落地后全仓复扫 `files=5032 coreBelow30=1942 needLines=28718 median=31.33`；
本会话范围 `files=4562 coreBelow30=1938 needLines=24126`，累计 1,286 文件 / 124,127 行。

下一步：复算 B196 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B196 取 4 文件 / 目标 130 行并一次落地，实测密度 31.33%~31.82%；
覆盖任务重命名对话框输入法处理、PPTX 元素引用药丸、轮尾工作流摘要卡与 Web 远控请求挂起表，详见 [ZC-DEEP-b196.md](./ZC-DEEP-b196.md)。
落地后全仓复扫 `files=5032 coreBelow30=1938 needLines=28594 median=31.33`；
本会话范围 `files=4562 coreBelow30=1934 needLines=24002`，累计 1,290 文件 / 124,257 行。

下一步：复算 B197 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B197 取 4 文件 / 目标 130 行并一次落地，实测密度 31.07%~31.68%；
覆盖 Web 远控帧读取与解析、服务端任务活动聚合、dev-docs 的 Vite 配置与 CLI 运行时配置合并，详见 [ZC-DEEP-b197.md](./ZC-DEEP-b197.md)。
落地后全仓复扫 `files=5032 coreBelow30=1934 needLines=28472 median=31.33`；
本会话范围 `files=4562 coreBelow30=1930 needLines=23880`，累计 1,294 文件 / 124,387 行。

下一步：复算 B198 清单，保持每批 4 个文件推进，并在完成后回填 `README-summary.md`。

B198 取 4 文件 / 目标 132 行并一次落地，实测密度 31.63%~31.95%；
覆盖调试观测数据源读取、动态工作流 run 契约用例、knip 文档站 Astro 配置与客户端 WebSocket 适配，详见 [ZC-DEEP-b198.md](./ZC-DEEP-b198.md)。
落地后全仓复扫 `files=5032 coreBelow30=1930 needLines=28352 median=31.33`；
本会话范围 `files=4562 coreBelow30=1926 needLines=23760`，累计 1,298 文件 / 124,519 行。

B199 取 4 文件 / 目标 128 行并一次落地，实测密度 31.13%~31.33%；
覆盖桌面启动状态中继、插件沙箱会话锁定、Provider 配置双套契约与会话分享契约，详见 [ZC-DEEP-b199.md](./ZC-DEEP-b199.md)。
落地后全仓复扫 `files=5032 coreBelow30=1926 needLines=28232 median=31.33`；
本会话范围 `files=4562 coreBelow30=1922 needLines=23640`，累计 1,302 文件 / 124,647 行。

B200 取 4 文件 / 目标 125 行并一次落地，实测密度 31.11%~31.58%；
覆盖强制更新判定、SQLite 迁移执行器、subagent 共享契约与 board 渲染器，详见 [ZC-DEEP-b200.md](./ZC-DEEP-b200.md)。
落地后全仓复扫 `files=5032 coreBelow30=1922 needLines=28112 median=31.34`；
本会话范围 `files=4562 coreBelow30=1918 needLines=23520`，累计 1,306 文件 / 124,772 行。

B201 取 4 文件 / 目标 125 行并一次落地，实测密度 31.00%~31.72%；
覆盖营销弹窗适配、切分支协助状态、OAuth 登录 hook 与远控 task 打开，详见 [ZC-DEEP-b201.md](./ZC-DEEP-b201.md)。
落地后全仓复扫 `files=5032 coreBelow30=1918 needLines=27992 median=31.34`；
本会话范围 `files=4562 coreBelow30=1914 needLines=23400`，累计 1,310 文件 / 124,897 行。

B202 取 4 文件 / 目标 126 行并一次落地，实测密度 31.00%~31.78%；
覆盖 provider 业务码映射、斜杠命令过滤、预览内容分流与字段帮助气泡，详见 [ZC-DEEP-b202.md](./ZC-DEEP-b202.md)。
落地后全仓复扫 `files=5032 coreBelow30=1914 needLines=27872 median=31.34`；
本会话范围 `files=4562 coreBelow30=1910 needLines=23280`，累计 1,314 文件 / 125,023 行。

B203 取 4 文件 / 目标 127 行并一次落地，实测密度 31.43%~31.72%；
覆盖输入模态多选、实参表单纯函数、提问工具卡与 run 传输方法，详见 [ZC-DEEP-b203.md](./ZC-DEEP-b203.md)。
落地后全仓复扫 `files=5032 coreBelow30=1910 needLines=27752 median=31.34`；
本会话范围 `files=4562 coreBelow30=1906 needLines=23160`，累计 1,318 文件 / 125,150 行。

B204 取 4 文件 / 目标 129 行并一次落地，实测密度 30.93%~31.53%；
覆盖 composer 工具条热键、远控传输契约、模型状态事件出口与 Hook 信任安全面，详见 [ZC-DEEP-b204.md](./ZC-DEEP-b204.md)。
落地后全仓复扫 `files=5032 coreBelow30=1906 needLines=27634 median=31.34`；
本会话范围 `files=4562 coreBelow30=1902 needLines=23042`，累计 1,322 文件 / 125,279 行。

B205 取 4 文件 / 目标 124 行并一次落地，实测密度 31.09%~31.58%；
覆盖 plugins 共用件、轮尾 Browser 截图、只读 argv 校验与 xlsx 解析，详见 [ZC-DEEP-b205.md](./ZC-DEEP-b205.md)。
落地后全仓复扫 `files=5032 coreBelow30=1902 needLines=27518 median=31.34`；
本会话范围 `files=4562 coreBelow30=1898 needLines=22926`，累计 1,326 文件 / 125,403 行。

B206 取 4 文件 / 目标 123 行并一次落地，实测密度 31.13%~31.63%；
覆盖 TUI 选区键盘分发、Browser 虚拟粘贴页内脚本、AppImage 用户级图标与 AUMID 图标读取，详见 [ZC-DEEP-b206.md](./ZC-DEEP-b206.md)。
落地后全仓复扫 `files=5032 coreBelow30=1898 needLines=27402 median=31.34`；
本会话范围 `files=4562 coreBelow30=1894 needLines=22810`，累计 1,330 文件 / 125,526 行。

B207 取 4 文件 / 目标 120 行并一次落地，实测密度 31.25%~31.63%；
覆盖私有文件原子写入与锁队列、套餐身份投影、SSH 共享键与会话调试快照契约，详见 [ZC-DEEP-b207.md](./ZC-DEEP-b207.md)。
落地后全仓复扫 `files=5032 coreBelow30=1894 needLines=27286 median=31.34`；
本会话范围 `files=4562 coreBelow30=1890 needLines=22694`，累计 1,334 文件 / 125,646 行。

B208 取 4 文件 / 目标 121 行并一次落地，实测密度 31.34%~31.82%；
覆盖 API 重试状态归一、计划详情侧栏租约、套餐用量入口三态与会话滚动导出组件，详见 [ZC-DEEP-b208.md](./ZC-DEEP-b208.md)。
落地后全仓复扫 `files=5032 coreBelow30=1890 needLines=27170 median=31.34`；
本会话范围 `files=4562 coreBelow30=1886 needLines=22578`，累计 1,338 文件 / 125,767 行。

B209 取 4 文件 / 目标 120 行并一次落地，实测密度 31.00%~31.91%；
覆盖营销弹窗装配、Gen UI Tweak 注册表、提交上下文裁剪与子代理 mention 候选投影，详见 [ZC-DEEP-b209.md](./ZC-DEEP-b209.md)。
落地后全仓复扫 `files=5032 coreBelow30=1886 needLines=27054 median=31.34`；
本会话范围 `files=4562 coreBelow30=1882 needLines=22462`，累计 1,342 文件 / 125,887 行。

B210 取 4 文件 / 目标 120 行并一次落地，实测密度 31.25%~31.91%；
覆盖轨迹查找条、首页主题 Hero 调色板、保留中的远程项目连接与侧边栏新增入口，详见 [ZC-DEEP-b210.md](./ZC-DEEP-b210.md)。
落地后全仓复扫 `files=5032 coreBelow30=1882 needLines=26938 median=31.34`；
本会话范围 `files=4562 coreBelow30=1878 needLines=22346`，累计 1,346 文件 / 126,007 行。

B211 取 4 文件 / 目标 122 行并一次落地，实测密度 31.25%~32.65%；
覆盖远程项目连接请求分派、连接类型与状态标签、远程工作区意图控制器与重连日志收集，详见 [ZC-DEEP-b211.md](./ZC-DEEP-b211.md)。
落地后全仓复扫 `files=5032 coreBelow30=1878 needLines=26822 median=31.34`；
本会话范围 `files=4562 coreBelow30=1874 needLines=22230`，累计 1,350 文件 / 126,129 行。

B212 取 4 文件 / 目标 120 行并一次落地，实测密度 30.92%~31.58%；
覆盖存储分类列表、存储扫描数据源、定时任务表单选项构造与 Start Plan 预览缓存，详见 [ZC-DEEP-b212.md](./ZC-DEEP-b212.md)。
落地后全仓复扫 `files=5032 coreBelow30=1874 needLines=26706 median=31.34`；
本会话范围 `files=4562 coreBelow30=1870 needLines=22114`，累计 1,354 文件 / 126,249 行。

B213 取 4 文件 / 目标 120 行并一次落地，实测密度 30.72%~31.25%；
覆盖工作流详情头行、Side Pane 浮窗纯模型、submit_result 工具卡与更新状态视图模型，详见 [ZC-DEEP-b213.md](./ZC-DEEP-b213.md)。
落地后全仓复扫 `files=5032 coreBelow30=1870 needLines=26590 median=31.34`；
本会话范围 `files=4562 coreBelow30=1866 needLines=21998`，累计 1,358 文件 / 126,369 行。

B214 取 4 文件 / 目标 120 行并一次落地，实测密度 31.30%~31.96%；
覆盖模型触发器文案、v4 数据层出口、草稿建议插件弹层与 workspace 索引订阅集合，详见 [ZC-DEEP-b214.md](./ZC-DEEP-b214.md)。
落地后全仓复扫 `files=5032 coreBelow30=1866 needLines=26474 median=31.34`；
本会话范围 `files=4562 coreBelow30=1862 needLines=21882`，累计 1,362 文件 / 126,489 行。

B215 取 4 文件 / 目标 120 行并一次落地，实测密度 30.43%~32.61%；
覆盖文件树吸顶行、runtime 命令队列、GitHub 赞助聚合与 MCP 迟到回调用例，详见 [ZC-DEEP-b215.md](./ZC-DEEP-b215.md)。
落地后全仓复扫 `files=5032 coreBelow30=1862 needLines=26361 median=31.35`；
本会话范围 `files=4562 coreBelow30=1858 needLines=21769`，累计 1,366 文件 / 126,609 行。

B216 取 4 文件 / 目标 120 行并一次落地，实测密度 30.66%~32.29%；
覆盖 v4 delta 应用语义、行 schema、浏览器区域尺寸提示与命令中心搜索历史，详见 [ZC-DEEP-b216.md](./ZC-DEEP-b216.md)。
落地后全仓复扫 `files=5032 coreBelow30=1858 needLines=26249 median=31.35`；
本会话范围 `files=4562 coreBelow30=1854 needLines=21657`，累计 1,370 文件 / 126,729 行。

B217 取 4 文件 / 目标 120 行并一次落地，实测密度 30.63%~32.61%；
覆盖工作流时间线模型、反馈流程页、Highspeed footer 聚合与 Provider 设置视图，详见 [ZC-DEEP-b217.md](./ZC-DEEP-b217.md)。
落地后全仓复扫 `files=5032 coreBelow30=1854 needLines=26137 median=31.35`；
本会话范围 `files=4562 coreBelow30=1850 needLines=21545`，累计 1,374 文件 / 126,849 行。

B218 取 4 文件 / 目标 120 行并一次落地，实测密度 31.52%~32.99%；
覆盖 MCP 连通性探测、引导流程 AGENTS 迁移步骤、插件 UI 工具投喂与侧栏任务动作适配，详见 [ZC-DEEP-b218.md](./ZC-DEEP-b218.md)。
落地后全仓复扫 `files=5032 coreBelow30=1850 needLines=26025 median=31.35`；
本会话范围 `files=4562 coreBelow30=1846 needLines=21433`，累计 1,378 文件 / 126,969 行。

B219 取 4 文件 / 目标 120 行并一次落地，实测密度 32.26%~32.67%；
覆盖 Bot 任务广播解析、套餐升级弹窗入口、模型草稿状态与供应商设置骨架，详见 [ZC-DEEP-b219.md](./ZC-DEEP-b219.md)。
落地后全仓复扫 `files=5032 coreBelow30=1846 needLines=25913 median=31.35`；
本会话范围 `files=4562 coreBelow30=1842 needLines=21321`，累计 1,382 文件 / 127,089 行。

B220 取 4 文件 / 目标 120 行并一次落地，实测密度 31.71%~32.63%；
覆盖快捷键录制、斜杠命令建议、任务右键菜单与工具卡装配，详见 [ZC-DEEP-b220.md](./ZC-DEEP-b220.md)。
落地后全仓复扫 `files=5032 coreBelow30=1842 needLines=25801 median=31.35`；
本会话范围 `files=4562 coreBelow30=1838 needLines=21209`，累计 1,386 文件 / 127,209 行。

B221 取 4 文件 / 目标 120 行并一次落地，实测密度 31.58%~32.99%；
覆盖单轮会话行、分屏布局计算、工作流留白通知行与 Web 远控设备信息，详见 [ZC-DEEP-b221.md](./ZC-DEEP-b221.md)。
落地后全仓复扫 `files=5032 coreBelow30=1838 needLines=25689 median=31.35`；
本会话范围 `files=4562 coreBelow30=1834 needLines=21097`，累计 1,390 文件 / 127,329 行。

B222 取 4 文件 / 目标 120 行并一次落地，实测密度 31.44%~32.32%；
覆盖分组件归档、按行范围读文本、node_repl 浏览器 broker 与启动埋点，详见 [ZC-DEEP-b222.md](./ZC-DEEP-b222.md)。
落地后全仓复扫 `files=5032 coreBelow30=1834 needLines=25580 median=31.35`；
本会话范围 `files=4562 coreBelow30=1830 needLines=20988`，累计 1,394 文件 / 127,449 行。

B223 取 4 文件 / 目标 120 行并一次落地，实测密度 30.65%~33.00%；
覆盖 /goal 命令、媒体附件解析、用量旁路写入与话题档案检索，详见 [ZC-DEEP-b223.md](./ZC-DEEP-b223.md)。
落地后全仓复扫 `files=5032 coreBelow30=1830 needLines=25472 median=31.35`；
本会话范围 `files=4562 coreBelow30=1826 needLines=20880`，累计 1,398 文件 / 127,569 行。

B224 取 4 文件 / 目标 120 行并一次落地，实测密度 31.43%~33.33%；
覆盖 ARMS 遥测引导、浏览器命令分派、Windows 右键菜单与启动工作区解析，详见 [ZC-DEEP-b224.md](./ZC-DEEP-b224.md)。
落地后全仓复扫 `files=5032 coreBelow30=1826 needLines=25364 median=31.35`；
本会话范围 `files=4562 coreBelow30=1822 needLines=20772`，累计 1,402 文件 / 127,689 行。

B225 取 4 文件 / 目标 120 行并一次落地，实测密度 32.73%~34.09%；
覆盖插件沙箱 relay、JSON Merge Patch、Endpoint 作用域内置源与连接错误归一，详见 [ZC-DEEP-b225.md](./ZC-DEEP-b225.md)。
落地后全仓复扫 `files=5032 coreBelow30=1822 needLines=25256 median=31.36`；
本会话范围 `files=4562 coreBelow30=1818 needLines=20664`，累计 1,406 文件 / 127,809 行。

B226 取 4 文件 / 目标 120 行并一次落地，实测密度 32.08%~34.48%；
覆盖 UI 文件摘要夹具、stream-animate 运行数据仓、输入框附件动作菜单与代码片段复制组件，详见 [ZC-DEEP-b226.md](./ZC-DEEP-b226.md)。
落地后全仓复扫 `files=5032 coreBelow30=1818 needLines=25148 median=31.36`；
本会话范围 `files=4562 coreBelow30=1814 needLines=20556`，累计 1,410 文件 / 127,929 行。

## 阶段二：注释质量改写（单独记账，不并入批次合计）

扩批暂停，先清 `qc-poem-audit.mjs` 命中的 1,830 处 / 7,399 行「短句三连」。
工具：`zc-verify.mjs --rewrite`，断言「删行是注释 / 删的是自有注释 / 代码 token 流与 HEAD 一致 / 未删字面量内 `//`」。
顺序按命中量：B29(65) → B108(34) → B83(33) → B105(33) → B111 → B112 → B85 → B110 → B113 ……同一文件的多处一次改完。

- FIX-B1：`packages/ui/src/lib/chatPrepareError.ts`，4 段 / 删 21 行，[ZC-fix-b1.md](./ZC-fix-b1.md)
- FIX-B2：`packages/ui/src/OpenSplitButton.tsx`，15 段 / 删 58 行，[ZC-fix-b2.md](./ZC-fix-b2.md)
- 下一批 FIX-B3 清单已快照：`TaskList.tsx`、`previewPaneContent.tsx`、`WorkspaceSidebarFooter.tsx`、`GitPane.tsx`（B29 剩余 4 文件）。

下一步：按 FIX-B3 快照逐文件改写并 `--rewrite` 校验，每 10~15 文件写一份 `ZC-fix-bN.md`；B29 清完后继续 B108。



