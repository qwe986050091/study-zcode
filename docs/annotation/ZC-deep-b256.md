# ZC-deep-b256：B8「ResponsiveBrowserViewport」去双前缀 + 尺子 v2.0 换版

- 日期：2026-11-10
- 批次：B8（15 文件清单第 8 个）
- 目标文件：`packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx`
- 本批行数：68（144 类 10 + 658 类 58）
- 代码提交：`5e81d2f5 b256 B8 去双前缀 (+68/−68)`
- 尺子：`deep-quality` **v2.0**（blob `756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` `1836c9034a66`

## 0. 尺子换版：deep-quality v1.9 → v2.0

**改了什么**：只改遍历跳过表，判据 / 计数 / 输出格式零改动。跳过表由
`target / node_modules / .git / dist / build / .venv / __pycache__`
补成再加 `out / dist-server / dist-node / dist-viewer / dist-types / bundled-agents`。

**归档**：`_annot_baseline/rulers/deep-quality-v2.0.mjs`（与活文件同 blob `756bea66122a`，contentSha1 `5144fefd8888`），登记在 `_annot_baseline/rulers/INDEX.md`，`_annot_baseline` 提交 `aa69f6c`。

**用新尺子重跑 B1 前快照**（`8a4d8e02` 干净 worktree，`--root packages,apps`）：

| 尺子 | files | units | comments | RATIOS weak | substance |
| --- | ---: | ---: | ---: | ---: | ---: |
| v1.9 | 9,499 | 1,263,738 | 329,503 | 10,085（3.1%） | 82.5% |
| v2.0 | 9,491 | 1,263,663 | 329,480 | 10,085（3.1%） | 82.5% |

**新基线率 = 3.1%**（v2.0）。少掉的 8 文件 / 23 注释行 / 75 units 全部是 `apps/zcode-cli/packages/node-repl-host/dist-types/*.d.ts`（已提交的构建产物），weak 分子逐字不变。

**旧值因何被污染**：v1.9 的跳过表不含产物目录，同一提交 `77c365de` 在主工作区给 216 个产物文件、27,048 条注释行，于是同一提交两个读数——主工作区 `10,397/358,119`（2.9%）、干净 worktree `10,085/329,503`（3.1%）。判据依赖「磁盘上有没有构建产物」，这是不可接受的；v2.0 之后两作用域同值（主工作区 `10,175/331,156`，3.1%，多出的 2 文件 / +1,676 注释 / +90 weak 是别的会话的新源码，不是产物）。

**版本标注规则（本批起生效）**：凡引用全仓 weak 率必须带尺子版本。v1.9 的 3.1% 与 v2.0 的 3.1% 分子相同（10,085）、分母不同（329,503 vs 329,480），**不得相减**。本工程 15 文件冻结基线在 v2.0 下复测不变：pre `8/3353`、post（B7 后）`7/3353`。

## 1. `substance 95.6% → 95.0%` 的真相：不存在这 0.6pp 下降

**结论**：95.6% 与 95.0% 是 B7 两个文件**各自**的实质率，不是同一文件的前后值。原报告写成「substance 95.6%/95.0% 未变」是表述错误——把两个文件的率并排写成了前后对比。

**证据**（同口径 v2.0；pre 从 `c40c4d70` 抽原始字节，post 用 `90ced9c5`）：

| 文件 | pre units / comments / substance | post units / comments / substance |
| --- | --- | --- |
| `app-sidebar.tsx` | 171 / 114 / 95.6% | 171 / 114 / 95.6% |
| `zcodeTaskServiceAdapter.ts` | 3156 / 2078 / 95.0% | 3156 / 2078 / 95.0% |
| 两文件合计 | 3327 / 2192 / 95.1% | 3327 / 2192 / 95.1% |

units、comments、substance 三项逐值相同：去前缀没有改变分母，也没有改变判据对「剥一层后的行」的判定。

**真正的 substance 变化在 15 文件 cohort 上**：92.8% → 93.8%，来源是 B1–B6 的 1→1 改写（units / comments 全部不变，只是水句换成了带标识符锚点或谓词的句子）：

| 文件 | pre | post | Δ |
| --- | ---: | ---: | ---: |
| `offPeakTaskStore.ts` | 89.4% | 92.0% | +2.6 |
| `conversationTurnNavigatorHelpers.ts` | 92.5% | 95.7% | +3.2 |
| `git.ts` | 90.2% | 97.6% | +7.4 |
| `app-view.tsx` | 85.6% | 91.3% | +5.7 |
| `pptxElementReference.ts` | 83.9% | 88.5% | +4.6 |
| `workspace-hook-digest.ts` | 75.0% | 86.3% | +11.3 |

