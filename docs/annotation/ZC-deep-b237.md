# b237 改写批（23–25 行档收尾：`runner-debug.ts` 25 + `runtime-checks.ts` 23）

- 日期：2026-11-10
- base：`HEAD`（改写前 HEAD = `a1f911d5`）
- 范围：23–25 行档最后 2 个文件，整文件口径
- 本批附带：归属判据改根（`zc-commit` v6，白名单制）；b236 中位数算错更正（见 `ZC-deep-b236.md` §7）

## 1. 归属判据改根：标题 → sha 白名单

v5 只是把 `docs(注释):` 补进标题识别，问题没除：标题换个写法（`注释(docs):`、`annot(b236)`、纯 `b237`）
同一次误判会再来，而且有两向——把本线记成上游只是多拒一次；**把上游记成本线会直接放行改写上游注释**，
破 §2.6。现在改成：

> blame 出来的 sha ∈ 台账登记的批次 commit 集合 → 本线；否则上游。

- 白名单来源 1（自动）：各批台账 `docs/annotation/ZC-*.md` 里的 `提交 <sha>`、`git log` 证据块
  `<sha> bNNN …`、`安全快照 <sha>`。当前自动抽出 12 条。
- 白名单来源 2（手工）：`_tools/OWN-COMMITS.md` §2，登记没有独立批次台账的 L2 覆盖提交（11 条）。
- 合计 **23 条**，`node docs/annotation/_tools/own-commits.mjs d:\code\ZCode` 可随时复算，逐条带短标题与首次出现台账。
- 判据实现：`_tools/own-commits.mjs`（`loadOwnCommits` / `isOwnBlame`），`zc-commit v6` 动态 import，
  不再有 `isOwnCommit(title)`。

**b236 那 4 行回放**（`b236-replay.mjs`，base `e3ae4f13`）：

| 行 | blame | v5 判 | v6 判 | 期望 |
| --- | --- | --- | --- | --- |
| `app-question-state.ts:57` | `a7af675d` | 上游（错） | 本线 | 本线 ✅ |
| `app-question-state.ts:282` | `a7af675d` | 上游（错） | 本线 | 本线 ✅ |
| `app-question-state.ts:325` | `a7af675d` | 上游（错） | 本线 | 本线 ✅ |
| `cuaDetails.tsx:86` | `872ad960` | 上游 | 上游 | 上游 ✅ |

4/4 命中，`exit=0`。v6 在 b237 首跑就拦下了另一批真上游（见 §3），没有把它当本线放行。

## 2. 文件与 numstat

| 文件 | weak 基线 | + | − |
| --- | --- | ---: | ---: |
| `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` | 25 | 9 | 38 |
| `packages/desktop/scripts/gen-ui-fixture/runtime-checks.ts` | 23 | 5 | 24 |
| 合计 | 48 | 14 | 62 |

- `runner-debug.ts`：删 4 段「一句话一行」的步骤复述（`:136-141`、`:242-247`、`:584-589`、`:875-879`，共 23 行）
  + 合并重复的文件头（原 13 行双头 → 6 行单头，−7）+ 删 `responseBody` 的空注释 1 行；
  新增 9 行是 1 行字段注释（带 `sanitizeModelIODebugRecord` 锚点）、1 行 `waitFor` 之外的重写句、
  以及为补回被删块所覆盖单元的 1 行 `appendFileSync` 锚点等。
- `runtime-checks.ts`：删 6 段流程复述（`:27-30`、`:38-42`、`:88-91`、`:134-137`、`:159-162`、`:181-184`，共 25 行），
  新增 5 行：每个被删块各留 1 行带锚点（`4000ms`/`activeElement`、`1px`、`.viz-carousel`/`eventselect`、
  `Tweak`/`onChange`、`waitFor`）的句子。

## 3. 首跑与两次返工（本批不顺）

首跑：`删上游注释 n=4`、`标点级改写 n=3`、`新增注释命中判据 n=2`，退出码 1。

1. **4 行真上游**：`runner-debug.ts:118-119`、`:123-124` blame `872ad960 feat: open source`——
   是 `shouldRecordModelIO` / `isDevelopmentModelIOEnv` 上方与 JSDoc 重复的旧注释，属上游，已原样还原。
   v6 白名单在此第一次生效：v5 会靠标题把 `feat: open source` 判上游（碰巧对），v6 靠不在白名单判上游。
