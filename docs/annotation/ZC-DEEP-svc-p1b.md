# ZC-DEEP-svc-p1b：P1 持久化与崩溃窗口 17 文件函数级复查

> 范围：`ZC-DEEP-svc-triage.md` A 档中的 P1（持久化与崩溃窗口）17 文件。
> 本批只做函数级补深与复核，不改 P2 的 17 个文件，也不重报 A 档整体。
> 口径：**内文率 = 函数体内部整行中文注释行 ÷ 函数体内部代码行**（`zc-inner.mjs`，AST trivia + 字符覆盖掩码）。

## 1. 函数级清单（按「漏了会在什么时机丢数据 / 写出半条记录」排序）

纯 getter、单表达式包装、纯转发跳过；已有注释把前置/顺序/后果说清的，不重写。

| # | 函数 | 崩溃/损坏时机 | 补的三类信息 |
| ---: | --- | --- | --- |
| 1 | `automationRepo.markRunDispatch` | run 台账已写、automation 尚未推进 | 先台账后推进；反序会留下「已释放 + run 仍 claimed」，迟到回报重写已结束的一轮 |
| 2 | `automationRepo.markDispatchFailed` | `running` 复位与 `retry_at` 分两次写 | 必须同一条 UPDATE；否则卡在 running 直到 `CLAIM_STALE_MS` |
| 3 | `automationRepo.markManualRunDispatched` | run 置 dispatched 与 `run_count++` 分两次提交 | 必须同一事务；中间崩溃会让迟到回报再加一次计数 |
| 4 | `automationRepo.releaseManualClaim` / `touchManualClaim` | 锁被 scheduler 提前回收 / 续租晚于 stale 窗口 | `changes=0` 必须停止续租；晚续租无法撤回已发生的重复派发 |
| 5 | `automationRepo.releaseClaim` | 正常关机误走失败路径 | 关机释放不能累加 `dispatch_attempts`，否则几次重启耗尽 `DISPATCH_MAX_ATTEMPTS` |
| 6 | `offPeakTaskRepo.claimDue` | `COMMIT` 之后、`markRunning` 之前被杀 | 盘上是「queued + claim_running=1」；`recoverInterrupted` 不处理，只能等 `OFF_PEAK_CLAIM_STALE_MS` |
| 7 | `offPeakTaskRepo.markRunning` | 网关已受理、本地仍 queued | 必须与 admitted 回执同段同步执行；过期复领会重复派发同一任务 |
| 8 | `feedbackLocalTicketStore.upsert` / `read` / `write` | 单 JSON 覆盖写到一半 | 截断文件等价于「没有票据」；没有 temp+rename，崩溃即整份丢失 |
| 9 | `gitCheckpointStore.writeManifestAtomic` / `save` / `enqueueWrite` | temp 写完、rename 之前 | 目标仍是上一份完整元数据；先 rm 再 rename 会打开「文件不存在」窗口 |
| 10 | `gitCheckpointHelpers.buildCheckpointEnv` | 复用同一临时索引 | 上一次快照的暂存内容会串进下一次 diff；commit 后必须删除 |
| 11 | `settingsWriteQueue.withSettingsWriteQueueTimeout` / `buildSettingsTempFile` | 超时后旧写仍在跑 / rename 前被杀 | 超时只 reject 调用方；作废不彻底时旧值晚到覆盖新设置；temp 残留不回收 |
| 12 | `default-workspace/migration.migrateDefaultWorkspaceTasks` | 两条 UPDATE 之间崩溃 | 先解绑 `tasks.project_id` 再软删 `projects`；反序产生悬挂引用且不会再次被选中 |
| 13 | `tasksDatabase/prepared.ts` 三个导出 | 进程重启 / 路径写法不同 | Set 是进程内快速路径，不跨重启；键为 path 原串，调用方必须先归一 |
| 14 | `provider-selection-v2.importLegacyAutomationSelections` | 迁移被重复执行 | 旧三列保留，重跑会按陈旧旧值覆盖用户新选择；只能由一次性 migration 触发 |
| 15 | `oauthProfileSchema.withProviderProfileSchema` / `refreshLegacyBigModelCachedProfile` | 版本号与 retry-after 分两次写 | 必须在同一对象里一次 `saveProfile`；`saveProfile` 抛错会落进 userinfo 失败分支 |
| 16 | `outputStyleService.setActiveStyle` / `addStyle` / `updateStyle` | `settings.json` 被截断 / 风格文件被外部删除 | 损坏读成 null 会把共享配置「修复」成只剩 `outputStyle`；update 会重建已删文件 |
| 17 | `fileChangeTracker.record` / `deserialize` / `truncateAfterTurn` | before 内容读取晚于写盘 / 反序列化脏数据 | before=after 使 rewind 变成静默空操作；未校验数据可能把 undefined 写回文件 |
| 18 | `legacyAccountConnectionSettings.readIncompleteLegacyTeamConnections` | 新字段先落盘 | 必须先于 migrate 调用，否则缺失组织信息的 Team 条目再也不会被查询 |
| 19 | `legacyModelProviderSerialized.pathFromModelProviderEndpointUrl` | 端点路径归一错误 | `"/"` 折空串、去尾斜杠；search 必须保留，否则旧配置迁移后全部 401 |
| 20 | `subagentMarkdown.normalizeEnum` | 非法枚举值回写 | 返回 undefined 而非默认值，避免保存后静默变成另一个合法值 |

