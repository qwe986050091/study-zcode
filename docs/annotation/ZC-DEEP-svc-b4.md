# ZC-DEEP-svc-b4：`session/**` 全量深度注释索引

> 范围：`packages/services/src/session/**` 下 baseline 低于 30% 的 45 个生产文件（`claude-native/**`、`tasksDatabase/**` 与 session 根目录；`*.test/spec`、`test-fixture.ts` 不在范围内）。
> 基线：`d:\code\_annot_baseline\ZC-deep-svc-b4\orig\packages\services\src\session\`，清单 `_files.txt`（45 项）。
> 硬约束：只新增整行 `//` 注释；`deletedNonZero=0`；`nonCommentAdded=0`；`starSlash=0`；`syntaxErrorFiles=0`；不做 git 提交。
> 行尾：源码为 CRLF；插入脚本按 `\r\n` 切分与回拼，新增行同样以 CRLF 落盘，`git diff --numstat` 删除列全为 0。
> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（文件头 INV 表 + 关键分支 `[并发]/[事务]/[资源]/[失败路径]/[权衡]`）。

## 结果

| 文件 | 基线注释/代码 | 完成后注释/代码 | 新增注释 | 验收 |
| --- | ---: | ---: | ---: | --- |
| `zcodeTaskService.ts` | 136 / 568 | 171 / 568 = **30.11%** | +35 | PASS |
| `tasksDatabase/schema-v1.ts` | 1 / 169 | 51 / 169 = **30.18%** | +50 | PASS |
| `tasksDatabase/migrations.ts` | 8 / 291 | 88 / 291 = **30.24%** | +80 | PASS |
| `controllerRemoteIdentityMigration.ts` | 8 / 294 | 89 / 294 = **30.27%** | +81 | PASS |
| `tasksDatabase/official-glm-selection-v3.ts` | 2 / 33 | 10 / 33 = **30.30%** | +8 | PASS |
| `automationIntervalCarrier.ts` | 12 / 56 | 17 / 56 = **30.36%** | +5 | PASS |
| `offPeakServerClient.ts` | 24 / 240 | 73 / 240 = **30.42%** | +49 | PASS |
| `taskChangeSummary.ts` | 6 / 118 | 36 / 118 = **30.51%** | +30 | PASS |
| `continuousStreamCoalescer.ts` | 7 / 190 | 58 / 190 = **30.53%** | +51 | PASS |
| `taskIndexRepo.ts` | 81 / 1,274 | 389 / 1,274 = **30.53%** | +308 | PASS |
| `tasksDatabase/provider-selection-v2.ts` | 10 / 85 | 26 / 85 = **30.59%** | +16 | PASS |
| `automationService.ts` | 47 / 343 | 105 / 343 = **30.61%** | +58 | PASS |
| `sourceServerWorkspaceAliasRepo.ts` | 71 / 2,199 | 675 / 2,199 = **30.70%** | +604 | PASS |
| `automationRepo.ts` | 114 / 1,319 | 406 / 1,319 = **30.78%** | +292 | PASS |
| `automationCron.ts` | 62 / 263 | 81 / 263 = **30.80%** | +19 | PASS |
| `offPeakMockGateway.ts` | 49 / 810 | 251 / 810 = **30.99%** | +202 | PASS |
| `tasksDatabase/source-server-schema-v5.ts` | 3 / 200 | 62 / 200 = **31.00%** | +59 | PASS |
| `claude-native/claudeNativeSessionHeadParser.ts` | 0 / 190 | 59 / 190 = **31.05%** | +59 | PASS |
| `claude-native/importedClaudeTaskFileFilter.ts` | 0 / 45 | 14 / 45 = **31.11%** | +14 | PASS |
| `mcpWorkspaceScope.ts` | 4 / 45 | 14 / 45 = **31.11%** | +10 | PASS |
| `claude-native/buildImportedClaudeTaskFile.ts` | 3 / 61 | 19 / 61 = **31.15%** | +16 | PASS |
| `automationCronValidation.ts` | 3 / 77 | 24 / 77 = **31.17%** | +21 | PASS |
| `claude-native/sessionHistoryJsonl.ts` | 0 / 48 | 15 / 48 = **31.25%** | +15 | PASS |
| `legacyTaskSessionFile.ts` | 2 / 16 | 5 / 16 = **31.25%** | +3 | PASS |
| `tasksDatabase/controller-remote-schema-v4.ts` | 1 / 16 | 5 / 16 = **31.25%** | +4 | PASS |
| `claude-native/claudeNativeSessionImportService.ts` | 2 / 153 | 48 / 153 = **31.37%** | +46 | PASS |
| `offPeakTaskService.ts` | 77 / 675 | 212 / 675 = **31.41%** | +135 | PASS |
| `offPeakTask.ts` | 8 / 35 | 11 / 35 = **31.43%** | +3 | PASS |
| `sessionRealtimePort.ts` | 0 / 44 | 14 / 44 = **31.82%** | +14 | PASS |
| `claude-native/persistImportedClaudeTask.ts` | 3 / 50 | 16 / 50 = **32.00%** | +13 | PASS |
| `offPeakResidentExecutions.ts` | 8 / 231 | 74 / 231 = **32.03%** | +66 | PASS |
| `sessionModeOptions.ts` | 3 / 84 | 27 / 84 = **32.14%** | +24 | PASS |
| `zcodeTaskListTypes.ts` | 0 / 28 | 9 / 28 = **32.14%** | +9 | PASS |
| `offPeakTaskRepo.ts` | 98 / 702 | 226 / 702 = **32.19%** | +128 | PASS |
| `offPeakRuntimeModel.ts` | 43 / 295 | 95 / 295 = **32.20%** | +52 | PASS |
| `claude-native/claudeNativeImportedSessionTypes.ts` | 1 / 15 | 5 / 15 = **33.33%** | +4 | PASS |
| `claude-native/claudeNativeSessionImportRepo.ts` | 7 / 258 | 86 / 258 = **33.33%** | +79 | PASS |
| `offPeakWorkspaceIdentityMigration.ts` | 4 / 27 | 9 / 27 = **33.33%** | +5 | PASS |
| `sessionMailbox.ts` | 0 / 15 | 5 / 15 = **33.33%** | +5 | PASS |
| `sessionTitle.ts` | 0 / 15 | 5 / 15 = **33.33%** | +5 | PASS |
| `tasksDatabase/prepared.ts` | 1 / 17 | 6 / 17 = **35.29%** | +5 | PASS |
| `claude-native/importedClaudeHistoryRepair.ts` | 11 / 190 | 68 / 190 = **35.79%** | +57 | PASS |
| `claude-native/jsonLineRecord.ts` | 0 / 11 | 4 / 11 = **36.36%** | +4 | PASS |
| `claude-native/claudeNativeSessionImportParser.ts` | 37 / 486 | 188 / 486 = **38.68%** | +151 | PASS |
| `toolPlanAdapter.ts` | 0 / 5 | 2 / 5 = **40.00%** | +2 | PASS |
| **合计** | 957 / 12,286 = 7.79% | 3,853 / 12,286 = **31.36%** | **+2,896** | — |

