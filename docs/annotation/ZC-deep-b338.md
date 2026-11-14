# ZC-deep-b338

> 批次：b338 ｜ 32 行 / 4 文件 ｜ 提交 `ebc694e9`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批只有 32 行（低于 33 下沿 1 行），原因与取舍

- `cand-generic` 在 b337 批后快照里**没有任何文件的可写行（`ownIn`）≥ 9**：最高档仍是 `ownIn=8`，共 4 个文件。
  4 文件 × 8 = 32，无论怎么挑都到不了 33。
- 可选的越界办法只有两个，都不合适：
  1) 加第 5 个文件 → 违反「每批 4 文件」的结构约束，`zc-commit` 的 `files=4/4` 也会失配；
  2) 顺手改 `own out` 行 → 正是 b336 §0 被 `scope` 拦下的那类越界，且会把上游 weak 算进本批。
- 取舍：**保 4 文件结构，接受 32 行**，与 b337 §0 同一处置，并记明「低于下沿 1 行」是快照上限所致，不是漏挑。
  `webRemoteControlConnectionSheet.tsx:76`（blame `0a1fc56d`）的 `own out` 行保持原样，批后仍是上游 weak。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/resource-manager/NetworkSection.tsx` | 8 | 0 | 8 | 0 |
| `packages/ui/src/settings/HookForm.tsx` | 8 | 0 | 8 | 0 |
| `packages/web/src/web-remote-control/ui/webRemoteControlConnectionSheet.tsx` | 9 | 1 | 8 | 1（上游） |
| `packages/ui/src/project-sidebar/grouped/drag.ts` | 8 | 0 | 8 | 0 |
| **合计** | **33** | **1** | **32** | **1** |

- `pick-generic` 读数：`TALLY ownIn=32 ownOut=0 upIn=0 upOut=1 pending=0 planIn=32 planOut=0`，`plan=32 ownOutAllow=1`。
- 四个文件就是当前快照里 `ownIn=8` 的全部；无 9 行档可选（见 §0）。

## 2. 改动内容

- `NetworkSection.tsx`：`PAGE_SIZE` 只影响内存切片、`bridge` 缺省时整块降级、
  `locale` 变化才重建 `Intl` 实例、`clearing` 为真时跳过请求、
  `filter` 只作用于投影后的 `rows`、`pageCount` 至少为 1、
  `currentPage` 取 `page` 与 `pageCount-1` 较小值、`finally` 解除 `busy` 并递增 `revision`。
- `HookForm.tsx`：`HookScopeMenu` 拆分换取更大点击区域、`customError` 单槽、
  每次保存只经一次 `JSON.parse`、解析放在保存时、只校验顶层 `plain object`、
  `JSON` 尾逗号不替用户修补、组装后同步调用 `onSave`、
  `async` 开关取值来自 `asyncCommand` 草稿。
- `webRemoteControlConnectionSheet.tsx`：`timestamp` 为秒级、`elapsed` 取整不显示小数、
  `formatRelative` 对不足一分钟显示刚刚、超过一个月改用 `toLocaleDateString`、
  整行由 `button` 承载、左侧 `icon` 列固定宽度、`divider` 首行省略、
  `description` 附带在线数量。
- `drag.ts`：滚动祖先按 `overflow` 判定、`collisionDetection` 只筛候选、排序交给 `closestCenter`、
  过滤不重写排序、`group` 不支持嵌套、`GROUPED_TASK_DROP_ANIMATION` 只描述回弹、
  `duration` 不随距离变化、布局快照只测 `height/left/top`。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:09:41.028Z pre-weak=b337-repo-post.txt
gate: PASS scope     n=0 plan=32 allow=0 diff_old=32 diff_new=32 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=ebc694e9 files=4/4 numstat=32/32 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=32 added=0 allowed=39 auto_self_clear=0
gate: PASS order     total=126.0s controllable=111.0s
```

## 4. 首轮命中与返修

- 判据**首轮 0 hit**，无文案返修；也没有越界行。
- 唯一非零处置是 §0 的选行取舍（32 行），不涉及回退。

## 5. 自清（累计第 28 批无自清；本批 0 自动、0 人工）

- `removed=32`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=39`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b337 4,821` → `post-b338 4,789`（**−32**），文件 `1,736 → 1,733`。
- **句子级口径**：`done 5,876 / remain 1,545`，`5,876 + 1,545 = 7,421`，**79.2%**。
- **逐行口径**：`remain ≈ 1,545 + 1,046 = 2,591`，`done ≈ 4,830 / 7,421`，约 **65.1%**。
- 池外：`4,789 − 1,545 = 3,244`，永久不排期（含本批留下的 1 行上游 weak）。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b337-guard-post.txt`）。
- `capacity-estimate --batch b338`：`done files=447 (+4) / lines=5,876 (+32)`，
  `REMAIN 560 files / 1,545 lines`，`ALIGNED acct_remain=1545 pool_remain=1545 diff=0`，分档合计 281 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`447 + 560 = 1,007`、`5,876 + 1,545 = 7,421` → **PASS**。
- 白名单重跑到 `ebc694e9`，**473 行**（开批前 471 行 + 本批两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b337-repo-post.txt
node _annot_baseline/pick-generic.mjs b338 d:/code/_annot_baseline/b338-files.txt d:/code/_annot_baseline/b337-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b338 --start          # 必须在改文件之前
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/judge-generic.mjs b338
node _annot_baseline/gate-run.mjs --batch b338 --subject "注释清水 b338：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b338-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b338-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b337-guard-post.txt --post d:/code/_annot_baseline/b338-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b338-repo-post.txt --pre-weak d:/code/_annot_baseline/b337-repo-post.txt --batch b338
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `7c02b395`） | 批次提交 `ebc694e9` | 126.0s | 3.94s |
| `controllable` | `--start`（16:09:41.028Z） | 批次提交 | 111.0s | 3.47s |
| `批墙钟` | 本批最早可观测产物 `b338-files.txt`（00:09:30） | 台账提交 `af1f13f0`（00:13:23） | 233s | 7.28s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，471 行） | `7c02b395` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `ebc694e9` | `+32/−32` |
| `ZC-deep-b338-rewrite.tsv` + 白名单 473 行 + 本台账 + INDEX 同步 | `af1f13f0` | — |

- 收口判据：A1 `remain=1,545≠0`；A2 `5,876 + 1,545 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,876 + 0 + 1,545 = 7,421` 成立。
