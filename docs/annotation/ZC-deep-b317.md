# ZC-deep-b317

> 批次：b317 ｜ 44 行 / 4 文件 ｜ 提交 `2de38016`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界

- `scope` 首跑 `out_of_scope_edits=0`；`pool-diff` 首跑 `removed=44 added=0 allowed=49 auto_self_clear=0` PASS。
- 无 `SCOPE OUT`，本批不需要判据分歧登记。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/lib/sidebarCodingPlanUpgrade.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/remote-connection-flow/contract.ts` | 11 | 0 | 11 | 0 |
| `packages/ui/src/v4/pendingInteractionAdapter.ts` | 11 | 0 | 11 | 0 |
| **合计** | **44** | **0** | **44** | **0** |

- 四个文件均 `ownOut=0 upOut=0`，本批后整文件清零；仍按 §6.1 浮动规模取 4 × 11 = 44 行。

## 2. 改动内容

- `useBrowserScreenshotSurfaceReady.ts`：守卫后固定 `activeRequest` / `activeWebview`、
  effect cleanup 的统一拆除、`prepareTimeoutMs` 取值、`verificationVersion` 作废、
  `disposed` / `reported` 早退、`deadline` 超时告警与停止重试、`firstFrame` 重置与重新排队。
- `sidebarCodingPlanUpgrade.ts`：`snapshot` 三态与 `loading` 正交、`providerId` / `snapshot` / `loading` 最小字段、
  `zaiIndividualCodingPlan` 的家族回退与 `null` 家族、`normalizePlanLevel` 后的 `enterprise` / `team` 判定、
  `modelProvidersLoading` 早退、候选过滤与三级选择顺序。
- `contract.ts`：`openIntentId` 首字段、`onDeviceConnected` / `onSelectProject` 独立、
  `preferred*` 字段组、解构默认值与 `controlledOpen` 换名、返回对象顺序、
  `RemoteConnectionOptions` 用 `ReturnType` 推导、`operationId` / `view` / `cancelled` / `target` 的来源。
- `pendingInteractionAdapter.ts`：三类拒绝压成 `deny`、`allowAlways` 的 exact 规则、
  `LEGACY_PERMISSION_RULE_INPUT_KEYS` 取值、未知 `kind` 兜底 `allow`、`fullAccessOption` 追加、
  `option.response ?? permissionKindToResponse`、`origin` / `display` 条件展开、`raw` 最小兜底、
  `questions` 空返回、`message` 回退与 `multiSelect` / `answerDrafts` 条件展开。

## 3. 门禁读数（十一闸）

```text
gate: PASS scope     n=0 plan=44 allow=0 diff_old=44 diff_new=44 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=2de38016 files=4/4 numstat=44/44 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=44 added=0 allowed=49 auto_self_clear=0
gate: PASS order     n=0 total=114.0s controllable=85.0s
GATE ALL PASS batch=b317 sha=2de38016
```

- 十一闸首跑全绿，无补跑。`controllable = 85.0s` 是 `--start` → 批次提交的**闸内段**，
  不是端到端产能；`85.0 / 44 ≈ 1.93 s/行` 只在同批内作观测，不与其它任务比较（定义见 §10）。

## 4. 首轮命中与返修

- 首轮 **1 / 44 = 2.3%**，`--record` 前 Edit 直改，`record_runs=1`：
  - `sidebarCodingPlanUpgrade.ts:143` `L/无信息列举`：三个 `、` →
    改为「优先 `selectedProviderId` 与在用套餐，都未命中才取首个可升级项」。

## 5. 自清（累计第 9 批无自清；本批 0 自动、0 人工）

- `removed=44`、`added=0`，消失集合与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增行。
- `capacity-estimate` 回读 `SELF-CLEAR n=44 可写桶 44 / 池外 0 / 上游桶 0 / 未解析 0`。
- `auto_self_clear` 仍未首次生效（b313–b317 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b316 5,602` → `post-b317 5,558`（**−44** = 本批落笔，无自清），文件 `1,806 → 1,802`。
- **句子级口径（工程完成度）**：`done 5,109 / remain 2,312`，`5,109 + 2,312 = 7,421`，**68.8%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,312 + 1,046 = 3,358`，`done ≈ 4,063 / 7,421`，**约 54.7%**。
- 池外：`5,558 − 2,312 = 3,246` 行，**永久不排期**。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b317`：`done files=367 (+4) / lines=5,109 (+44)`，
  `REMAIN 640 files / 2,312 lines`，`ALIGNED acct_remain=2312 pool_remain=2312 diff=0`，分档合计 321 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `ledger-assert`：`ACCT files 367 + 640 = 1007`、`ACCT lines 5,109 + 2,312 = 7,421` → **PASS**。
- 白名单重跑到 `2de38016`，**390 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b316-repo-post.txt > _annot_baseline/b317-candidates.txt
node _annot_baseline/pick-generic.mjs b317 d:/code/_annot_baseline/b317-files.txt d:/code/_annot_baseline/b316-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b317 --start
node _annot_baseline/judge-generic.mjs b317
node _annot_baseline/gate-run.mjs --batch b317 --subject "注释清水 b317：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b317-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b317-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b316-guard-post.txt --post d:/code/_annot_baseline/b317-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b317-repo-post.txt --pre-weak d:/code/_annot_baseline/b316-repo-post.txt --batch b317
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，388 行） | `752fbbfe` | 2 文件 |
| b317 批次本体（4 文件 1→1 改写） | `2de38016` | `+44/−44` |
| `ZC-deep-b317-rewrite.tsv` + 白名单 390 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,312≠0` 未到；A2 `5,109 + 2,312 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `5,109 落笔 + 0 池内自清 + 2,312 = 7,421` 成立。
- 后续：b318 继续；b320 插点加做「逐行探针增量普查」（只测不修，单独记 `自足化候选`）。

## 10. 计时口径（b317 起按此引用）

三个数都只由 git 提交时间 / `--start` 落戳推出，不依赖人工记号：

| 名称 | 起点 | 终点 | 含 | 不含 |
| --- | --- | --- | --- | --- |
| `total`（闸内 `batch_wall_total`） | **上一提交**（b317 为白名单提交 `752fbbfe`） | 批次提交 `2de38016` | 选行 `pick-generic`、读码、写作、判据返修、六闸 | 台账收口、下一批准备 |
| `controllable`（闸内 `batch_wall_controllable`） | `--start` 落戳 `t-start` | 批次提交 | 读码、写作、判据返修、六闸 | 选行（`--start` 之前）、台账收口 |
| `批墙钟` | 本批第一次工具调用 | **台账提交** | 选行、读码、写作、门禁、台账写入与提交 | 批间空闲 |

- **b317 实测**：`16:42:08` 白名单提交 → `16:42:37` `--start` → `16:44:02` 批次提交 → `16:45:18` 台账提交。
  `total = 114.0s`、`controllable = 85.0s`、`批墙钟 ≈ 190.0s`（首调用于白名单命令内，误差 ≤3 s）。
- **换算**：`44` 行下 `controllable/行 ≈ 1.93`、`批墙钟/行 ≈ 4.32`。
  前者只是「闸内段的机器+模型墙钟」，**不能当产能**；后者才是端到端，仍含选行与收口，跨任务比较也只作量级参考。
- 以后任何批次引用「用时」必须同时给出 `controllable` 与 `批墙钟` 两个数，或明确说只报其中一个；单给 `s/行` 视为口径不明。