`taskIndexRepo` 与 `project-repository` 的写入点（`writeRecord`、`applyCliFacts`、`applyCliDeletion`、`saveProject`、`moveTask`）在 A 档已写清事务边界与单语句原子性，本批没有新增函数体内注释，避免复述。

## 2. 逐文件函数级内文率前后值（17 文件）

| 文件 | 前 | 后 | 增量 |
| --- | ---: | ---: | ---: |
| `session/tasksDatabase/prepared.ts` | 4/13（30.77%） | 6/13（46.15%） | +2 |
| `session/automationRepo.ts` | 347/1,124（30.87%） | 357/1,124（31.76%） | +10 |
| `feedback/feedbackLocalTicketStore.ts` | 27/87（31.03%） | 29/87（33.33%） | +2 |
| `session/taskIndexRepo.ts` | 336/1,077（31.20%） | 336/1,077（31.20%） | 0（只改写注水行，函数体无新增） |
| `model-provider/legacyModelProviderSerialized.ts` | 132/421（31.35%） | 134/421（31.83%） | +2 |
| `git/repo/gitCheckpointStore.ts` | 24/75（32.00%） | 28/75（37.33%） | +4 |
| `setting/legacyAccountConnectionSettings.ts` | 26/81（32.10%） | 26/81（32.10%） | 0（事实写在函数头，未进函数体） |
| `project-storage/project-repository.ts` | 114/354（32.20%） | 114/354（32.20%） | 0（只改写注水行） |
| `session/tasksDatabase/provider-selection-v2.ts` | 24/69（34.78%） | 24/69（34.78%） | 0（事实写在函数头） |
| `git/repo/gitCheckpointHelpers.ts` | 57/161（35.40%） | 57/161（35.40%） | 0（事实写在函数头） |
| `session/offPeakTaskRepo.ts` | 201/562（35.77%） | 205/562（36.48%） | +4 |
| `output-style/outputStyleService.ts` | 59/162（36.42%） | 66/162（40.74%） | +7 |
| `session/fileChangeTracker.ts` | 48/126（38.10%） | 53/126（42.06%） | +5 |
| `oauth/oauthProfileSchema.ts` | 37/97（38.14%） | 39/97（40.21%） | +2 |
| `subagents/subagentMarkdown.ts` | 141/336（41.96%） | 143/336（42.56%） | +2 |
| `project-storage/default-workspace/migration.ts` | 7/15（46.67%） | 11/15（73.33%） | +4 |
| `setting/settingsWriteQueue.ts` | 21/45（46.67%） | 22/45（48.89%） | +1 |
| **合计** | **1,605/4,805（33.40%）** | **1,650/4,805（34.34%）** | **+45** |

- 316 个函数：零注释 42 → 40，`<30%` 117 → 111，中位 35.09% → 36.91%，最低 30.77% → 31.20%。
- 5 个文件函数体计数为 0 增量：`taskIndexRepo` / `project-repository` 只做了注水改写；`legacyAccountConnectionSettings` / `provider-selection-v2` / `gitCheckpointHelpers` 的新事实落在函数头，按口径不计入函数体分子，未为了数字把它们移进函数体。
- 剩余 40 个零注释函数均为 getter、单表达式包装或路径拼接（如 `gitCheckpointStore.checkpointsDir`、`fileChangeTracker.getTurnCount`、`outputStyleService.getUserClaudeSettingsPath`、`subagentMarkdown.isObjectRecord`），按「纯 getter 跳过」保留。

## 3. 崩溃点两侧的写入顺序

### 3.1 调度与 run 台账（automationRepo）