2. **3 行标点级改写**：合并文件头时把旧行「`//       并把单 session…`」改成「`//   并把单 session…`」、
   把 `；` 改成 `，`、把「阅读顺序」原样下移——去标点/空格后与旧行同串，被判标点级。
   处置：三行全部改成**实质不同**的表述（`压成…以避免`、去掉「默认/而非 expand 历史」、`记录入口 → 聚合解析 → …`）。
3. **2 行新增行 L 命中**（`无信息列举`）：新写的「模块职责」续行与「不变量」行都是 `、,，` ≥2 且无谓词。
   处置：改句式（`；模块级状态只有压缩基线 Map，其失效由文件重建触发`、`；超限时一律整文件重置`）。
4. **覆盖掉 5 个单元**（复测 `onlyPost=5`）：`responseBody?: unknown`、`const waitFor`、
   `for (const placement …)`、`checkCalendarAndCarousel`、`checkTweakLifecycle`——删掉的块是这些单元的唯一注释。
   处置：每处补 1 行带锚点注释（不是恢复成 4 行），复测回到 `onlyPre=0 / onlyPost=0`。

## 4. 门禁输出（改写模式，最终通过，原文）

```text
=== 改写门禁（base=HEAD）===
删本线注释    n=62  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=12  其中判据命中 0  （必须 0；已扣除搬移行）
```

- 登记表：[`ZC-deep-b237-rewrite.tsv`](ZC-deep-b237-rewrite.tsv)，62 行。
- 搬移行 0（行号列表为空）。退出码 0，提交 `832a0225 b237 改写 2 文件的水句 (+14/−62)`。

## 5. 改前/改后快照对照

| 指标 | 改前（`b237-pre/`） | 改后 |
| --- | --- | --- |
| units | 594 | 594 |
| coverage | 14.1% | 14.1% |
| branch | 5.3% | 5.3% |
| field | 37.7% | 37.7% |
| comments | 292 | 244 |
| weak | 48 | **0** |
| filler | 42 | **0** |

未覆盖单元按 `path|unitText` 取差集：前 386 / 后 386，**`onlyPre=0`、`onlyPost=0`**。

```text
改前 SUMMARY metric=v3 files=2 units=594 coverage=14.1% branch=5.3% field=37.7% comments=292 substance=70.2% explain=93.5% filler=14.4% weak=16.4%
改前 RATIOS weak=48/292 filler=42/292
改后 SUMMARY metric=v3 files=2 units=594 coverage=14.1% branch=5.3% field=37.7% comments=244 substance=79.1% explain=100.0% filler=0.0% weak=0.0%
改后 RATIOS weak=0/244 filler=0/244
```

分文件 weak：`runner-debug.ts` 25 → 0；`runtime-checks.ts` 23 → 0。

## 6. 三段计时：b237 不作样本

墙钟 `17:09:43 → 17:13:53 = 250s`。但本批的编辑与门禁是**交错**的（编辑 → 首跑失败 → 改 → 再跑 → 再改），
三段口径切不开；且 T1（第一处编辑前）**没有打点**，与 b231 同类缺陷。

| 段 | 起 | 止 | 秒 |
| --- | --- | --- | ---: |
| 读+判+写（含 3 次门禁返工，T1 未打点无法再拆） | 17:09:43 | 17:13:29 | 226 |
| 最后一次门禁+提交 | 17:13:29 | 17:13:53 | 24 |
| 合计（=墙钟） | 17:09:43 | 17:13:53 | 250 |

结论：**b237 不计入三段样本**（T1 缺失 + 含返工，两条都不满足）。有效样本仍只有 b234（117s）、
b235（190s）两个，中位数不报。b238 起两条硬约束：① 第一处编辑前先跑 `Get-Date` 留 T1；
② 门禁只在全部编辑结束后跑一次，返工算进第 3 段并在台账单列，不混进第 2 段。

## 7. 证据原文

```text
ruler=deep-quality v1.9 sha1=8042442fe198   zc-gate v3 sha1=f75c5e64246f   zc-commit v6 sha1=032283968d18
      own-commits.mjs sha1=79dfdb7b63b3     OWN-COMMITS.md sha1=642c16355f93
$ git log --oneline -1
832a0225 b237 改写 2 文件的水句 (+14/−62)
$ node docs/annotation/_tools/own-commits.mjs d:\code\ZCode
白名单提交数 23
```
