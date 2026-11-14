# ZC-deep-b345

> 批次：b345 ｜ 23 行 / 4 文件 ｜ 提交 `54137387`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 23 行（**碎尾批**：15–24 区间首例，按 §6.1 第 4 条与 §12.6 登记）

- 候选最高档只有 1 个 `7/7`，其后是 `6/7`、`5/7`、`5/7`：7 + 6 + 5 + 5 = **23**，落在碎尾区间。
- 触发条件 ① `ownIn` 最高档 7、② 最大 4 文件合计 23（<25），两条同时成立；第 5 个候选只有 4 行，
  补进来 27 行仍低于 33，按规则不补、保持 4 文件结构。
- `TALLY {"ownIn":23,"ownOut":0,"upIn":0,"upOut":5,"pending":0,"planIn":23,"planOut":0}` / `plan=23 ownOutAllow=5` / `files=4/4`。
- 本批是形状 A 的最后一小段（b345–b349 仍按 4 文件），b350 起切形状 B（§6.1 第 5 条）。
  本批 `批墙钟` 归入 A 段计时序列，**不与 B 段合并**；同时按 §12.6 计入碎尾批第二套读数。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/shared/src/zcode-protocol-v4/wire-codec.ts` | 7 | 0 | 7 | 0 |
| `packages/ui/src/RemoteConnectionFields.tsx` | 6 | 1 | 6 | 1（上游） |
| `packages/services/src/bots/providers/feishuProvider.ts` | 5 | 2 | 5 | 2（上游） |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 5 | 2 | 5 | 2（上游） |
| **合计** | **23** | **5** | **23** | **5** |

- 目录/功能域分布（形状 B 起必报，本批先按同一格式）：`packages/shared`（协议编解码）1 个、
  `packages/ui`（远程连接表单）1 个、`packages/services`（机器人适配 + Agent 服务）2 个；
  4 个文件分属 3 个域，属形状 A 的 4 文件约束下的正常结果，不涉及跨域合批。

## 2. 改动内容

- `wire-codec.ts`：`measureTopicNotificationEnvelopeBytes` 分别计 `cliNdjsonBytes`/`channelSocketBytes`/
  `mobileRelayBytes` 取 `maxBytes`；`hardBound.value` 缺省回落 `maximum`、非有限或非正抛
  `TopicWireFrameEncodingError`、结果 `Math.min(Math.floor(...), maximum)`；
  `findFragmentByteBudget` 在 `logicalBytes` 与 `maxPhysicalFrameBytes` 间二分，候选帧按最坏分片构造故只偏大，不可行返回 0。
- `RemoteConnectionFields.tsx`：`aliasOption.alias` 与 `selectedSshConfigAlias` 规范化后比对；
  `wslUser` 空串表示发行版默认用户；全部已填时 `focus` 提交按钮；`disabled` 的两个来源写明；
  已选而列表为空仍可点以便清除失效关联；SSH 密码字段 `autoComplete` 关闭。
- `feishuProvider.ts`：`buildFeishuElicitationCardPayloadBody` 的拼装顺序；`planApprovalContent`
  非空时插 `hr` 与「审批」小标题；`incomingChatType` 为 group 时允许空正文；`resolveFeishuUserDisplayName`
  不拼接不音译；`signal?.throwIfAborted()` 先于 `AbortError` 判超时。
- `zcodeAgentService.ts`：`isProtocolMethodNotFoundError` 只认 `-32601`；`setTimeout` 回调里的超时清理
  不外抛；existing-only 观察者只报事实；`resolveSavedWorkflowCarrier` 决定 `meta` 落点；
  `marketplace` 显式时只刷该源。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:52:31.499Z pre-weak=b344-repo-post.txt
gate: PASS scope     n=0 plan=23 allow=0 diff_old=23 diff_new=23 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=54137387 files=4/4 numstat=23/23 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=24 added=0 allowed=32 auto_self_clear=1
gate: PASS order     total=127.0s controllable=120.0s
```

## 4. 首轮命中与返修