- `markRunDispatch` 先落 run 台账，automation 的推进由 `markDispatched` / `markDispatchFailed` 随后执行，两步不在同一事务。先台账时，中间被杀只会延迟认领回收（等 `CLAIM_STALE_MS`）；反序会留下「automation 已释放、run 仍 claimed」的台账，迟到的 `running` 回报会把已结束的一轮又写一次。
- `markDispatchFailed` 的 `running` 复位与 `retry_at` 写在同一条 UPDATE；拆开会在中间窗口留下 `running=1` 且 `retry_at` 已写，任务要等 stale 过期才可能被再次认领。
- `markManualRunDispatched` 的 run 行置 dispatched 与 `run_count` 自增在同一事务；拆开提交会出现「计数已加、状态仍 claimed」，迟到回报通过幂等检查后再加一次。
- `releaseManualClaim` 的 `changes=0` 表示锁已被 scheduler 回收或归属不符，调用方必须停止续租；`touchManualClaim` 必须早于 `CLAIM_STALE_MS`，晚于该窗口时重复派发已经发生，续租无法撤回。
- `releaseClaim` 是关机路径，不能换成 `markDispatchFailed`：后者累加 `dispatch_attempts`，几次重启就足以耗尽 `DISPATCH_MAX_ATTEMPTS`。

### 3.2 off-peak 队列（offPeakTaskRepo）

- `claimDue` 在一个事务里完成 stale 扫描、候选选择与认领；`COMMIT` 之后、调用方 `markRunning` 之前被杀，盘上会保留「queued + claim_running=1」。`recoverInterrupted` 只把 `running` 回队，不处理这种行，只能等下一次 `claimDue` 按 `OFF_PEAK_CLAIM_STALE_MS` 复位。
- `markRunning` 必须与网关 admitted 回执在同一段同步逻辑里执行；网关已受理而本地仍 queued+claim 时，过期复领会再次派发同一任务。

### 3.3 单文件覆盖写（feedback / checkpoint / settings / migration）

- `feedbackLocalTicketStore.upsert` 是 read → 构造 next → `writeFile`，没有 temp+rename：写到一半被杀会留下截断 JSON，下次 `read` 判损坏返回空集合，整份票据丢失。`read` 把解析失败与 `ENOENT` 合并为空集合，所以写入侧只能整体覆盖、不能增量追加。
- `gitCheckpointStore.writeManifestAtomic` 先写 `tempPath` 再 rename：崩溃窗口内目标仍是上一份完整元数据；先 `rm` 再 rename 会打开「文件不存在」窗口，并发 `load` 会误判 checkpoint 被删。`save` 的 `mkdir` 必须早于写临时文件，否则 `writeFile(tempPath)` 直接 ENOENT。`enqueueWrite` 的链只在内存，进程被 kill 时排队操作不会补做。
- `settingsWriteQueue`：超时只 reject 调用方，不取消已在跑的 `runUpdate`，作废不彻底时旧值会晚到覆盖新设置；`buildSettingsTempFile` 在 rename 前被杀会留下 `.tmp`，不影响目标文件但不会自动回收。
- `migration.migrateDefaultWorkspaceTasks`：先解绑 `tasks.project_id` 再软删 `projects`。反序在崩溃窗口里留下「项目已 deleted 但任务仍指向它」的悬挂引用，且候选 SQL 的 `deleted=0` 使它不会再次被选中；外层没包事务时，自动提交会让该中间态真实落盘。

### 3.4 迁移与回写（prepared / provider-selection / oauth / outputStyle / fileChangeTracker / legacy）

- `prepared` 的两个 Set 是进程内快速路径，不跨重启；键为 path 原串，同一库经不同分隔符或大小写传入会被当成两个库。`migrated` 不代表连接可用，仍必须校验 `areTasksDatabaseMigrationsApplied`。
- `provider-selection-v2.importLegacyAutomationSelections` 只能由一次性 migration 触发：旧三列保留，重跑会按陈旧旧值覆盖用户后来写入的 `model_selection`。
- `oauthProfileSchema.withProviderProfileSchema` 的版本号与 retry-after 必须在同一对象里一次 `saveProfile` 写出；拆开时「retry-after 已清、版本未写」会让下次启动立刻重打 userinfo。成功分支的 `saveProfile` 抛错会落进 catch 被当作 userinfo 暂时性失败，两次写盘都失败时调用方必须保留登录态。
- `outputStyleService.setActiveStyle` 在 `settings.json` 损坏时会把 `{}` 当现有配置写回，只剩 `outputStyle`，`hooks`/`permissions` 永久丢失；`addStyle` 的整段 `writeFile` 中途被杀时仍可能解析出标题；`updateStyle` 会重建被外部删除的文件。
- `fileChangeTracker.record` 的 `beforeContent` 必须在写盘前读取，否则 before=after，rewind 变成静默空操作；`deserialize` 不做 schema 校验；`truncateAfterTurn` 只截内存，持久化副本必须由调用方重写。
- `legacyAccountConnectionSettings.readIncompleteLegacyTeamConnections` 必须先于 migrate：新字段一旦写入，`needsLegacyAccountConnectionMigration` 返回 false，未补全的 Team 条目再也不会被查询。

