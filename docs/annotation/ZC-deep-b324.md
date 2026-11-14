# ZC-deep-b324

> 批次：b324 ｜ 42 行 / 4 文件 ｜ 提交 `249ca837`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b323-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 十一闸全部首跑 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=42/42`、
  `pool-diff removed=42 added=0 allowed=47 auto_self_clear=0`。
- 本批无返修、无邻行连带；`git diff --stat` 落笔后即为 `42 insertions / 42 deletions`，与 plan 全等。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/components/ui/context-menu.tsx` | 11 | 1 | 11 | 1 |
| `packages/ui/src/project-sidebar/ProjectTaskRows.tsx` | 11 | 1 | 11 | 1 |
| `packages/shared/src/channel-mention.ts` | 10 | 0 | 10 | 0 |
| `packages/shared/src/coding-plan-subscription.ts` | 10 | 0 | 10 | 0 |
| **合计** | **42** | **2** | **42** | **2** |

- 42 行 = 11/11/10/10，落在 33–44 浮动区间内。
- 两行池外 weak 均为**上游 blame**，未进 plan：
  `context-menu.tsx:39`（`872ad960`）、`ProjectTaskRows.tsx:186`（`0a1fc56d`）。
  它们不属本线落笔范围，批后仍留在全仓 weak 里，故这两文件批后 weak 各为 1 而非 0。

## 2. 改动内容

- `context-menu.tsx`：`ContextMenuContent` 的外壳圆角与 `cn()` 末位合并、`ContextMenuItem` 的
  `min-h-7` 高度、`inset` / `destructive` 两组 `data-*` 属性、禁用态只关 `pointer-events`、
  `ContextMenuSubTrigger` 的 `ChevronRightIcon` 与 `ml-auto`、展开态与高亮态共用 `bg-menu-hover`、
  `children` 先于箭头渲染、子菜单 `min-w-32` 与 `min-w-44` 的宽度差、`duration-100` 与 fade/zoom 同源、
  `origin-(--radix-context-menu-content-transform-origin)` 的缩放锚点。
- `ProjectTaskRows.tsx`：`pinnedTasks` 未置顶时取 `EMPTY`、`ProjectTask[]` 标注拒绝写入、只读传参；
  `rows` 的 `useMemo` 依赖只有 `task`、`organizationActions` 同源命中 memo、两处 `TaskList` 入参共享引用；
  `kind` 决定 `pageSize` 与 `taskRowVariant`、`showEmptyState` 只透传；`pageSize` 作为 `useState` 初值、
  `pinned` 分支忽略 `limit` 改用 `showAll`、挂载后不随 `kind` 重算。
- `channel-mention.ts`：`channelReplyPartsSchema` 与 `channelContentPartSchema` 的 `text` 形状一致、
  `text` 2000 字符与 `refId` 1–200 的上限、`mentionName.candidateRef` 可缺省、`.min(1)`/`.max(50)` 段数约束；
  `channelContentText` 原样保留 `text` 片段、提及展开为 `@name`、`join("")` 不加分隔符；
  `resolveChannelReplyParts` 先建 `refId` 映射、同 `refId` 异 `JSON` 抛错、只接受 `refId` / `mentionName`。
- `coding-plan-subscription.ts`：`CodingPlanPayType` 与 `CodingPlanOverseasPaymentChannel` 不合并的理由、
  两套金额口径的字段名、`CodingPlanStaticTeamProduct.priceCurrency` 钉死 `"CNY"`、
  `estimatePayAmount` 只是渠道提示、企业定价按组织与项目取上下文、三段余额由服务端给出、
  试算响应三个顶层金额必填、`discountDetails` 不参与计算、建单两个抵扣字段可缺省、待支付订单 `amount` 与 `totalAmount` 的区别。

## 3. 门禁读数

```text
gate: PASS start     t-start=09:26:18Z pre-weak=b323-repo-post.txt
gate: PASS scope     n=0 plan=42 allow=0 diff_old=42 diff_new=42 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=249ca837 files=4/4 numstat=42/42 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=42 added=0 allowed=47 auto_self_clear=0
gate: PASS order     total=175.0s controllable=127.0s
```

## 4. 首轮命中与返修

- 首轮 **0 / 42**（`judge-generic.mjs b324` → `hits=0`），无返修、无越界。
- 本批改写统一采用「点名标识符」的写法：每条注释至少带一个 `data-*`、类名、字段名或函数名，
  避免落进 `W/单行无信息`；同时每条最多一个 `，`，需要多处并列时改用 `：` 或 `与`，
  避免触发 `L/无信息列举`。这是 b323 §4 两次 `W` 与两次 `L` 的直接经验结晶。

## 5. 自清（累计第 15 批无自清；本批 0 自动、0 人工）

- `removed=42`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=42 + 5 = 47`）。
- `auto_self_clear` 仍未首次生效（b313–b324 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b323 5,344` → `post-b324 5,302`（**−42**），文件 `1,786 → 1,784`。
- **句子级口径**：`done 5,365 / remain 2,056`，`5,365 + 2,056 = 7,421`，**72.3%**。
- **逐行口径**：`remain ≈ 2,056 + 1,046 = 3,102`，`done ≈ 4,319 / 7,421`，约 **58.2%**。
- 池外：`5,302 − 2,056 = 3,246`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b323-guard-post.txt`）。
- `capacity-estimate --batch b324`：`done files=391 (+4) / lines=5,365 (+42)`，
  `REMAIN 616 files / 2,056 lines`，`ALIGNED acct_remain=2056 pool_remain=2056 diff=0`，分档合计 309 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`391 + 616 = 1,007`、`5,365 + 2,056 = 7,421` → **PASS**。
- 白名单重跑到 `249ca837`，**417 行**（开批前 415 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b323-repo-post.txt
node _annot_baseline/pick-generic.mjs b324 d:/code/_annot_baseline/b324-files.txt d:/code/_annot_baseline/b323-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/own-commits.mjs d:/code/ZCode --verify
node _annot_baseline/gate-run.mjs --batch b324 --start
node _annot_baseline/judge-generic.mjs b324
node _annot_baseline/gate-run.mjs --batch b324 --subject "注释清水 b324：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b324-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b324-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b323-guard-post.txt --post d:/code/_annot_baseline/b324-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b324-repo-post.txt --pre-weak d:/code/_annot_baseline/b323-repo-post.txt --batch b324
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `85ac0ff0`，17:25:30） | 批次提交 `249ca837`（17:28:25） | 175.0s | 4.17s |
| `controllable` | `--start`（17:26:18） | 批次提交（17:28:25） | 127.0s | 3.02s |
| `批墙钟` | 本批最早可观测产物 `b324-files.txt`（17:25:10） | 台账提交 `c0573d62`（17:30:09） | 299s | 7.12s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，415 行） | `85ac0ff0` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `249ca837` | `+42/−42` |
| `ZC-deep-b324-rewrite.tsv` + 白名单 417 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,056≠0`；A2 `5,365 + 2,056 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,365 + 0 + 2,056 = 7,421` 成立。