## 分段明细

| 段 | 文件 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| seg1 | `sessionMailbox` `sessionRealtimePort` `sessionTitle` `toolPlanAdapter` `zcodeTaskListTypes` `legacyTaskSessionFile` `offPeakTask` `mcpWorkspaceScope` `taskChangeSummary` `continuousStreamCoalescer` `controllerRemoteIdentityMigration` `offPeakWorkspaceIdentityMigration` `offPeakRuntimeModel` `sessionModeOptions` | 端口契约与类型；会话标题/邮箱；旧任务文件兼容；MCP workspace scope 规范化；任务变更摘要口径；连续流合并窗口；身份迁移的旧数据判定 | +294 |
| seg2 | `claude-native/*` 11 个文件 | 行级容错解析（坏行跳过而非整文件失败）；导入文件筛选与构建；持久化与 repair；JSONL 记录边界；导入单据状态机 | +458 |
| seg3 | `tasksDatabase/*` 7 个文件 | schema v1/v4/v5 的列与索引语义；migrations 顺序与幂等；prepared 状态；provider/GLM 选择表 | +222 |
| seg4 | `automationService` `automationRepo` `automationCron` `automationCronValidation` `automationIntervalCarrier` | one-shot 与 recurring 的终态差异；30 分钟陈旧目标窗口；相对延迟用服务端时钟；生命周期重算；间隔载体校验 | +395 |
| seg5 | `taskIndexRepo` `sourceServerWorkspaceAliasRepo` `zcodeTaskService` | provider 过滤唯一实现；prepared/migrated 守卫；node:sqlite 同步事务不夹网络 IO；迁移 phase 顺序即真相；canonical alias 收敛；task 服务编排 | +947 |
| seg6 | `offPeakTaskRepo` `offPeakTaskService` `offPeakServerClient` `offPeakResidentExecutions` `offPeakMockGateway` | 创建即取号；轮询驱动晋级；终态核销 outbox；3102 续跑重取号；驻留执行生命周期；mock 网关的惰性时间状态机 | +580 |
| **合计** | — | — | **+2,896** |

## 校验输出原文

```text
SUMMARY files=45 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=2896
```

```text
SUMMARY files=45 coreBelow30=0 needLines=0 min=30.11 median=31.25 newComments=2896
PASS: all 45 file(s) >= 30% (mode=code)
```

逐文件 `git diff --no-index --numstat` 删除列均为 0，新增列合计 2,896，与 `deep-density` 的 `newComments` 逐文件一致。

全目录重测（`packages/services/src`，467 个生产文件，已用 `--exclude` 排除 `*.test.ts` / `*.spec.ts` / `test-fixture.ts`）：

```text
SUMMARY files=467 coreBelow30=342 needLines=15989 min=0.00 median=7.14 newComments=12964
```

相对 b3b 收口：`coreBelow30 387 → 342`（本批 45 个文件全部达标）、`needLines 18,737 → 15,989`（−2,748，等于本批文件原始缺口之和）、`median 5.83% → 7.14%`、累计 `newComments 10,068 → 12,964`（+2,896）。

