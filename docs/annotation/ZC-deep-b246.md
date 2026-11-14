# b246 改写批（5 文件 + 658 行 (a) 类二次分类）

- 日期：2026-11-10
- base：`1da09719`（b245 台账提交，本批改写前 HEAD）
- 提交：`2896fd1e b246 改写 (+10/−10)`
- 尺子：`zc-commit v11`（`GATE self=… blob=3c65b811b847`）、`zc-gate v4`（`633b334905ee`）、`deep-quality v1.9 8042442fe198`
- 本批性质：b245 收下后继续 **5 文件**；跟办 658 行 (a) 类二次分类与抽样复核

## 1. 本批选谁

1–2 行档剩余排序取下一组（`deep-quality v1.9`，改前 `--list-weak` 实测 10 行）：

| 文件 | weak |
| --- | ---: |
| `packages/provider/src/config/provider-config.ts` | 2 |
| `packages/provider/src/facades.ts` | 2 |
| `packages/server/src/remote/localTarGz.ts` | 2 |
| `packages/shared/src/marketingTouch.ts` | 2 |
| `packages/shared/src/web-remote-control.ts` | 2 |

## 2. 归属预检（v6 白名单，31 条）

10 行 blame 全部为 `a8784b7e`（b1–b226 工作区注释快照）→ 本线，全部改写；无上游行。
`own-commits.mjs --check a8784b7e…` = 本线。

## 3. 门禁七行原文（v11）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=3c65b811b847
=== 改写门禁（base=HEAD）===
删本线注释    n=10  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=10  其中判据命中 0  其中嵌套注释 0  （必须 0；已扣除搬移行）
```

提交集合断言：`expected=5  staged=5`。

## 4. TSV 与「删本线注释」逐条对应（10 条 = 门禁 n=10）

登记表：`docs/annotation/ZC-deep-b246-rewrite.tsv`（10 行数据 + 表头）。

| # | 文件:行 | 改写后 |
| --- | --- | --- |
| 1 | `provider-config.ts:280` | `// 改错后：withBuiltinModelIds 的 overlay 若整体重建，userModels 会被清空，用户自选模型全部消失。` |
| 2 | `provider-config.ts:638` | `// 改错后：objectWithoutUndefined 若原样返回，undefined 键会制造伪差异，每次保存都触发无意义落盘与广播。` |
| 3 | `facades.ts:599` | `// [资源] cleanup 只在 #providerMutationTails 的队尾仍是当前项时才 delete，防止删掉后来者的队尾。` |
| 4 | `facades.ts:619` | `// [契约] waitForProviderOperations 只 await 当前队尾 Promise，不阻塞后续 #mutateProvider 入队。` |
| 5 | `localTarGz.ts:88` | `// tar 规范要求两个全零结束块；这里消费第一个就 break，第二个随 offset 越过 EOF 由 while 条件排除。` |
| 6 | `localTarGz.ts:415` | `// normalized 为 ".."、空串或以 "../" 开头时一律 throw，不降级成 skip：调用方必须显式处理越界。` |
| 7 | `marketingTouch.ts:133` | `// discriminatedUnion 的 image 与 video 分支都要求 default 素材，dark 与 fallback 可选。` |
| 8 | `marketingTouch.ts:161` | `// marketingPopupSchema 固定为 title + description + 可选 visual + 最多四个 buttons，不额外扩展字段。` |
| 9 | `web-remote-control.ts:254` | `// [权衡] matchesWebRemoteControlRoutePath 只归一尾斜杠：大小写与百分号编码保持原样，不做二次归一。` |
| 10 | `web-remote-control.ts:867` | `// [权衡] WebRemoteControlWorkspaceListResult 不做过滤：已关闭的激活项也要返回，过滤属于选择逻辑。` |

10 删 / 10 增，差值 0。

