# ZC-deep-b259：B11「CommandForm」去双前缀（42 行 / 1 文件）+ 1b 改键

- 日期：2026-11-10
- 批次：B11（15 文件清单第 11 个，单文件成批）
- 目标文件：`packages/ui/src/settings/CommandForm.tsx`（8 + 34 = 42）
- 本批行数：42
- 代码提交：`c5f1e134 b259 B11 去双前缀 (+42/−42)`
- 尺子：`deep-quality` v2.0（`756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` **`4b914f3cbd26`** + `weak-guard` **`890acea8347e`**（本批改键）

## 0. 断言 1b 改键：比较键 = 文件 + weak 行正文（多重集合）

**选 ① 而不是 ②。** 理由：②（先断言 `added == deleted`，不等就拒绝比较）会在**真正改变行数的批次**上直接放弃守卫，而恰恰是这类批次最可能把别处的 weak 带进来；① 对行号位移免疫，同时仍能抓「多出一条新 weak」。同一文件里出现两行一模一样的 weak 时用**出现次数**比较，不依赖行号也不依赖出现次序；输出仍打印行号，只用于人工定位，不参与判定。

**回放（同一把尺子 `deep-quality v2.0 --list-weak`，不是改日志文本）：**

```text
回放1 B10（+97/−97 净 0 行）
  pre=6 post=5  旧键(行号)新增=0  新键(文件+正文)新增=0  PASS
回放2 插入场景（app-events.ts 顶部 +5 空行）
  pre=5 post=5  旧键(行号)新增=2  新键(文件+正文)新增=0  PASS
    旧键误报 apps/zcode-cli/packages/tui/src/app-events.ts:92	网络请求列表。
    旧键误报 apps/zcode-cli/packages/tui/src/app-events.ts:100	模型用量汇总。
```

- 回放 1 与原结论一致（`6 → 5`、新增 0）。
- 回放 2 是真实测量：15 个文件复制到临时树，在 `app-events.ts` 顶部插 5 行空行，该文件两条 weak 从 87/95 位移到 92/100；旧键把位移误报成 2 条新增，新键判 0。
- **没有「真的插过行」的历史批次可回放**：B1–B10 十批 numstat 全是 `+N/−N`（68/64/62/68/65/60/49/68/99/97），净 0 行。因此插入场景用真实尺子实测，而不是伪造日志。

**本批 1b 结果：**

