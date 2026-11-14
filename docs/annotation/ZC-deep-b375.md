# ZC-deep-b375

> 批次：b375 ｜ **30 行 / 10 文件** ｜ 提交 `4d4fc015`

## 0. 普通批；`fix=1`；**判据类 0.0% / 格式类 1 / lint 0**

- `plan_lines_covered=30/30`；`removed=30 added=0 allowed=42 auto_self_clear=0`。
- 首轮 **1 行命中**：`zcodeAgentProcessManager.ts:332` 的 **`indentChanged`**——
  原文该行顶格（缩进 `""`），我改写时按周围代码缩进补了 6 个空格，record 闸直接拦下。
  `fix=1`（去掉缩进后复跑，`GATE ALL PASS`）。
- **口径（b378 订正）**：本条是**格式类**，不是判据类。历史 `34/330` 的分子全是判据类（L/W/锚点/谓词），
  **不含缩进**，所以本批不能记成 `hit_rate=3.3%` 去和历史曲线并列。
  按新三列：**判据类 0（0.0%）/ 格式类 1 / 落笔前 lint 0**。
- 口径收获：**`1→1` 改写的缩进必须逐字沿用原行，不能按上下文「看起来对」去对齐**；
  该行本身是顶格注释，与相邻代码块缩进不一致是原文件既有状态。

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/provider-node/src/zcode-builtin-provider-config-source.ts` | 3 | 0 |
| `packages/server/src/remote/zcodeAgentDevDeploy.ts` | 3 | 0 |
| `packages/services/src/model-provider/accountProviderConnectionResolver.ts` | 3 | 0 |
| `packages/services/src/session/automationRepo.ts` | 3 | 0 |
| `packages/services/src/session/tasksDatabase/schema-v1.ts` | 3 | 0 |
| `packages/services/src/telemetry/telemetryCore.ts` | 4 | 1 |
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` | 3 | 0 |
| `packages/shared/src/index.ts` | 3 | 0 |
| `packages/shared/src/zcode-protocol-v4/wire-reassembly.ts` | 3 | 0 |
| `packages/shared/src/zcode-protocol/index.ts` | 4 | 1 |
| **合计** | **32** | **2** |

**固定对账列（§6.2 第 24 条，每批必报）**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 恒等式 |
| ---: | ---: | ---: | --- | --- |
| **10** | **8** | **0** | 1,571 → 1,563 | `1,571 − 8 + 0 = 1,563` ✔ |

- 剩 2 行池外残留：`telemetryCore.ts:497`（blame `872ad960`）、`zcode-protocol/index.ts:379`（`872ad960`），
  与 `pick` 的 `up/out` 完全一致；**无新进 weak，无质量问题**。
- 顶层目录 **4 个**（provider-node / server / services / shared）。

## 2. 改动内容

- `zcode-builtin-provider-config-source.ts`：`onDidChange` 先 `#assertNotDisposed()`；`#listeners` 去重；`#dispose()` 清空。
- `zcodeAgentDevDeploy.ts`：`computeDevelopmentAgentAssetsSha256` 全量读盘；`shouldSkipDevelopmentZCodeAgentDeploy`
  宁多传一次；`buildRemoteAgentBundleWrapper` 生成脚本。
- `accountProviderConnectionResolver.ts`：读 `lastKnownGood` 前先比身份；`identitiesUnchanged` 多一次读；
  `createAccountProviderConfigSource` 只组装。
- `automationRepo.ts`：`getScheduledRunCount` 只数定时；返回的 `automation` 覆盖 `running: 1`；
  `ORDER BY created_at ASC` 决定派发序。
- `schema-v1.ts`：`AUTOMATION_SCHEMA` 两表顺序；五组列的读法；时间列毫秒整数举例。
- `telemetryCore.ts`：`isFreshDailyActiveInFlight` 的僵尸判定；`date` 不匹配；`reportAppDailyActive` 三阶段。
- `zcodeAgentProcessManager.ts`：`tail` 超限 `shift()`；`resolveBundledWorkspaceZCodeAgentCommand` 为空时旧协议；
  `firstCleanupReason` 作根因。
- `shared/index.ts`：`export * from "./errors.js"` 的权衡；`sanitizeTelemetryEventDetail` 收口；
  `ProjectAccessTokenInput` / `Material` 成组导出。
