# ZC-deep-b260：B12「FeedbackBackgroundUploadIndicator」收口批（60 行 / 1 文件）+ 802 收尾

- 日期：2026-11-10
- 批次：B12（15 文件清单第 12 个 / 最后一个，60 < 100 不拆批）
- 目标文件：`packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx`（6 + 54 = 60）
- 本批行数：60（144 类 6 + 658 类 54）
- 代码提交：`c4325d90 b260 B12 去双前缀 (+60/−60)` = **`CLOSE_SHA`**
- 尺子：`deep-quality` v2.0（`756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` `4b914f3cbd26` + `weak-guard` **`a3600ccfacab`**（本批补盲区注释；CLOSE_SHA 内为 `890acea8347e`，判据相同）

## 0. `weak-guard.mjs` 三条已知盲区（注释，不改判据）

写在 [weak-guard.mjs](_tools/weak-guard.mjs) 头部第 14–20 行，读代码即可见，不另建文档：

```text
// 已知盲区（这是「近似守卫」，`新增=0` 只代表按本键没测到新增，不等于「绝对没新增」）：
//   ① 同一文件内两行同正文时按出现次数比：若其中一行位移、另一行被改写成与它相同的正文，
//      多集合计数不变，本守卫漏判（只看次数，不看是「哪一行」）；
//   ② 只比正文、不校验位置：同一文件内两行 weak 的正文互换，键的多重集合不变，本守卫不报；
//   ③ 多重集合的作用域是单个文件：跨文件把两行 weak 正文互换（A 文件的正文挪到 B 文件、
//      B 文件的正文挪到 A 文件），每个文件的计数都不变，本守卫不报。
//   以上三条都不改判据，只说明边界；需要逐行定位时以 deep-quality 的明细与人工复核为准。
```

- 只加注释，比较键、判定与退出码**一字未改**：blob `890acea8347e` → `a3600ccfacab`。
- 结论口径：`新增=0` 读作「本键未测到新增」，不得读成「绝对没新增」。
- 收尾用的就是这一版；同时用 `CLOSE_SHA` 内的旧版（`890acea8347e`）复跑一次，输出与退出码完全相同（`pre=4 post=4 新增=0`、`GUARD PASS`、`exit 0`）。

## 1. 收尾失败的处置分支（B12 之后没有下一批承接，提前写死）

| 项 | 定死内容 |
| --- | --- |
| 触发 | 三条收尾断言任一 `exit ≠ 0`；或干净 worktree `HEAD ≠ CLOSE_SHA`；或 `close-repo.txt` / `close-15.txt` 缺 `SUMMARY`/`RATIOS` 行 |
| 改哪里 | **不改 B12 本身**：不在 `c4325d90` 上 amend，不重写 `ZC-deep-b260-rewrite.tsv` |
| 怎么修 | 追加独立提交 `B12-fix`（subject `b260 B12-fix …`），在该提交上**重跑全部三条**，不是只跑失败的那一条 |
| `CLOSE_SHA` 指向 | 最终**全部通过**的那次提交（即最后一个 `B12-fix` 的完整 sha），并回填本节与 §2 |
| 台账记什么 | 中间失败次数、每次失败的断言编号、当次命令与原文输出、修复提交 sha |
| **禁止** | ① 为让断言通过去调阈值（3.1% / `≤8` / 分母 3353）；② 改写 `close-repo.txt` 的分母或截取更小的扫描范围；③ 把失败项降级成「已知偏差」 |

**本次实际：中间失败 0 次，未触发 `B12-fix`。**

## 2. 收尾三条断言（同一回合、干净 worktree @ `CLOSE_SHA`）

命令（原样执行）：

```powershell
$sha = (git -C d:/code/ZCode rev-parse c4325d90).Trim()
git -C d:/code/ZCode worktree add --detach d:/code/_b12_close_pre 87f58e0a
git -C d:/code/ZCode worktree add --detach d:/code/_b12_close $sha
$head = (git -C d:/code/_b12_close rev-parse HEAD).Trim()
node d:/code/_annot_baseline/deep-quality.mjs d:/code/_b12_close_pre --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak
node d:/code/_annot_baseline/deep-quality.mjs d:/code/_b12_close --root packages,apps            # -> close-repo.txt
node d:/code/_annot_baseline/deep-quality.mjs d:/code/_b12_close --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak   # -> close-15.txt
node d:/code/_annot_baseline/b260-close-assert.mjs --a1 d:/code/_annot_baseline/close-repo.txt
node d:/code/_annot_baseline/b260-close-assert.mjs --a2 d:/code/_annot_baseline/close-15.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/close-15-pre.txt --post d:/code/_annot_baseline/close-15.txt --max 8
```

原文输出（`b260-close-round.log` 摘录）：