## 5. 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=5 units=1652 coverage=9.9% branch=11.0% field=1.7% comments=761 substance=91.3% explain=98.8% filler=0.0% weak=1.3%` | `weak=10/761` |
| 改后 | `files=5 units=1652 coverage=9.9% branch=11.0% field=1.7% comments=761 substance=91.6% explain=100.0% filler=0.0% weak=0.0%` | `weak=0/761` |

`--list-weak`：10 → **0**（本批无上游豁免行）。

覆盖差集（改前快照在 `HEAD=1da09719` 的 `--detach` 工作树里跑）：

```text
UNCOVERED units=1488（去重键 1108）pre → 1488（1108）post
onlyPre=0  onlyPost=0
```

## 6. numstat

```text
+2 −2  packages/provider/src/config/provider-config.ts
+2 −2  packages/provider/src/facades.ts
+2 −2  packages/server/src/remote/localTarGz.ts
+2 −2  packages/shared/src/marketingTouch.ts
+2 −2  packages/shared/src/web-remote-control.ts
合计 +10 −10
```

## 7. 三段计时

| 段 | 打点 | 秒 | 性质 |
| --- | --- | ---: | --- |
| T0 → T1（选片、读上下文、blame、改前快照） | 18:14:29.974 → 18:14:56.318 | 26.3 | 固定 |
| T1 → T2（编辑 10 行） | 18:14:56.318 → 18:14:59.622 | 3.3 | 可变 |
| T2 → T3（改后快照 + 门禁 + 提交） | 18:14:59.622 → 18:15:30.881 | 31.3 | 固定 |
| **合计 == 墙钟** | 18:14:29.974 → 18:15:30.881 | **60.9** | — |

每文件均摊：60.9 / 5 = **12.2 秒/文件**。零返工（无门禁迭代）。

## 8. 658 行 (a) 类二次分类（本批必须先办的事）

### 8.1 判据（两版，第二版才是最终）

(a) 的原判据只证明「剥一层后文本合格」，没证明「这层 `//` 是多余的」。二次分类按**父块性质**：

1. 把连续的 `//` 行归为一个注释块；
2. 块内逐行剥掉注释符，判是否为**代码行**；
3. 块内代码行占比 ≥ 50% → 该块是「注释掉的代码」；否则是「说明性注释块」；
4. (a) 行随父块定性：说明性注释块 → **A1 可去前缀**；注释掉的代码 → **A2 不可逐行去前缀**（随块删除或整块保留）。

**判据第一版（错）**：关键词 + 代码形状即算代码行。`app-events.ts:284-291` 的散文块因为正文里出现
`switch` / `case` / `break` / `default` 被判成注释掉的代码，产出 `PROSE=652 / DEADCODE=6`。

**人工复核当场发现 6 条全部误判**（该块是在解释一个 switch 分支的语义，不是被注释掉的 switch），
按「1 条不符就退回重定」退掉第一版，加一条硬条件：**代码行必须不含中文**（`!CJK`）。中文散文即使提到
`switch`/`case` 也不再算代码行。

### 8.2 二次分类计数（最终判据）

| 类 | 行数 | 判据 |
| --- | ---: | --- |
| **A1 有效注释被误包**（父块为说明性注释） | **658** | 父块代码行占比 < 50% |
| **A2 死注释**（父块为注释掉的代码） | **0** | 父块代码行占比 ≥ 50% |
| 合计 | 658 | — |

补充验证：对 802 行全量扫「无中文且具代码形状」的行，命中 **0** —— 这 15 个文件的注释块里没有
真正被注释掉的代码段，全部是中文说明文字。

### 8.3 文件分布