- `wire-reassembly.ts`：编码只估体积；`topic` + `subscriptionId` 双校验；`frame` 非对象不读原型链。
- `zcode-protocol/index.ts`：`operationId` 回传；`snoozedInteractionCount` 的必要性；
  `zcodeSkillsReferenceCatalogResultSchema` 不与插件目录合并。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=2
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=2 verify_ok=true
gate: PASS commit n=0 sha=4d4fc015 files=10/10 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=42 auto_self_clear=0
gate: PASS order n=0 total=394.0s controllable=119.0s
GATE ALL PASS batch=b375 sha=4d4fc015
```

- 首跑失败一次：`record` 闸 `indentChanged=1`（`record_runs=2` 即证据）。

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` 数据行 **12 条**（b379 复核：手工 6 + 自动 6；旧记 11 漏了 b373 的自动登记）。

## 5. 进度

- 全仓 weak：**3,793 → 3,763**（−30）；filler 104 → 98；weak 文件 **1,571 → 1,563**（−8，末行 `files=`）。
- 池内：**524 行 / 344 文件**（`ALIGNED diff=0`、`ASSERT PASS`）。
- `done 6,897 / remain 524`；`6,897 + 524 = 7,421`。
- **行侧进度 92.9%**（6,897 ÷ 7,421）——唯一进度分母；文件侧 `663 ÷ 1,007 = 65.8%`（辅助）。
- 可清 **43**（1,563 − 1,520）；含不可写残留 **1,520** 未变。
- 剩余批数（cap 10）：**35 批**（344 ÷ 10），行/批均值 `524 ÷ 35 = 15.0`。
- **订正（b376 发现）**：本批原记 `1,572 → 1,564`、可清 44，都比 `deep-quality` 末行 **+1**；
  差值 −8 正确，绝对值已按末行改写。同一订正见 INDEX §6.2 第 24 条。

## 6. 计时（分段实测）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `d5dcd2d9` | `4d4fc015`（14:26:46） | 394.0 |
| `controllable` | `--start`（14:24:47） | 批次提交 | **119.0**（`s/行 = 3.97`） |
| **S0** 提交 → 收口命令启动 | 14:26:46 | 14:26:55 | **9** |
| **S1** 改写表落盘 + 全仓扫描 | 14:26:55 | 14:27:04 | **9** |
| **S2** `own-commits-gen` + `capacity` | 14:27:04 | 14:27:05 | **1** |
| **S3** 台账写作 + 对账命令 | 14:27:05 | 14:27:40 | **35** |
| **S4** `git add` + `commit` | 14:27:40 | 14:27:41 | **1** |
| **合计** | 14:26:46 | 14:27:41 | **55s** |
| `批墙钟` | 14:24:47 | 14:27:41 | **174s** |

## 7. 滚动中位与时长最终判定（b375 判定点）

| 窗口 | 中位 `s/行` | 中位收口 | 中位墙钟 | 剩余批数 | 区间读数 |
| --- | ---: | ---: | ---: | ---: | --- |
| b372–b374（上轮） | 3.73 | 61s | 451s | 36 | 1.3–4.5h |
| **b373–b375（本轮）** | **3.73** | **55s** | **174s** | **35** | **1.2–1.7h** |

- 窗口移动：`332s`（b372）移出、`55s`（b375）移入 → 中位收口 `61 → 55s`、中位墙钟 `451 → 174s`。
- **判定触发（写死的规则）**：窗口 b373–b375 中位收口 `55s ≤ 60s` → **主报下修到 1.2–1.7h**。
  预登记值是 `1.2–1.5h`，差异来自剩余批数 `38 → 35`（每批固定项乘得少，但上沿用墙钟 174s 算得 1.69h），
  两个数都由同一窗口法给出，**不是两套口径**。
- 下沿 `35 × (14 + 15.0×3.73 + 55) ≈ 4,375s = 1.22h`；上沿 `35 × 174s = 6,090s = 1.69h`。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `4d4fc015` | `+30/−30` |
| `ZC-deep-b375-rewrite.tsv` + 本台账 + 白名单（645 行） | `8465f1b2` | — |
