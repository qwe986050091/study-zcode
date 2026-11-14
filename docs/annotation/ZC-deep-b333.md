# ZC-deep-b333

> 批次：b333 ｜ 36 行 / 4 文件 ｜ 提交 `3ba55e9a`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b332-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 六闸全部 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=36/36`、
  `pool-diff removed=36 added=0 allowed=43 auto_self_clear=0`。
- 判据 `hits=0`；本批有一次「改写后与原文逐字相同」的漏改（见 §4），补齐后 `git diff --stat` 由 35/35 回到 36/36。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/WorkspaceWebRemoteControlTrigger.tsx` | 9 | 0 | 9 | 0 |
| `packages/ui/src/components/ai-elements/persona.tsx` | 9 | 0 | 9 | 0 |
| `packages/ui/src/components/ui/command.tsx` | 9 | 0 | 9 | 0 |
| `packages/ui/src/lib/taskChangeSummary.ts` | 9 | 0 | 9 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,753 → 1,749。
- 9 × 4 = 36，落在 33–44 浮动区间内（候选池本批最高档即 9 行/文件）。

## 2. 改动内容

- `WorkspaceWebRemoteControlTrigger.tsx`：`status === "error"` 优先、`formatMessage` 统一文案、
  未识别状态回落 `triggerStatus.idle`、`getWebRemoteControlTriggerPresentation` 纯函数两字段、
  `iconClassName` 只取语义色、`text-success` 单支出现、`resolver` 的 `live session`、
  轮询只影响图标与 `tooltip`、`workspaceIdentity`/`workspacePath` 缺失按本地上报。
- `persona.tsx`：`idle` 由四个布尔输入全假表示、`variant` 决定 `sources` 取项（缺省 `obsidian`）、
  `sources` 的 `source`/`hasModel`/`dynamicColor` 三字段、`getCurrentTheme` 先类名后媒体查询、
  `useTheme` 仅在 `source.dynamicColor` 为真时订阅、根元素只观察 `class` 属性、
  `useViewModelInstance` 取颜色通道、`dark` 白 / `light` 黑、`dynamicColor` 为假跳过写入。
- `command.tsx`：背景圆角收口到 `CommandPrimitive`、标题描述仅供 `DialogHeader` 读屏、
  `CommandPrimitive` 自管列表留白、`SearchIcon` 走 `InputGroupAddon`、
  `CommandPrimitive.Input` 禁用不取焦、`scrollbar-hide` 仍可滚轮与键盘、
  `CommandPrimitive.Group` 自裁溢出、`CommandPrimitive.Separator` 负外边距、
  字号字距收口到 `CommandShortcut`。
- `taskChangeSummary.ts`：`appendPatch` 空白补丁返回 `current`、`normalizedPatch` 换行拼接、
  首段不产生前导换行、`filesByPath` 按路径合并 `writeCount`/`added`/`removed`、
  `lastTurnIndex` 取 `Math.max`、`assistant` 优先 `turnIndex` 否则 `messageIndex`、
  `buildPerTurnChangeSummaries` 空轮次不占位、`Map` 键为 `turnIndex`、重复键后者覆盖前者。

## 3. 门禁读数

```text
gate: PASS start     t-start=15:29:33Z pre-weak=b332-repo-post.txt
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=3ba55e9a files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=36 added=0 allowed=43 auto_self_clear=0
gate: PASS order     total=163.0s controllable=131.0s
```

## 4. 首轮命中与返修

- 判据首轮 **0 / 36**。
- 落笔后 `git diff --numstat` 出现 `taskChangeSummary.ts 8/8`，比 plan 少 1 行：
  第 251 行的新文案与原文逐字相同（`// 多段补丁之间用换行连接，顺序即工具调用发生顺序`），
  等同漏改。改写为 `// 多段 normalizedPatch 之间用换行连接，…` 后回到 `9/9`，全批 `36/36`。
- 教训：`Edit` 的 `old_string` 与 `new_string` 必须在**非注释语义**上也不同；
  `judge-generic` 只看判据、不看「是否真的改了」，漏改只能靠 `git diff --stat` 抓。

## 5. 自清（累计第 23 批无自清；本批 0 自动、0 人工）

- `removed=36`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=43`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b332 4,988` → `post-b333 4,952`（**−36**），文件 `1,753 → 1,749`。
- **句子级口径**：`done 5,713 / remain 1,708`，`5,713 + 1,708 = 7,421`，**77.0%**。
- **逐行口径**：`remain ≈ 1,708 + 1,046 = 2,754`，`done ≈ 4,667 / 7,421`，约 **62.9%**。
- 池外：`4,952 − 1,708 = 3,244`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b332-guard-post.txt`）。
- `capacity-estimate --batch b333`：`done files=427 (+4) / lines=5,713 (+36)`，
  `REMAIN 580 files / 1,708 lines`，`ALIGNED acct_remain=1708 pool_remain=1708 diff=0`，分档合计 291 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`427 + 580 = 1,007`、`5,713 + 1,708 = 7,421` → **PASS**。
- 白名单重跑到 `3ba55e9a`，**453 行**（开批前 451 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b332-repo-post.txt
node _annot_baseline/pick-generic.mjs b333 d:/code/_annot_baseline/b333-files.txt d:/code/_annot_baseline/b332-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b333 --start
node _annot_baseline/judge-generic.mjs b333
node _annot_baseline/gate-run.mjs --batch b333 --subject "注释清水 b333：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b333-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b333-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b332-guard-post.txt --post d:/code/_annot_baseline/b333-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b333-repo-post.txt --pre-weak d:/code/_annot_baseline/b332-repo-post.txt --batch b333
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `e92ebfd2`，23:29:01） | 批次提交 `3ba55e9a`（23:31:44） | 163.0s | 4.53s |
| `controllable` | `--start`（23:29:33） | 批次提交（23:31:44） | 131.0s | 3.64s |
| `批墙钟` | 本批最早可观测产物 `b333-files.txt`（23:29:24） | 台账提交 `8dd80f94`（23:33:42） | 258s | 7.17s |

- `controllable` 含读码、写作、apply、返修与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，451 行） | `e92ebfd2` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `3ba55e9a` | `+36/−36` |
| `ZC-deep-b333-rewrite.tsv` + 白名单 453 行 + 本台账 + INDEX 同步 | `8dd80f94` | — |

- 收口判据：A1 `remain=1,708≠0`；A2 `5,713 + 1,708 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,713 + 0 + 1,708 = 7,421` 成立。