| 文件 | (a) 总 | A1 | A2 |
| --- | ---: | ---: | ---: |
| `apps/zcode-cli/packages/tui/src/app-view.tsx` | 55 | 55 | 0 |
| `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` | 41 | 41 | 0 |
| `apps/zcode-cli/packages/tui/src/app-events.ts` | 37 | 37 | 0 |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | 1 | 1 | 0 |
| `packages/shared/src/workspace-hook-digest.ts` | 42 | 42 | 0 |
| `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts` | 49 | 49 | 0 |
| `packages/shared/src/git.ts` | 49 | 49 | 0 |
| `packages/ui/src/store/offPeakTaskStore.ts` | 58 | 58 | 0 |
| `packages/ui/src/components/ai-elements/audio-player.tsx` | 36 | 36 | 0 |
| `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx` | 58 | 58 | 0 |
| `packages/ui/src/settings/CommandForm.tsx` | 34 | 34 | 0 |
| `packages/ui/src/rewards/RewardsWebview.tsx` | 45 | 45 | 0 |
| `packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx` | 54 | 54 | 0 |
| `packages/ui/src/lib/pptxElementReference.ts` | 51 | 51 | 0 |
| `packages/ui/src/lib/usageEntitlementRefreshPolicy.ts` | 48 | 48 | 0 |
| **合计** | **658** | **658** | **0** |

### 8.4 10 行人工复核（判据命中率）

每文件抽第一条 (a) 行，连同父块一起人工读：

| # | 文件:行 | 父块 | 块内代码行 | 人工判定 |
| --- | --- | --- | ---: | --- |
| 1 | `app-view.tsx:130` | 130-137 | 0/8 | A1 说明性注释 |
| 2 | `app-sidebar.tsx:89` | 85-91 | 0/7 | A1 说明性注释 |
| 3 | `app-events.ts:60` | 60-67 | 0/7 | A1 说明性注释 |
| 4 | `workspace-hook-digest.ts:35` | 35-40 | 0/6 | A1 说明性注释 |
| 5 | `conversationTurnNavigatorHelpers.ts:28` | 28-35 | 0/8 | A1 说明性注释 |
| 6 | `git.ts:22` | 22-29 | 0/8 | A1 说明性注释 |
| 7 | `offPeakTaskStore.ts:167` | 167-174 | 0/8 | A1 说明性注释 |
| 8 | `audio-player.tsx:46` | 46-52 | 0/7 | A1 说明性注释 |
| 9 | `ResponsiveBrowserViewport.tsx:115` | 115-122 | 0/8 | A1 说明性注释 |
| 10 | `pptxElementReference.ts:28` | 28-34 | 0/7 | A1 说明性注释 |

**复核结果 10/10 与判据一致。** 唯一一次不符发生在判据第一版（`app-events.ts:284-291` 的 6 行），
已按规则退回重定，最终版 0 不符。

### 8.5 处置建议（本批不改）

- A1 658 行：去掉多余一层 `//`，恢复为有效注释；
- A2 0 行：无死注释，本类为空，不需要「随块删除」的动作。

## 9. 658 行改动的执行约束（确认项）

无论走哪条，这 658 行的改动都是**改写**不是新增，已确认按下面执行：

1. 走 `zc-commit --rewrite-annot --base <本批前 HEAD> --register ZC-deep-XXXX-rewrite.tsv`，
   逐行登记 `file / baseLine / kind / content`；
2. 门禁七行必须全 0，**含 v11 的嵌套注释判据**：去前缀后的行等于把 `// // 正文` 改成 `// 正文`，
   新增行不再嵌套，`其中嵌套注释` 必须是 0（若某行去前缀后仍以 `//` 开头，说明这行原本就有三层，直接判红）；
3. 改后必须跑一次 `deep-quality`，证明「活注释变多」没有制造新的 weak：
   比对 `--list-weak` 与 `--uncovered` 前后差集，要求本线 weak 不增、`onlyPre/onlyPost` 有据可查。

## 10. 白名单与 capacity 断言

capacity-estimate（b246 登记表纳入后）：

```text
done files=63 lines=588
1-2 档剩余 306 文件 / 387 行
SUM 944 文件 / 6833 行 / 347 批
ASSERT PASS
```

## 11. 下一步

1. b247 继续 4–5 文件（b246 均摊 12.2，零返工）；
2. 658 行 A1 立项：按 §9 的约束走 rewrite.tsv + 门禁 + deep-quality 复核；建议拆成每批 ≤ 100 行，返工半径可控；
3. A2 为空，不需要死注释清理批次。