```text
WEAK 15文件  pre=5  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

## 1. 15 文件 weak 基线：带来源链

| 时点 | weak / 分母 | 变化来源 |
| --- | --- | --- |
| B1 前（冻结基线） | `8 / 3353` | 阈值 `≤ 8/3353` 的出处 |
| B7 后 | `7 / 3353` | B7 两文件各修 1 条 |
| B8 后 | `7 / 3353` | ±0 |
| B9 后 | `6 / 3353` | `app-events.ts` 3 → 2 |
| B10 后 | `5 / 3353` | `RewardsWebview.tsx:284` |
| B11 后 | `4 / 3353` | `CommandForm.tsx` 1 → 0 |

- **分母 3353 是 15 文件清单的注释总数，固定不随批次变**（各批 units/comments 逐值不变，可复核）。
- 阈值 `≤ 8/3353` 保留为**冻结基线**（B1 前实测），不随当前值下调。
- 断言 1（全仓 weak 率 ≤3.1%）仍只作兜底、不作质量证据；每批能失败的证据是断言 1b + 断言 3。

## 2. 收尾等式：机器判定已落地

`ledger-assert` 新增两条输出并纳入断言：

```text
CLOSE 742 + B12 60 = 802  OK
FILELIST 15 文件 == 批次表清单  OK  (d:\code\_annot_baseline\b254-802-files.txt)
```

- `CLOSE` 按「未完成批次」聚合：`802 = 742（B1–B11）+ 60（B12）`；同时断言 `各未完成批合计 == 剩余`。
- `FILELIST` 逐条比对收尾 `--file-list` 与 b247 批次表的 15 个路径（数量、去重、集合相等），**不另生成清单**。
- 收尾作用域/提交/命令/冲突取舍仍按 b258 §1 执行（干净 worktree @ `CLOSE_SHA`）。

## 3. 三列滚动行（`ledger-assert`）

```text
SUM 各批 = 68 + 64 + 62 + 68 + 65 + 60 + 49 + 68 + 99 + 97 + 42 = 742  OK（逐文件登记数 == 批次表计划数）
ROLL 144  计划 144  累计 138  剩余 6  OK
ROLL 658  计划 658  累计 604  剩余 54  OK
ROLL 802  计划 802  累计 742  剩余 60  OK
CUM 累计 742 + 剩余 60 = 802  OK
PLAN 批次表合计 802  = 802  OK
GREP 全仓 62 = 清单内 60 + 清单外 2  OK
OUTSIDE docs/annotation/_tools/d7e-shift.mjs:1 , docs/webdriverio/docs/ocr-testing/ocr-faq.md:1
REMAIN 剩余 = 60
CLOSE 742 + B12 60 = 802  OK
FILELIST 15 文件 == 批次表清单  OK  (d:\code\_annot_baseline\b254-802-files.txt)
ASSERT PASS
```

## 4. 本批分类（42 行：改写 8 / 只去前缀 34）

| 判据 | 行 | 改写 |
| --- | --- | --- |
| W | 35 | 补 `NAME_REGEX` |
| W | 94 | 「组件」→ `CommandForm` |
| W | 111 | 补 `initialName` + 「否则光标会跳到行尾」（PREDICATE） |
| W | 134 | 补 `nameError` |
| W | 136 | 补 `validate` |
| W | 140 | 补 `NAME_REGEX` / `nameRegex` |
| W | 186 | 「事件对象」→ `event` |
| W | 203 | 「作用域控件」→ `scopeSelect` |

其余 34 行只去一层前缀。

## 5. 门禁七行（`zc-commit` v12，blob `a35b42fa2e4c`）

```text
删本线注释    n=42  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=42  其中判据命中 0  其中嵌套注释 0
提交集合断言  expected=1  staged=1
```

三源一致：numstat `+42 −42` = TSV 42 行 = 门禁 42 行。CRLF、319 行不变、残留双前缀 0。

## 6. 度量（SUMMARY 前后）

| 文件 | units | comments | coverage | substance | explain | weak |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `CommandForm.tsx` pre | 167 | 65 | 10.2% | 92.3% | 98.5% | 1/65（1.5%） |
| `CommandForm.tsx` post | 167 | 65 | 10.2% | **95.4%** | **100.0%** | **0/65** |

## 7. 覆盖差集

`--uncovered` pre 150 行 / post 150 行，无差异（`onlyPre=0`、`onlyPost=0`）。

## 8. 三态（改前 blame）

42 行全部来自 `a8784b7e479d`：`own=1 upstream=0 pending=0`。

## 9. 回读三条（只去前缀、未改写）

```text
CommandForm:34  // 【不变量】命令名只允许字母、数字、下划线与连字符，点号与斜杠会破坏文件名映射。
CommandForm:47  // 【不变量】作用域选择器只接收 scopeKey 与变更回调，不持有第二份作用域状态。
CommandForm:78  // 【不变量】保存回调同时携带 config 与 scopeKey，作用域随一次提交原子传递。
```

## 10. 计时

- 起：19:26:24（`b259-b11-pre.txt` 落盘）
- 止：19:27:13（提交 `c5f1e134`）
- 合计 **49s**，`49 / 42 = 1.17 s/行`
- 返工 0；阈值 0.85–2.85 为**拍定值**（1.7 × 0.5 / 1.7 × 1.5），1.17 在区间内

## 11. 下一步

B12：`packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx`（6+54=60），完成后 802 清零；随即按 b258 §1 在干净 worktree @ B12 代码提交上执行三条收尾断言（断言 1 兜底、断言 2 15 文件 ≤8/3353、断言 1b `GUARD PASS`、断言 3 全批复核）。
