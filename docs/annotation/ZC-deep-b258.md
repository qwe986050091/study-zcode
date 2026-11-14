# ZC-deep-b258：B10「audio-player + RewardsWebview」去双前缀（97 行 / 2 文件）

- 日期：2026-11-10
- 批次：B10（15 文件清单第 10 个，合批 2 文件）
- 目标文件：`packages/ui/src/components/ai-elements/audio-player.tsx`（6 + 36 = 42）、`packages/ui/src/rewards/RewardsWebview.tsx`（10 + 45 = 55）
- 本批行数：97（144 类 16 + 658 类 81）
- 代码提交：`b1be4b7b b258 B10 去双前缀 (+97/−97)`
- 尺子：`deep-quality` v2.0（`756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` `1836c9034a66` + **`weak-guard` `971a24ef8523`（本批新增）**

## 0. 收尾断言改版：断言 1 降级为兜底，新增可失败的 1b

**断言 1 降级（文本已改死）**：全仓 weak 率 ≤ 3.1%（v2.0 口径，分母以当次输出为准）**不能失败，只作兜底，不作质量证据**。原因：分子 `10,085 → 10,084` 几乎不动，分母被别的会话的加注持续撑大（b257 已量化 +1,676 注释 / +91 weak 全在别的文件），率的分母变大只会让率更低，与做没做本线工作无关。

**新增断言 1b（每批都能失败）**：**本工程 15 文件内 weak 绝对数每批不增**。每批 pre/post 各测一次，`weak-guard.mjs` 判定；涨一条即 `exit 1` 并打印新增 `文件:行`。它与断言 3 方向不同：3 只看本批新增行有没有写坏，1b 看整体有没有被别处带坏。

- 工具：`docs/annotation/_tools/weak-guard.mjs`（blob `971a24ef8523`）
- 输入：两份 `deep-quality --list-weak` 输出（同一 15 文件清单，pre / post 各一次）
- 判定：①两份 `WEAK lines=N` 必须等于明细条数（尺子自检）；②`files=15`；③post 的 weak 行集合 ⊆ pre；④`post > pre` 或 `pre > --max` → `exit 1`

**口径更正**：用户记的 `7/3353` 是 B7 后的值。B8 ±0，B9 在 `app-events.ts` 修掉 1 条，因此 **B10 pre 实际是 `6/3353`**。本批 pre/post 各测一次：

```text
WEAK 15文件  pre=6  post=5  新增=0  max=8
GUARD PASS
```

B10 修掉的是 `RewardsWebview.tsx:284`（双前缀行，剥一层后判 W）；15 文件降至 `5/3353`，无新增。

## 1. 收尾执行方式（现在写死，B12 后照此执行）

| 项 | 定死内容 |
| --- | --- |
| 判定作用域 | **唯一认干净 worktree**：`git worktree add --detach d:/code/_b12_close <CLOSE_SHA>`。主工作区读数只作诊断，不参与判定 |
| 取哪个提交 | `CLOSE_SHA` = B12 的**代码提交**（台账提交之前的最后一个代码提交），detached checkout |
| 断言 1 在哪判 | 干净 worktree 全仓（`--root packages,apps`），**只作兜底** |
| 断言 2 在哪判 | 同一 worktree，`--file-list b254-802-files.txt`，阈值 `≤ 8/3353`（v2.0 复测） |
| 断言 1b 在哪判 | 同一 worktree，`weak-guard --pre <B12 pre15> --post <close15> --max 6`（B12 pre 实测值） |
| 断言 3 在哪判 | 各批门禁输出 + `*-rewrite.tsv`，B1–B12 全量「判据命中 0 / 嵌套 0」 |
| 三作用域读数不同以谁为准 | **只认干净 worktree @ CLOSE_SHA**；主工作区与历史 worktree 的数字只写进诊断脚注，不进结论 |
| 分母怎么写 | 断言 1 文本写「≤ 3.1%（v2.0 口径，分母以 `close-repo.txt` 为准）」，不写死 349k 一类数字，且**不与 v1.9 相减** |

命令（写死，B12 后原样跑）：

```powershell
git -C d:/code/ZCode worktree add --detach d:/code/_b12_close <CLOSE_SHA>
node d:/code/_annot_baseline/deep-quality.mjs d:/code/_b12_close --root packages,apps | Out-File -Encoding utf8 d:/code/_annot_baseline/close-repo.txt
node d:/code/_annot_baseline/deep-quality.mjs d:/code/_b12_close --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak | Out-File -Encoding utf8 d:/code/_annot_baseline/close-15.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre <B12 前实测的 pre15.log> --post d:/code/_annot_baseline/close-15.txt --max 6
git -C d:/code/ZCode worktree remove d:/code/_b12_close --force
```

判定：`close-repo.txt` 的 `RATIOS` 率 ≤ 3.1%（兜底）→ `close-15.txt` weak ≤ 8（v2.0）→ `weak-guard` 打印 `GUARD PASS` → 断言 3 全量复核。任一失败即停，不写「完成」。

## 2. 三列滚动行（`ledger-assert`）

