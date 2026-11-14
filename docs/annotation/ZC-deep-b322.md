# ZC-deep-b322

> 批次：b322 ｜ 42 行 / 4 文件 ｜ 提交 `3f2f4a05`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准按新规则默认解析（未复制快照）

- 本批是 `--start` 基准前置校验上线后的第一个批次，**没有复制任何快照**：
  `gate: PASS start ... pre-weak=b321-repo-post.txt`——基准由默认规则 `b{批号-1}` 解析而来，
  文件名直接落在闸日志里，next batch 可回溯。
- `scope` / `record` / `verify` / `commit` / `pool-diff` / `order` 全部首跑 PASS：
  `out_of_scope_edits=0`、`record_runs=1`、`numstat=42/42`、
  `pool-diff removed=42 added=0 allowed=47 auto_self_clear=0`。
- 负例（缺基准即 `exit 1`、不落 `t-start`、工作树不变）已在开批前实跑，记录见 `ZC-deep-b321.md` §12，
  本批是恢复文件名后的正常开批，未再触发。
- 结论：**无违规、无补跑**；b321 的闸序问题在本批未被复现。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/v4/composer/ConversationBackgroundWorkTrigger.tsx` | 11 | 0 | 11 | 0 |
| `packages/ui/src/v4/telemetry/localTtftRecord.ts` | 11 | 0 | 11 | 0 |
| `apps/zcode-cli/packages/cli/src/command-center/handlers/expert.ts` | 10 | 0 | 10 | 0 |
| `apps/zcode-cli/packages/cli/src/command-center/login-flow.ts` | 10 | 0 | 10 | 0 |
| **合计** | **42** | **0** | **42** | **0** |

- 本批四个文件 `upOut=0`，批后 weak 全清零；文件数 1,794 → 1,790。
- 按 §6.1 浮动规模取 4 文件 42 行（11 + 11 + 10 + 10），落在 33–44 区间内。

## 2. 改动内容

- `ConversationBackgroundWorkTrigger.tsx`：只统计 `status === "running"`、工作流单独计数、
  `subagentCount` 用 `Math.max` 钳到 0、总数三类求和、无回调或零计数不渲染、活动类别数派生、
  工作流详情优先、单一类别专属文案、读屏标签携带全部计数、宽窄两套布局、图标顺序终端在前、
  零计数不出图标、测试标识固定、计数写数据属性、点击交给宿主、记忆化与引用缓存、等宽数字。
- `localTtftRecord.ts`：版本固定为 1、时钟漂移 >100ms 标坏、checkpoint 取首字节、
  校准需同实例且未过期、未对齐只记 `missing`、间隔逆序或非有限数判无效、阶段命名、
  仅对齐时补 `command_admission`、CLI 时钟来源、`output_return` 需首字节、
  确认等待累加、`LOCAL_TTFT_MAX_DETAILS` 截断并打 `truncated`、两路可靠性、
  执行耗时条件给出、`clockErrorMs` 带出、行类型只留标识。
- `expert.ts`：空参数默认 `status`、`cancel` 归一 `stop`、未知首词整体作为任务、
  空运行号转 `undefined`、能力缺失返回提示、各动作先校验能力、启动/恢复自动切 `yolo`、
  已是目标模式不重复切换、`abortSignal` 与 `onEvent` 透传、`traceId` 优先取结果、解析按首空白切分。
- `login-flow.ts`：四项入口固定、两项 OAuth 与两项密钥成对、选择器不可过滤、
  文案全走 i18n、密钥掩码、`command` 即分发标识、关键词覆盖、待定态文案齐备、
  裸登录只返回引导、账号显示名三级回退、浏览器失败只提示、结果四行固定顺序、
  手填结果按提供方取名、无 `onEvent` 静默跳过、事件标识随机 UUID、首词决定分支、密钥允许含空白。

## 3. 门禁读数（全部首跑）

```text
gate: PASS start     t-start=09:13:42Z pre-weak=b321-repo-post.txt
gate: PASS scope     n=0 plan=42 allow=0 diff_old=42 diff_new=42 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=3f2f4a05 files=4/4 numstat=42/42 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=42 added=0 allowed=47 auto_self_clear=0
gate: PASS order     t-start=09:13:42Z < t-record=09:15:57Z <= t-verify=09:15:59Z < commit=17:16:20+08:00
                     batch_wall_total=164.0s batch_wall_controllable=158.0s
```

## 4. 首轮命中与返修

- 首轮 **2 / 42**，均为 `L/无信息列举`，`record_runs=1`：
  1. `ConversationBackgroundWorkTrigger.tsx:40`——`Math.max(0, runningSubagentCount)` 里的 **ASCII 逗号**也计入
     判据的列举符号；改为「用 Math.max 把 runningSubagentCount 下限钳到 0」。
  2. `login-flow.ts:121`——`user.name、user.email、user.user_id` 两个 `、`；改为「依次试 user.name 与 user.email
     与 user.user_id 取首个非空值」。
- 返修后 `hits=0`，重跑 `record` → `verify` → `commit` 全绿，`numstat=42/42` 未变。

## 5. 自清（累计第 13 批无自清；本批 0 自动、0 人工）

- `removed=42`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=42 + 5 = 47`）。
- `auto_self_clear` 仍未首次生效（b313–b322 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b321 5,426` → `post-b322 5,384`（**−42**），文件 `1,794 → 1,790`。
- **句子级口径**：`done 5,283 / remain 2,138`，`5,283 + 2,138 = 7,421`，**71.2%**。
- **逐行口径**：`remain ≈ 2,138 + 1,046 = 3,184`，`done ≈ 4,237 / 7,421`，约 **57.1%**。
- 池外：`5,384 − 2,138 = 3,246`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b321-guard-post.txt`）。
- `capacity-estimate --batch b322`：`done files=383 (+4) / lines=5,283 (+42)`，
  `REMAIN 624 files / 2,138 lines`，`ALIGNED acct_remain=2138 pool_remain=2138 diff=0`，分档合计 313 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`383 + 624 = 1,007`、`5,283 + 2,138 = 7,421` → **PASS**。
- 白名单重跑到 `3f2f4a05`，**409 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b321-repo-post.txt
node _annot_baseline/pick-generic.mjs b322 d:/code/_annot_baseline/b322-files.txt d:/code/_annot_baseline/b321-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b322 --start
node _annot_baseline/judge-generic.mjs b322
node _annot_baseline/gate-run.mjs --batch b322 --subject "注释清水 b322：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b322-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b322-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b322-repo-post.txt --pre-weak d:/code/_annot_baseline/b321-repo-post.txt --batch b322
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `cdae1e84`，17:13:36） | 批次提交 `3f2f4a05`（17:16:20） | 164.0s | 3.90s |
| `controllable` | `--start`（17:13:42） | 批次提交（17:16:20） | 158.0s | 3.76s |
| `批墙钟` | 本批最早可观测产物 `b322-files.txt`（17:13:28；选行调用略早，故此值为下限） | 台账提交 `dbd4bd63`（17:19:31） | 363s | 8.64s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（4 文件 1→1 改写） | `3f2f4a05` | `+42/−42` |
| `ZC-deep-b322-rewrite.tsv` + 白名单 409 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,138≠0`；A2 `5,283 + 2,138 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,283 + 0 + 2,138 = 7,421` 成立。