```text
CLOSE_SHA=c4325d90bde8bc3b6ebb943311333f8e78560a6d
WT_PATH=d:/code/_b12_close
WT_HEAD=c4325d90bde8bc3b6ebb943311333f8e78560a6d
WT_HEAD_EQ_CLOSE_SHA=True
PRE_SCAN_EXIT=0
REPO_SCAN_EXIT=0
CLOSE15_SCAN_EXIT=0
A1 files=9491 units=1263663 comments=329480 weak=10081/329480 rate=3.060% metric=v3
A1 PASS 全仓 weak 率 ≤ 3.1%（兜底，不作质量证据）
A1_EXIT=0
A2 files=15 units=5735 comments=3353 weak=4/3353
A2 PASS 15 文件 weak ≤ 8/3353
A2_EXIT=0
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
A1B_EXIT=0
--- close-repo.txt SUMMARY/RATIOS ---
SUMMARY metric=v3 files=9491 units=1263663 coverage=8.3% branch=14.6% field=14.5% comments=329480 substance=82.5% explain=97.9% filler=1.5% weak=3.1%
RATIOS weak=10081/329480 filler=4833/329480
--- close-15.txt SUMMARY/RATIOS ---
WEAK lines=4 files=2
SUMMARY metric=v3 files=15 units=5735 coverage=14.4% branch=25.3% field=5.1% comments=3353 substance=94.2% explain=99.9% filler=0.0% weak=0.1%
RATIOS weak=4/3353 filler=0/3353
```

| 项 | 值 |
| --- | --- |
| 干净 worktree 实际路径 | `d:/code/_b12_close`（pre 对照 worktree `d:/code/_b12_close_pre` @ `87f58e0a`） |
| `HEAD` == `CLOSE_SHA` | 是（`c4325d90bde8bc3b6ebb943311333f8e78560a6d`） |
| `close-repo.txt` files / units / comments / weak | **9491 / 1263663 / 329480 / 10081**（率 3.060%，SUMMARY 取整 3.1%） |
| `close-15.txt` | files=15 units=5735 comments=3353 weak=4（`4/3353`） |
| `--file-list` | `d:/code/_annot_baseline/b254-802-files.txt` **本身**（`ledger-assert FILELIST` 已逐条比对 15 路径） |
| 断言 1（兜底）exit code | **0**（≤3.1%；只作兜底，失败也不代表质量问题） |
| 断言 2（`≤8/3353`）exit code | **0** |
| 断言 1b（pre/post 多重集合）exit code | **0**（`新增=0`、`GUARD PASS`） |

- 三条断言全部在干净 worktree 上判，**无一条只在主工作区跑过**，因此本节不含「不作结论」标注。
- 主工作区读数（诊断用，不进结论）：单文件 substance `90.4 → 92.8`、weak `0/83`；15 文件 `pre=4 post=4`、`substance 94.1 → 94.2`。

## 3. 收口数字（两行）

```text
计划式：742 + 60 = 802
实测式：SUM 802 / ROLL 802 / GREP 清单内 0+清单外 2 = 2（清单内实测 0 = 剩余 0）
```

- **实测式 vs 802 的差额：SUM 差 0，ROLL 差 0，GREP 清单内残留差 0。**三侧均为 0，不存在登记问题或真实缺口。
- 依据（`ledger-assert`，主工作区台账目录，`exit 0`）：

```text
BATCH ZC-deep-b248-rewrite.tsv	68 行
BATCH ZC-deep-b249-rewrite.tsv	64 行
BATCH ZC-deep-b250-rewrite.tsv	62 行
BATCH ZC-deep-b251-rewrite.tsv	68 行
BATCH ZC-deep-b252-rewrite.tsv	65 行
BATCH ZC-deep-b253-rewrite.tsv	60 行
BATCH ZC-deep-b255-rewrite.tsv	49 行
BATCH ZC-deep-b256-rewrite.tsv	68 行
BATCH ZC-deep-b257-rewrite.tsv	99 行
BATCH ZC-deep-b258-rewrite.tsv	97 行
BATCH ZC-deep-b259-rewrite.tsv	42 行
BATCH ZC-deep-b260-rewrite.tsv	60 行
SUM 各批 = 68 + 64 + 62 + 68 + 65 + 60 + 49 + 68 + 99 + 97 + 42 + 60 = 802  OK（逐文件登记数 == 批次表计划数）
ROLL 144  计划 144  累计 144  剩余 0  OK
ROLL 658  计划 658  累计 658  剩余 0  OK
ROLL 802  计划 802  累计 802  剩余 0  OK
CUM 累计 802 + 剩余 0 = 802  OK
PLAN 批次表合计 802  = 802  OK
GREP 全仓 2 = 清单内 0 + 清单外 2  OK
OUTSIDE docs/annotation/_tools/d7e-shift.mjs:1 , docs/webdriverio/docs/ocr-testing/ocr-faq.md:1
REMAIN 剩余 = 0
CLOSE 802 = 802  OK
FILELIST 15 文件 == 批次表清单  OK  (d:\code\_annot_baseline\b254-802-files.txt)
ASSERT PASS
```