## 4. 复述型注释复核

对新增的 31 处注释块和触碰函数的内文注释做了一遍复核，命中 5 处，全部按改写模式处理，没有保留「更正行」：

| # | 函数 | 问题 | 处理 |
| ---: | --- | --- | --- |
| 1 | `settingsWriteQueue.withSettingsWriteQueueTimeout` | 新增行与下方「先 expireCurrentWrite 再 reject」重复，且把「作废」说了两遍 | 收缩为「超时只 reject、旧值可能晚到覆盖」这一条后果 |
| 2 | `automationRepo.markRunDispatch` | 新增行复述相邻既有的「只回写 run 台账，不碰 automation」 | 删掉复述半句，只保留两条路径的崩溃中间态对比 |
| 3 | `migration.migrateDefaultWorkspaceTasks` | 新增行复述上方「事务边界由调用方保证」 | 改写为「外层没包事务时中间态会真实落盘」的后果 |
| 4 | `automationRepo.releaseManualClaim` | 内文「只释放 manual run 的锁」与函数头同义，没有后果 | 改写为 `changes=0` 时调用方必须停止续租 |
| 5 | `automationRepo.touchManualClaim` | 内文「续租避免被判僵尸」与函数头同义 | 改写为「必须早于 CLAIM_STALE_MS，晚了无法撤回重复派发」 |

复核结论：**5 处复述/重复，0 处写错对象**。另外逐条回查了 7 个容易写错对象的高风险断言（`expireCurrentWrite` 的实际调用点、`markDispatched` 是否存在、`migration` 的事务边界归属、`outputStyle` 的目标文件是 `settings.json`、`readIncompleteLegacyTeamConnections` 与 migrate 的先后、`withProviderProfileSchema` 是否单对象返回、`parseMarkdownStyle` 的 `name` 行是否可单独解析），均与代码一致后才保留。

## 5. 注水旧账

17 个文件在 HEAD 之后、本批之前已有 75 行无信息/列举式单行句（A 档遗留）。全部按一换一改写为带真实标识符或谓词的句子，没有删除行，所以 `addedCommentLines` 不变、`waterLines` 归零：

```text
node _annot_baseline/zc-gate.mjs --scan _annot_baseline/ZC-deep-svc-p1b/_files.txt
SUMMARY files=17 badFiles=0 addedCommentLines=2496 waterLines=0 waterRate=0.00%
```

## 6. 验收

```text
node _annot_baseline/zc-verify.mjs --rewrite ZC-deep-svc-p1b
SUMMARY files=17 rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
```

```text
node _annot_baseline/zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src \
  --threshold 100 --top 17 --fns 999 --only <17 文件> --out _annot_baseline/ZC-p1-funcs-after.json
SUMMARY files=17 innerCode=4805 innerZh=1650 below100=17 min=31.20 median=36.48
```

```text
node _annot_baseline/zc-stringscan.mjs D:/code/ZCode
SUMMARY repo=ZCode files=9818 hits=96 new=0 inHead=96 untracked=0
```

## 7. 剩余未做项及理由

| 项 | 状态 | 理由 |
| --- | --- | --- |
| P1 持久化/崩溃窗口 17 文件 | 完成 | 每个触碰函数至少一条前置/顺序/失败后果；崩溃点两侧写入顺序已逐条写清 |
| P1 中 5 个文件函数体计数 +0 | 接受 | 事实写在函数头或只做注水改写；不为百分比把句子搬进函数体 |
| 剩余 40 个零注释函数 | 不补 | getter、单表达式包装、路径拼接，没有状态/IO/安全语义 |
| P2 协议状态机与生命周期 17 文件 | 未开始 | 按本轮约定挂起，等 P1 结果评估余量后再定 |
| A 档 51 文件整体 | 已完成 | 见 `ZC-DEEP-svc-triage.md` 3.1 实测复核 |

未执行 `git add` / `git commit`；未改动 P2 文件与任何代码 token。