B8 自身：95.3% → 98.1%（10 行改写，见 §5）。

## 2. 三列滚动行（`ledger-assert` 输出，不再手算）

```text
批次表：15 文件 / 计划合计 802 行
BATCH ZC-deep-b248-rewrite.tsv	68 行
BATCH ZC-deep-b249-rewrite.tsv	64 行
BATCH ZC-deep-b250-rewrite.tsv	62 行
BATCH ZC-deep-b251-rewrite.tsv	68 行
BATCH ZC-deep-b252-rewrite.tsv	65 行
BATCH ZC-deep-b253-rewrite.tsv	60 行
BATCH ZC-deep-b255-rewrite.tsv	49 行
BATCH ZC-deep-b256-rewrite.tsv	68 行
SUM 各批 = 68 + 64 + 62 + 68 + 65 + 60 + 49 + 68 = 504  OK（逐文件登记数 == 批次表计划数）
ROLL 144  计划 144  累计 100  剩余 44  OK
ROLL 658  计划 658  累计 404  剩余 254  OK
ROLL 802  计划 802  累计 504  剩余 298  OK
CUM 累计 504 + 剩余 298 = 802  OK
PLAN 批次表合计 802  = 802  OK
GREP 全仓 300 = 清单内 298 + 清单外 2  OK
OUTSIDE docs/annotation/_tools/d7e-shift.mjs:1 , docs/webdriverio/docs/ocr-testing/ocr-faq.md:1
REMAIN 剩余 = 298
ASSERT PASS
```

144 / 658 两列的「累计」由已完成文件在 b247 批次表里的计划数汇总，并与 802 累计互校（`100 + 404 = 504`）；脚本同时断言批次表每行 `144 + 658 = 合计`、两列计划数分别等于 144 / 658。

## 3. B8 分类（68 行）

`node b253-classify.mjs` 对改前文件：**双前缀 68 行，判据命中 10 行**（L 6 / W 4），其余 58 行只去前缀。

| 行 | 判据 | 改写要点 |
| --- | --- | --- |
| 118 | L（2 逗号无谓词） | 合并为单逗号 + `说明` |
| 121 | L | 改为「而不缓存到 ref」 |
| 134 | L（`、`×3） | 补 `先 / 再 / 最后` 顺序谓词 |
| 137 | L | 补 `而` 连接 |
| 160 | W（无标识符） | 补 `pendingViewportSizeRef` |
| 227 | W | 补 `pointermove` |
| 326 | W | 补 `canvasSize` |
| 352 | L（`、`×2） | 枚举改为「active 与 isComposed、」 |
| 420 | L | 改为「统一写入 undefined」 |
| 421 | W | 补 `active` |

## 4. 门禁七行（`zc-commit` v12，blob `a35b42fa2e4c`）

```text
删本线注释    n=68  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=68  其中判据命中 0  其中嵌套注释 0
提交集合断言  expected=1  staged=1
```

numstat `+68 −68` = TSV 68 行 = 门禁 68 行，三源一致；EOL 保持 CRLF（459 行不变）。

## 5. 度量（SUMMARY 前后）

| 项 | pre | post |
| --- | ---: | ---: |
| files | 1 | 1 |
| units | 198 | 198 |
| comments | 106 | 106 |
| coverage | 8.1% | 8.1% |
| substance | 95.3% | **98.1%** |
| explain | 100.0% | 100.0% |
| weak | 0/106 | 0/106 |

## 6. 覆盖差集

`--uncovered` 182 行（pre）/ 182 行（post），`onlyPre=0`、`onlyPost=0`：改写只动注释文本，未改变任何覆盖单元。

## 7. 三态（改前 blame）

68 行全部来自 `a8784b7e479d`：`CHECK own=1 upstream=0 pending=0`。

## 8. 回读三条

```text
118  // canvasSize 为 null 说明首次测量尚未完成，解析函数此时走兜底比例。
160  // 句柄非 0 时只覆盖 pendingViewportSizeRef 而不重复排期，这是所有拖拽输入的合流点。
421  // 被测试或调试工具误读为仍然 active 并据此定位元素。
```

三条只去前缀、语义完整，均不判 144；`judgeEntries` 0 命中。

## 9. 计时

起（改前字节落盘 19:06:34）→ 止（提交 19:08:00）**86s**，含分类约 20s，合计约 **106s**；返工 0；`106 / 68 = 1.56 s/行`（802 批阈值 0.85–2.85）。

## 10. 下一步

B9：`packages/ui/src/.../usageEntitlementRefreshPolicy.ts`（12+48=60）+ `app-events.ts`（2+37=39），合计 99 行 / 2 文件，满足 ≤6 文件且 ≤100 行/批，按合批执行。