- `GREP` 的清单外 2 条是**历史上就存在的清单外残留**（工具脚本与第三方文档），不在 802 的 15 文件内，也不是本工程缺口；干净 worktree 上 `git grep -c -E '^\s*// //'` 同样只命中这两条，清单内 0。
- 差额为 0 的说明：SUM 侧 12 批登记行相加 `= 802`；ROLL 侧 `累计 802 + 剩余 0 = 802`；GREP 侧 15 文件内实测残留 0、剩余计划 0，两侧相等。

## 4. 本批分类（60 行：改写 6 / 只去前缀 54）

| 判据 | 行 | 改写后 |
| --- | --- | --- |
| W | 46 | `// 把 SUCCESS_DISMISS_DELAY_MS 放在模块顶层而不是卡片内部，是为了让测试与实现引用同一个常量，避免魔法数字漂移。` |
| L | 50 | `// 该值不参与任何计算而只作为延迟时长传入，因此不需要按环境区分。` |
| W | 98 | `  // useState 的初始值直接取全局注册表快照，而不是空数组：卡片挂载与提交发起可能落在同一帧，` |
| W | 100 | `  // [并发] setJobs 的惰性初始化只在首次渲染执行一次，后续快照变化全部走订阅回调；` |
| W | 114 | `  // 把 jobs 放进依赖会变成“每次广播重新订阅”，回调在遍历监听器集合时被增删，订阅数量增长不可控。` |
| L | 183 | `  // 日志只记 jobId、状态与目标类型而不打印表单、提示词或附件内容，避免用户输入落进日志文件。` |

其余 54 行只去一层前缀，正文零改动。`L` 两行靠把并列逗号改成「而」并入 PREDICATE（分隔符降到 1 且出现谓词标记）；`W` 四行靠补标识符（常量名 / `useState` / `setJobs` / `jobs`）。

## 5. 门禁七行（`zc-commit` v12，blob `a35b42fa2e4c`）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=a35b42fa2e4c
删本线注释    n=60  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=60  其中判据命中 0  其中嵌套注释 0
提交集合断言  expected=1  staged=1
```

- 三源一致：numstat `+60 −60` = `ZC-deep-b260-rewrite.tsv` 60 行 = 门禁 60 行。
- EOL 保持 CRLF，文件行数 363 不变，残留双前缀 0。
- 过程记录：首次带 `--yes` 的调用被外层 `Select-Object -First` 提前关管道（EPIPE）打断，只执行到 `git add`；改用日志落盘后重跑，因 `git diff`（工作区 vs 暂存区）为空被拒（「无 diff」）。先 `git restore --staged` 让改动回到工作区，再整批重跑通过——**未改文件内容、未改门禁**。

## 6. 度量（SUMMARY 前后）

| 文件 | units | comments | coverage | substance | explain | weak |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `FeedbackBackgroundUploadIndicator.tsx` pre | 173 | 83 | 6.4% | 90.4% | 100.0% | 0/83 |
| `FeedbackBackgroundUploadIndicator.tsx` post | 173 | 83 | 6.4% | **92.8%** | **100.0%** | **0/83** |

15 文件整表：`units 5735 / comments 3353` 不变，`substance 94.1% → 94.2%`，`weak 4/3353 → 4/3353`。

## 7. 覆盖差集

`--uncovered` pre 162 行 / post 162 行，`onlyPre=0`、`onlyPost=0`（正文改动全在注释行，覆盖单元未动）。

## 8. 三态（改前 blame）

60 行全部来自 `a8784b7e479d`：`own=60 upstream=0 pending=0`。

## 9. 回读三条（只去前缀、未改写）

```text
:44   // [权衡] 5 秒是“看得见但不挡路”的折中：短于 3 秒读不完工单号，长于 10 秒卡片会压住右下角
:68   // [契约] 返回值是类型守卫：只有成功或失败且确实带工单号时为真，调用方据此选择
:227    // [权衡] 进度先按 undefined 兜底为 0，再夹在 0 到 100 之间：上游可能给出负数或超过 100 的瞬时值，
```

三行与 pre 快照逐字相同（仅少一层 `// `），标点与全角引号未动。

## 10. 计时

- 起：19:29:08（`b260-b12-pre.txt` / `b260-pre15.txt` 落盘）
- 止：19:31:43（代码提交 `c4325d90`）
- 合计 **155s**，`155 / 60 = 2.58 s/行`
- 返工：内容返工 0；提交链路返工 1 次（EPIPE → 取消暂存 → 重跑），未触及文件内容
- 阈值 `0.85–2.85` 为**拍定值**（1.7 × 0.5 / 1.7 × 1.5），2.58 在区间内但接近上界

## 11. 收尾结论

- 三条收尾断言全部 `exit 0`，干净 worktree `HEAD` 与 `CLOSE_SHA` 相符，未触发 `B12-fix`。
- `802` 已清零：15 文件内残留双前缀 0；清单外 2 条为历史残留，不属本工程缺口。
- 计划式 `742 + 60 = 802` 与实测式三侧（SUM / ROLL / GREP）差额均为 0。
- 收尾 worktree `d:/code/_b12_close`、`d:/code/_b12_close_pre` 已在台账提交前移除，主工作区恢复原状（只有别的会话的未提交改动）。
