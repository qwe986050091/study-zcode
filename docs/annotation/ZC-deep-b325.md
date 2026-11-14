# ZC-deep-b325

> 批次：b325 ｜ 40 行 / 4 文件 ｜ 提交 `8795e11e`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 首次 `AUTO-SELF-CLEAR`（池外、上游 blame）；无越界；基准默认解析

- `gate: PASS start ... pre-weak=b324-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 十一闸全部首跑 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=40/40`。
- `pool-diff` 输出 **`removed=41 added=0 allowed=46 auto_self_clear=1`**：
  `packages/ui/src/mentions/providers/pluginsMentionProvider.ts:51`（`872ad960`，上游 blame、池外）
  在相邻改写后转强，命中 b313 写定的自动分流第 4 条，登记为 `AUTO-SELF-CLEAR … reason=adjacent`。
  该行不在 plan 内、不增加落笔量，故 `removed=41` 比 `numstat=40` 多 1。详见 §5。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/mentions/providers/pluginsMentionProvider.ts` | 10 | 1 | 10 | 0（池外行自清） |
| `packages/ui/src/onboarding/useOnboardingTelemetry.ts` | 10 | 1 | 10 | 1 |
| `packages/shared/src/mcp-apps/sampling.ts` | 10 | 0 | 10 | 0 |
| `packages/shared/src/source-server/compatibility.ts` | 10 | 0 | 10 | 0 |
| **合计** | **40** | **2** | **40** | **1** |

- 40 行 = 10/10/10/10，落在 33–44 浮动区间内。
- 两行池外 weak 均为上游 blame：`pluginsMentionProvider.ts:51`（`872ad960`）本批**自清**；
  `useOnboardingTelemetry.ts:56`（`872ad960`）仍在，故该文件批后 weak 为 1。

## 2. 改动内容

- `pluginsMentionProvider.ts`：官方市场条目先行与 `sortPluginStoreEntries` 排序键、非公开市场条目原序拼接、
  `entry.enabled` 过滤、`conflictingPluginIds` 的 `disabled: true` 与 `labels.conflictReason`；
  `modeOrder` 取 `order?.work` / `order?.code`、`enabled=false` 不发请求、目录错误包成异常对象；
  `displayLabel` 走 `resolvePluginDisplayName`、`item.label` 固定 `entry.name`、`keywords` 合并 `displayNameI18n`。
- `useOnboardingTelemetry.ts`：`workDirections` 的 `OccupationValue` 穷尽映射、`Record` 强制补全、
  `occupation` 为 null 上报字面量 `"null"`；三个业务开关由引导组件持有、`exposure` 的记录范围、
  `useRef` 持有、`ended` 挡重复上报；`useCallback` 捕获点击瞬间值、`ended` 置位后早退、跳过重复曝光上报。
- `sampling.ts`：`messages` 的 `.min(1)`/`.max(MCP_APPS_SAMPLING_MAX_BLOCKS)`、`systemPrompt` 独立字节上限、
  `includeContext` 只接受 `"none"`、`metadataBytes` 计入总预算；`decodedBytes` 的 base64 估算与填充扣减、
  与 `MCP_APPS_IMAGE_MAX_BYTES` 比较；结果 schema 的 `role` 字面量、`model`/`stopReason` 必填、只收 text 块。
- `compatibility.ts`：清单三字段与 `.trim()`/`.min(1)`、`.strict()` 拒绝未知字段；
  `parseVersion` 的正则（`v` 前缀、`+build` 构建号）、预发布段按 `.` 切分、不匹配即抛 `Error`；
  `compareCompatibilityVersions` 的三段顺序、正式版高于同号预发布、`compareIdentifier` 的数字/字母规则。

## 3. 门禁读数

```text
gate: PASS start     t-start=09:30:59Z pre-weak=b324-repo-post.txt
gate: PASS scope     n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=8795e11e files=4/4 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
AUTO-SELF-CLEAR packages/ui/src/mentions/providers/pluginsMentionProvider.ts:51 reason=adjacent
gate: PASS pool-diff n=0 removed=41 added=0 allowed=46 auto_self_clear=1
gate: PASS order     total=84.0s controllable=77.0s
```

## 4. 首轮命中与返修

- 首轮 **1 / 40**：`sampling.ts:130` `W/单行无信息`——原句 `末尾 "==" 扣 2 字节、单个 "=" 扣 1 字节。`
  没有 ASCII 标识符，只有数字与符号；改为 `末尾 "==" 由 base64 填充规则扣 2 字节，单个 "=" 扣 1 字节。`
  后归零（`base64` 提供锚点，`由` 顺带满足列举判据的谓词要求）。
- 返修后 `hits=0`，`record → verify → commit` 全绿，`numstat=40/40`，无越界、无连带。

## 5. 自清（**首次生效**：1 行自动、0 人工）

- `POOL-SELF-CLEAR.tsv` 新增 1 条：`pluginsMentionProvider.ts:51`，`reason=adjacent`，桶 = 池外 + 上游 blame。
- 判据回顾（`classifySelfClear`，与 `--selftest-selfclear` 同一实现）：`inPlan=false`、`registered=false`、
  `inPool=false`、`blameOk=true`、`isOwn=false` → `auto`。若任一项不满足会走 `IN-POOL` /
  `UNREGISTERED` 硬失败，不会静默放行。
- 记账影响：该行在池外，不进 `done`、不进 `remain`；本批 `done 5,323 → 5,365`（**+40**，等于落笔），
  `remain 2,056 → 2,016`（**−40**），弱集减少 41 行（40 落笔 + 1 池外自清），文件 `1,784 → 1,781`。
  也就是说 `removed` 与 `numstat` 的 1 行差额**全部落在池外**，A2 等式不受影响。
- 累计：b313–b324 连续 12 批 0 次，本批首次出现；仍为**池外**自清，`池内自清累计 = 0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b324 5,302` → `post-b325 5,261`（**−41**），文件 `1,784 → 1,781`。
- **句子级口径**：`done 5,405 / remain 2,016`，`5,405 + 2,016 = 7,421`，**72.8%**。
- **逐行口径**：`remain ≈ 2,016 + 1,046 = 3,062`，`done ≈ 4,359 / 7,421`，约 **58.7%**。
- 池外：`5,261 − 2,016 = 3,245`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b324-guard-post.txt`）。
- `capacity-estimate --batch b325`：`done files=395 (+4) / lines=5,405 (+40)`，
  `REMAIN 612 files / 2,016 lines`，`ALIGNED acct_remain=2016 pool_remain=2016 diff=0`，分档合计 307 批；
  `SELF-CLEAR n=1` 明细：可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0，只有可写桶进配额扣减，本批扣 0。
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`395 + 612 = 1,007`、`5,405 + 2,016 = 7,421` → **PASS**。
- 白名单重跑到 `8795e11e`，**421 行**（开批前 419 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b324-repo-post.txt
node _annot_baseline/pick-generic.mjs b325 d:/code/_annot_baseline/b325-files.txt d:/code/_annot_baseline/b324-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b325 --start
node _annot_baseline/judge-generic.mjs b325
node _annot_baseline/gate-run.mjs --batch b325 --subject "注释清水 b325：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b325-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b325-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b324-guard-post.txt --post d:/code/_annot_baseline/b325-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b325-repo-post.txt --pre-weak d:/code/_annot_baseline/b324-repo-post.txt --batch b325
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `4833389d`，17:30:52） | 批次提交 `8795e11e`（17:32:16） | 84.0s | 2.10s |
| `controllable` | `--start`（17:30:59） | 批次提交（17:32:16） | 77.0s | 1.93s |
| `批墙钟` | 本批最早可观测产物 `b325-files.txt`（17:30:44） | 台账提交 `4b2f5e26`（17:34:00） | 196s | 4.90s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，419 行） | `4833389d` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `8795e11e` | `+40/−40` |
| `ZC-deep-b325-rewrite.tsv` + `POOL-SELF-CLEAR` 1 行 + 白名单 421 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,016≠0`；A2 `5,405 + 2,016 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,405 + 0 + 2,016 = 7,421` 成立（池内自清仍为 0，本批 1 行自清在池外）。