- 判据首轮 **2 hit**：
  - `zcodeAgentService.ts:668`：**W 单行无信息**——只有「上层据此降级」没有具体判据；补成
    「`isProtocolMethodNotFoundError` 只认数值 `-32601`…」后归零。
  - `RemoteConnectionFields.tsx:978`：**L 无信息列举**——「不是…故…」缺谓词表里的词；改为
    「…因此 `autoComplete` 会关掉自动填充。」后归零。
- 复检 `hits=0`；`numstat` 四文件 7/6/5/5 = 23，与 plan 一致。

## 5. 自清（本批 1 行自动、0 人工；累计自清转为 1）

- `pool-diff removed=24 added=0 auto_self_clear=1`：多出的一行是 `wire-codec.ts:49`，
  与改写行相邻、**池外（上游 blame）**，按 `auto-out-of-pool` 自动登记进 `POOL-SELF-CLEAR.tsv`；
  只减 weak 不减 `done`，故 `done +23` 而 weak `−24`。
- 形状 B 起（b350）自清口径收紧：任一批 `auto_self_clear>0` 或 `pool-diff added>0` **立即停批回报**。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b344 4,616` → `post-b345 4,592`（**−24**），文件 `1,721 → 1,720`（`wire-codec.ts` 全清）。
- **句子级口径**：`done 6,071 / remain 1,350`，`6,071 + 1,350 = 7,421`，**81.8%**。
- **逐行口径**：`remain ≈ 1,350 + 1,046 = 2,396`，`done ≈ 5,025 / 7,421`，约 **67.7%**。
- 池外：`4,592 − 1,350 = 3,242`，永久不排期。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b344-guard-post.txt`）。
- `capacity-estimate --batch b345`：`done files=475 (+4) / lines=6,071 (+23)`，
  `REMAIN 532 files / 1,350 lines`，`ALIGNED acct_remain=1350 pool_remain=1350 diff=0`，分档合计 267 批；
  `PARTIAL 3` 不变。
- `ledger-assert`：`475 + 532 = 1,007`、`6,071 + 1,350 = 7,421` → **PASS**。
- 白名单重跑到 `54137387`，**506 行**（开批前 504 行 + 本批两条）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b344-repo-post.txt
node _annot_baseline/pick-generic.mjs b345 d:/code/_annot_baseline/b345-files.txt d:/code/_annot_baseline/b344-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b345 --start
node _annot_baseline/judge-generic.mjs b345
node _annot_baseline/gate-run.mjs --batch b345 --subject "注释清水 b345：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b345-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b345-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b344-guard-post.txt --post d:/code/_annot_baseline/b345-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b345-repo-post.txt --pre-weak d:/code/_annot_baseline/b344-repo-post.txt --batch b345
```

## 9. 计时口径（A 段序列）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `1449c80b`） | 批次提交 `54137387` | 127.0s | 5.52s |
| `controllable` | `--start`（16:52:31.499Z） | 批次提交 | 120.0s | 5.22s |
| 起草段 | `b345-files.txt`（00:52:22） | `--start` | 9s | — |
| 收口段 | 批次提交（00:54:31） | 台账提交（00:56:40） | 129s | — |
| `批墙钟` | 本批最早可观测产物（00:52:22） | 台账提交 `d647385e`（00:56:40） | 258s | 11.22s |

- 本批属**形状 A** 段（b1–b349），其 `批墙钟` 只与 A 段比较，不与 b350 起的 B 段合并求中位数。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，实际 504 行；`--subject` 误写 502） | `1449c80b` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `54137387` | `+23/−23` |
| `ZC-deep-b345-rewrite.tsv` + 白名单 506 行 + `POOL-SELF-CLEAR.tsv` + 本台账 + INDEX 同步 | `d647385e` | — |

- 收口判据：A1 `remain=1,350≠0`；A2 `6,071 + 1,350 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `6,071 + 0 + 1,350 = 7,421` 成立（自清 1 行为池外，未计入 `done`）。