```text
BATCH ZC-deep-b258-rewrite.tsv	97 行
SUM 各批 = 68 + 64 + 62 + 68 + 65 + 60 + 49 + 68 + 99 + 97 = 700  OK（逐文件登记数 == 批次表计划数）
ROLL 144  计划 144  累计 130  剩余 14  OK
ROLL 658  计划 658  累计 570  剩余 88  OK
ROLL 802  计划 802  累计 700  剩余 102  OK
CUM 累计 700 + 剩余 102 = 802  OK
PLAN 批次表合计 802  = 802  OK
GREP 全仓 104 = 清单内 102 + 清单外 2  OK
OUTSIDE docs/annotation/_tools/d7e-shift.mjs:1 , docs/webdriverio/docs/ocr-testing/ocr-faq.md:1
REMAIN 剩余 = 102
ASSERT PASS
```

剩余 102 = B11 `CommandForm.tsx` 42 + B12 `FeedbackBackgroundUploadIndicator.tsx` 60，单文件均 < 100，仍不触发 `Bx-1/Bx-2`。

## 3. 本批分类（97 行：改写 16 / 只去前缀 81）

| 文件 | 144 类（改写） | 658 类（只去前缀） | 合计 |
| --- | ---: | ---: | ---: |
| `audio-player.tsx` | 6 | 36 | 42 |
| `RewardsWebview.tsx` | 10 | 45 | 55 |
| 合计 | **16** | **81** | **97** |

16 行改写（判据 → 改法）：

| 文件:行 | 判据 | 改写 |
| --- | --- | --- |
| audio:65 | L（`、`×3 无谓词） | 补「保持单一来源」（PREDICATE） |
| audio:110 | W（无标识符） | 补 `AudioPlayerElementProps` |
| audio:128 | L（`、`×3 无谓词） | 改「先…再…」句式 |
| audio:149 | L（`、`×2 无谓词） | 改「统一由 … 承载」 |
| audio:179 | W（无标识符） | 补 `seekOffset` |
| audio:185 | W（无标识符） | 补 `useState` |
| rewards:74 | L（2 逗号无谓词） | 补「而代价是」（PREDICATE） |
| rewards:75 | W（无标识符） | 补 `locale` / `theme` |
| rewards:91 | L（`、`×3 无谓词） | 补「而它正是」 |
| rewards:93 | W（无标识符） | 补 `ready` |
| rewards:94 | L（2 逗号无谓词） | 补「而后者」 |
| rewards:96 | L（`、`×2 无谓词） | 补「而 latest」 |
| rewards:164 | L（2 逗号无谓词） | 补「而…因此」 |
| rewards:223 | L（`、`×2＋2 逗号） | 补「则不应整页置错」 |
| rewards:228 | L（2 逗号无谓词） | 补「而…因此」 |
| rewards:284 | W（无标识符，也是 15 文件里的 1 条 weak） | 补 `close`，同时消掉 weak |

## 4. 门禁七行（`zc-commit` v12，blob `a35b42fa2e4c`）

```text
删本线注释    n=97  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=97  其中判据命中 0  其中嵌套注释 0
提交集合断言  expected=2  staged=2
```

三源一致：numstat `+42−42` + `+55−55` = 97 = TSV 97 行 = 门禁 97 行。两文件均 CRLF，行数 295 / 352 不变，残留双前缀 0。

## 5. 度量（SUMMARY 前后）

| 文件 | units | comments | coverage | substance pre → post | explain pre → post |
| --- | ---: | ---: | ---: | --- | --- |
| `audio-player.tsx` | 114 | 65 | 4.4% | 95.4% → **96.9%** | 100.0% → 100.0% |
| `RewardsWebview.tsx` | 170 | 80 | 7.1% | 95.0% → **96.3%** | 98.8% → **100.0%** |
| 合计 | 284 | 145 | 6.0% | 95.2% → **96.6%** | 99.3% → **100.0%** |

weak：`1/145` → `0/145`。units / comments 逐值不变，改写未动分母。

## 6. 覆盖差集

`--uncovered` pre 267 行 / post 267 行，`Compare-Object` 无差异（`onlyPre=0`、`onlyPost=0`）。

## 7. 三态（改前 blame）

97 行来自两个 sha：`a8784b7e479d` 95 行 + `a149ef4d396a` 2 行（`audio-player.tsx:47`、`:182`）。`a149ef4d` = `b244 改写 (+16/−16)`，`own-commits --check` 判定为**本线**：`own=2 upstream=0 pending=0`。

## 8. 回读三条（只去前缀、未改写）

```text
audio-player:46    // AudioPlayerProps 从 MediaController 的入参派生，只裁掉 audio 一个字段。
audio-player:67    // [事务] 对象的最后一个展开是调用方 style，因此外部令牌始终优先。
RewardsWebview:45  // 系统明暗只读一次作为初值，之后完全交给 change 订阅：每次渲染直接读 matchMedia
```

三条剥一层后语义完整、均有标识符或谓词锚点，不判 144。

## 9. 计时

- 起：19:18:55（本批首份证据 `b258-b10-pre.txt` 落盘）
- 止：19:21:08（提交 `b1be4b7b`）
- 合计 **133s**，`133 / 97 = 1.37 s/行`
- 返工 0（唯一一次重跑是改写脚本自检拦截 `rewards:284` 仍判 L，未落盘该文件，修正后整批重跑；不计返工）
- 阈值 0.85–2.85 为**拍定值**（1.7 × 0.5 / 1.7 × 1.5），1.37 在区间内

## 10. 下一步

B11：`packages/ui/src/settings/CommandForm.tsx`（8+34=42），单文件成批；随后 B12 `FeedbackBackgroundUploadIndicator.tsx`（6+54=60）收口 802。