## 本批重点不变量

1. **provider 过滤只有一份实现**（`taskIndexRepo.ts`）：列表与统计类查询必须经过 `appendZCodeAgentIndexedProviderFilter`，任一调用点自拼 SQL 漏加过滤，都会让非 glm 历史重新混进项目树。
2. **tasks 库先就绪再查询**（`taskIndexRepo.ts` / `tasksDatabase/prepared.ts`）：prepared/migrated 未就绪时不能把空结果当成「没有任务」。
3. **同步事务不夹 IO**（`taskIndexRepo.ts`）：`node:sqlite` 同步 API 换取事务边界确定性，因此事务必须语句级，绝不能在事务中做网络/文件 IO，否则阻塞事件循环。
4. **迁移 phase 顺序即恢复语义**（`sourceServerWorkspaceAliasRepo.ts`）：`WORKSPACE_MIGRATION_PHASES` 越靠前代表该阶段及之前已持久化；禁止在中间插入新阶段，否则旧 ledger 的 phase 整体错位。
5. **canonical 收敛**（`sourceServerWorkspaceAliasRepo.ts`）：同一物理路径下漂移的多条 remote identity 收敛为 canonical；`getWorkspaceHash` 必须与 CLI 侧一致，否则会读到空目录并漏合并。
6. **迁移备份用库内快照**：`backup()` 在库内部完成一致性快照，避免迁移中读到写了一半的页面；配置目录只做 rename/rm，杜绝半拷贝文件。
7. **一次性任务不可复活**（`automationService.ts` / `automationCron.ts`）：`completed` 是有限计划的正常终点，只有 `failed` 允许 restart；`maxRuns` 清空必须与 `recurring=true` 同批提交。
8. **相对延迟用服务端时钟**（`automationCron.ts`）：`delayMinutes` 落成带秒级 `anchorAt` 的规则，五段 cron 只用于兼容展示，避免提前/延后一整分钟。
9. **失败分类是跨 RPC 契约**（`offPeakTaskService.ts`）：UI 只认 `category` 与 `bizCode`，原始错误与响应体不出本层；`3101/3103` 是用户可理解的两类拒绝。
10. **取消先落终态**（`offPeakTaskService.ts`）：终态先写库，loop 的迟到回写会被状态守卫丢弃；核销 best-effort，失败留在 outbox 等下一轮。
11. **重取号只由显式动作触发**（`offPeakTaskService.ts`）：Continue 时票已废才重取，避免在轮询路径隐式消耗额度；查询失败按「票仍活」交给轮询兜底。
12. **mock 网关惰性推进时间**（`offPeakMockGateway.ts`）：不跑后台计时器，只在 status/messages 时评估 queued→ready→active→expired，保证 E2E 可确定复现。
13. **CRLF 与 numstat**：本批所有插入均经 `_ins.mjs` 以 `\r\n` 回拼；`taskIndexRepo.ts` 因子代理写成 LF，已用 `_crlf-b4.mjs` 整文件转回 CRLF，复测 numstat 仍为 308/0。

## “看起来该改其实不能改”的点

1. `taskIndexRepo.ts` 用同步 `node:sqlite` 而非异步封装，看似阻塞；tasks-index 读写都很短，事务边界的确定性比让出事件循环更重要，长事务才是要避免的。
2. `sourceServerWorkspaceAliasRepo.ts` 的阶段顺序写成常量数组且禁止插入，看似不够灵活；ledger 里存的是 phase 名，顺序就是恢复语义，中间插值会让旧数据整体错位。
3. `sourceServerWorkspaceAliasRepo.ts` 迁移前先整库 `backup()`，看似耗时；这是唯一能在失败后回到一致状态的依据，删掉会让半迁移库无法恢复。
4. `automationCron.ts` 给一次性过期目标留 30 分钟窗口，看似宽容；模型的时间上下文常停留在轮开始，窗口内应判「模型算错」，超出窗口才保留下一年语义。
5. `automationService.ts` 拒绝 `completed` 的 restart，看似妨碍重跑；`completed` 是有限次计划自然耗尽，可重跑的只有 `failed`，放开会让旧 UI/RPC 悄悄复活已结束的任务。
6. `automationService.ts` 要求清空 `maxRuns` 同批设 `recurring=true`，看似啰嗦；缺这条会静默结束仍在运行的任务。
7. `offPeakTaskService.ts` 的 `paused` 只停本地派发，看似应同时释放票；服务端票继续排队才能在恢复时无缝续跑，释放反而要重新消耗额度。
8. `offPeakTaskService.ts` 在状态查询失败时按「票仍活」处理，看似掩盖错误；Continue 上白耗额度比交给轮询兜底更糟。
9. `offPeakMockGateway.ts` 用固定端口 45,197，看似会冲突；多窗口多 host 共享同一份票据状态是设计目标，冲突时复用已有实例（`external=true`、close 为 no-op）。
10. `claude-native` 解析坏行后继续，看似吞错；导入的历史文件本就可能截断/混杂，整文件失败会让用户丢掉可恢复的其余记录。

以上均为阅读结论，本批未改动任何代码 token。
