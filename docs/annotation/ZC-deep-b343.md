# ZC-deep-b343

> 批次：b343 ｜ 28 行 / 4 文件 ｜ 提交 `786f54a7`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 28 行（低于 33 下沿 5 行），原因与取舍

- b342 后快照 `ownIn=8` 已清零，最高档就是 7：`7/9` 两个（`upOut=2`）、`7/7` 两个，
  4×7 = **28**，是「4 文件结构」下的上界。加第 5 个文件违反每批 4 文件的节奏且 `files=4/4` 失配，
  改池外行属于越界，故按 b337–b342 同一处置接受 28 行。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/ToolCallBlocks/renderers/create-workflow.tsx` | 7 | 2 | 7 | 2（上游） |
| `packages/ui/src/components/ai-elements/markdown-table.tsx` | 7 | 2 | 7 | 2（上游） |
| `apps/zcode-cli/packages/dynamic-workflow/src/schema/validate.ts` | 7 | 0 | 7 | 0 |
| `apps/zcode-cli/packages/office-runtime/ui/i18n.ts` | 7 | 0 | 7 | 0 |
| **合计** | **28** | **4** | **28** | **4** |

- `pick-generic` 读数：`TALLY ownIn=28 ownOut=0 upIn=0 upOut=4 pending=0 planIn=28 planOut=0`，`plan=28 ownOutAllow=4`。
- 上游 weak 未动：`create-workflow.tsx:214`、`create-workflow.tsx:296`、`markdown-table.tsx:884`、
  `markdown-table.tsx:944`，都在池外，属永久不排期。

## 2. 改动内容

- `create-workflow.tsx`：补全行与正式卡共用 `CreateWorkflowToolCallBlock`、只换 `useWorkflowHoleRow` 给的
  `vocabulary`；`retuning` 只改并发上限故「正在校验」不成立；设置行裁定交 `ConversationRowView`；
  `useWorkflowCardModel` 每次渲染新建 `model`、`graph` 到达整份替换；`model` 是时间线唯一输入；
  `scriptOpen` 初值 false；`showFailureStatus` 与 `prelaunch` 合流直接返回行式反馈。
- `markdown-table.tsx`：`resolveMarkdownTableVerticalViewport` 找可纵向滚动祖先；`resolveMarkdownTableVirtualScrollMax`
  返回 `tableWidth − trackWidth`；`viewport.scrollWidth` 首帧含滚动条槽是可接受近似；`scheduleMeasure` 合帧
  只跑一次 `requestAnimationFrame`；滚动后重算 `viewportMaxWidth`（`translateX` 左移切真实滚动的临界）；
  内容层宽度 = `viewportMaxWidth + ceil(viewportLeftOffset)`。
- `validate.ts`：先按 `$ref` 解引用再递归 `check`、`resolveRef` 失败记 unresolved 违规；`resolved` 为
  undefined 立即 return；递归靠调用栈收敛；`anyOf` 用独立 `trial` 列表试算、失败只 push 一条聚合违规；
  `typeName` 逐项拼接联合类型。
- `i18n.ts`：`where` 模板按 `pageLower`/`page` 成对；`errors` 用 `Record` 宽类型；`zh-CN` 文案自行处理
  全角标点与空格；`strings` 只看 `locale` 前缀；`describeAt` 必须先登记模板；表格定位分 `w.cell`/`w.table`
  两支；`bang` 之后区域保持原样。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:35:06.114Z pre-weak=b342-repo-post.txt
gate: PASS scope     n=0 plan=28 allow=0 diff_old=28 diff_new=28 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=786f54a7 files=4/4 numstat=28/28 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=28 added=0 allowed=36 auto_self_clear=0
gate: PASS order     total=124.0s controllable=118.0s
```

## 4. 首轮命中与返修

- 判据首轮 **4 hit**，两类：
  - `i18n.ts:178` 是 **W 单行无信息**：「zh 表的中文标点与空格按阅读习惯排，不复用 en 的拼接结果。」
    两个短标识（`zh`/`en`）都不足 3 字符，整行等于没说做法。改成 `zh-CN 文案自行处理全角标点与空格，
    避免复用 en 拼接时混入半角空格` 后带出具体做法与后果。
  - `create-workflow.tsx:184`、`i18n.ts:273`、`create-workflow.tsx:304` 是 **L 无信息列举**：
    逗号 ≥2 而缺谓词表里的词（`会`/`返回`/`则` 一类）。分别补 `会新建`、`会归入…则回落`、`直接返回`
    后归零。
- 复检 `hits=0`；`git diff --numstat` 四文件各 7/7，与 plan 完全一致，无漏改无越界。

## 5. 自清（累计第 33 批无自清；本批 0 自动、0 人工）

- `removed=28`、`added=0`，与 plan 完全重合；`auto_self_clear=0`，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=36`）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b342 4,669` → `post-b343 4,641`（**−28**），文件 `1,724 → 1,722`
  （`validate.ts`、`i18n.ts` 全清）。
- **句子级口径**：`done 6,023 / remain 1,398`，`6,023 + 1,398 = 7,421`，**81.2%**。
- **逐行口径**：`remain ≈ 1,398 + 1,046 = 2,444`，`done ≈ 4,977 / 7,421`，约 **67.1%**。
- 池外：`4,641 − 1,398 = 3,243`，永久不排期（含本批留下的 4 行上游 weak）。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b342-guard-post.txt`）。
- `capacity-estimate --batch b343`：`done files=467 (+4) / lines=6,023 (+28)`，
  `REMAIN 540 files / 1,398 lines`，`ALIGNED acct_remain=1398 pool_remain=1398 diff=0`，分档合计 271 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`467 + 540 = 1,007`、`6,023 + 1,398 = 7,421` → **PASS**。
- 白名单重跑到 `786f54a7`，**493 行**（开批前 491 行 + 本批两条）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b342-repo-post.txt
node _annot_baseline/pick-generic.mjs b343 d:/code/_annot_baseline/b343-files.txt d:/code/_annot_baseline/b342-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b343 --start          # 必须在改文件之前
node _annot_baseline/judge-generic.mjs b343
node _annot_baseline/gate-run.mjs --batch b343 --subject "注释清水 b343：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b343-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b343-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b342-guard-post.txt --post d:/code/_annot_baseline/b343-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b343-repo-post.txt --pre-weak d:/code/_annot_baseline/b342-repo-post.txt --batch b343
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `9a763ccc`） | 批次提交 `786f54a7` | 124.0s | 4.43s |
| `controllable` | `--start`（16:35:06.114Z） | 批次提交 | 118.0s | 4.21s |
| `批墙钟` | 本批最早可观测产物 `b343-files.txt`（00:34:48） | 台账提交 `fd95ba27`（00:38:26） | 218s | 7.79s |

- 跨批比较只认 `批墙钟`；`total` / `controllable` 仅作本批记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，491 行） | `9a763ccc` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `786f54a7` | `+28/−28` |
| `ZC-deep-b343-rewrite.tsv` + 白名单 493 行 + 本台账 + INDEX 同步 | `fd95ba27` | — |

- 收口判据：A1 `remain=1,398≠0`；A2 `6,023 + 1,398 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `6,023 + 0 + 1,398 = 7,421` 成立。
