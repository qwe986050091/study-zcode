# ZC-deep 收口清单（写于 b287 后，remain 4,207）

> 目的：在 `remain` 归零之前把「算不算收口」「怎么复跑」「哪些口径还活着」「远端怎么办」固定下来，
> 避免收口当天临时定义成功标准。
> 当前快照：`post-b287`（`d0ae6bd6`）`done 3,214 / remain 4,207 / 池外 3,264`，43.3%。

## 1. A1 达成的判定条件

`remain == 0` 只是必要条件，不是充分条件。收口必须同时满足以下 6 条：

| # | 条件 | 判定方式 | 当前值 |
| --- | --- | --- | --- |
| A1-1 | 池内归零 | `capacity-estimate` 的 `REMAIN lines=0` | 4,207 |
| A1-2 | 池内对齐 | `ALIGNED acct_remain=0 pool_remain=0 diff=0` | 4,207 / 4,207 / 0 |
| A1-3 | 台账算术成立 | `ledger-assert` 输出 `ASSERT PASS` | PASS |
| A1-4 | 越界累计为 0 | 各批 `--scope` 的 `out_of_scope_edits` 与 `write_phase/record_phase` 累加 | 0 |
| A1-5 | 池外差额有解释 | 每个 `post-bXXX` 的池外变化 = 池外 own + `SELF-CLEAR`，逐条有行号 | `3264`（b287 后） |
| A1-6 | 全仓闭合 | `全仓 WEAK == 池外最终快照`（池内为 0 时成立） | 7,471 = 4,207 + 3,264 |

补充口径：

- **A1-5 是硬条件**。池外不是「不管」，而是「不排期 + 每批对账」；只要出现无法归因的差额，A1 不成立。
- **池外 `3,264` 是 `post-b287` 快照值，收口时以当时的 `post-b<N>` 为准**，不得直接引用本文件数字。
- 收口批仍要走完整七行门禁与第 8 行门禁，不允许「最后一批免检」。

## 2. 三个收口断言的命令与预期输出

以下命令假设仓库在 `d:/code/ZCode`，工具在 `docs/annotation/_tools/`，尺子在 `d:/code/_annot_baseline/`。
`<N>` 为收口批号，`<last>` 为收口批提交。

### 断言 ①：池内归零且两套账对齐

```powershell
node d:/code/ZCode/docs/annotation/_tools/capacity-estimate.mjs --batch b<N> `
  --weak d:/code/_annot_baseline/b<N>-repo-post.txt `
  --pre-weak d:/code/_annot_baseline/b<N-1>-repo-post.txt `
  --repo d:/code/ZCode
```

预期（关键行）：

```text
REMAIN files=0  remain=0
ALIGNED acct_remain=0 pool_remain=0 diff=0  OK
```

失败样例：`diff != 0` 说明「基线 weak − 现 weak」与池内实测不一致，必须回查 `SELF-CLEAR` 与 blame 白名单，
不得直接改台账数字。

### 断言 ②：台账算术与 802 收口

```powershell
node d:/code/ZCode/docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

预期：

```text
CLOSE 802: done + remain = 802, remaining = 0        OK
EXEMPT 2                                             OK
FILELIST 15 文件 == 批次表清单                        OK
b<N> 登记 <n> 行（非 802 批次，跳过归零断言）          OK
ASSERT PASS
```

### 断言 ③：全仓 weak 闭合（池外最终快照）

```powershell
node d:/code/_annot_baseline/deep-quality.mjs d:/code/ZCode `
  --root packages,apps,docs/knip --list-weak > d:/code/_annot_baseline/b<N>-repo-post.txt
```

预期末行：

```text
RATIOS ... weak=<池外最终值> ...
```

且 `weak` 必须等于断言 ① 输出的「全仓 − pool_remain」；收口时 `pool_remain=0`，故
`weak == 池外最终快照`。若两者不等，差额必须能逐行归因到 `SELF-CLEAR` / 池外 own，
否则 A1-5 不成立。

### 可选断言 ④：白名单一致性

```powershell
node d:/code/ZCode/docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node d:/code/ZCode/docs/annotation/_tools/own-commits.mjs d:/code/ZCode --verify
```

预期：`rows=<n> generated=<n> missing=0 extra=0 text=same`。

## 3. SPEC / INDEX 的最终状态

### 3.1 已作废（不得再引用）

| 口径 | 作废原因 | 替代 |
| --- | --- | --- |
| 旧 `s/行`（n=11，中位数 1.59） | 起草在 `--start` 前完成，分子不含起草；只对 b281–b283 成立 | 新口径 `s/行` 单列；工时一律用端到端 |
| b284 / b285 计时样本 | 连续两批「正文先写完」，测量失效 | 仅作记录，不进入任何中位数 |
| 裸写 `3,284` | 是 `post-b279` 快照，被误当成 b284 批后值 | `post-b279 3,284` / `post-b283 3,284` |
| JSDoc `/**` 开合行进 plan | weak 判据把开合行与相邻摘要拼成同一句，系统性误判 | 结构行过滤，不进 plan；判据不改 |
| `controllable` 当工时口径 | 不含门禁复跑、快照、台账，低估约 1.7 倍 | 端到端 `s/行` 报工时；`controllable` 只做批内比较 |
| 第 8 行门禁的 `git cat-file --filters` 基准 | 基准依赖 `core.autocrlf` / `.gitattributes`，同一份代码换配置判定就翻（b288 `cron.ts` 15 行假阳性） | b289 起取 `--start` 的实盘逐行快照 `<batch>-lines.json`；缺失即 `exit 2` |

### 3.2 现行（收口后继续有效）

- **工时**：`端到端 s/行 = (台账提交 − t-start) / 登记行`；当前 b286 实测 `5.67 s/行`，4,117 行 ≈ 6.5 h。
- **计时**：新口径样本独立累计（n=3：3.26、1.62、2.57），n≥5 之前不做新旧比较、不做新口径内部归因。
- **门禁**：七行门禁 + 第 8 行门禁（`indentChanged=0 eolChanged=0`）+ `SAME same_rewrites=0` + `--order` 顺序断言，缺一不可。
- **第 8 行门禁与 SAME 的基准**：一律取 `--start` 的实盘逐行快照；`LINE-DRIFT` 共用同一份（同一行元组、同一哈希）。
- **跨批数字**：池外 / 全仓 weak / `remain` 必须带 `post-bXXX`；两快照相减写区间。
- **归户**：A2 恒等式 `done + remain == 7,421` 只对池内成立；池外永久不排期，按批对账。
- **判据**：W 只认标识符 / PRECOND / INVARIANT；L 看「分隔符 ≥2 且无谓词」；结构行不进 plan。
- **质量指标**：首轮命中率（`b283 3.1% / b284 7.0% / b285 1.4% / b286 8.2% / b287 2.2%`），异常先查文件类型。

### 3.3 收口时 SPEC 需要新增的一节

- 「池外最终快照」：`post-b<last>` 的 `WEAK / files / filler` 三个数 + 归因表。
- 「SELF-CLEAR 总账」：累计行数、涉及文件、blame 归属（上游/本线）。
- 「A1 判定记录」：六条逐条勾选，附四条断言的实际输出。

## 4. 远端处置：三个选项与代价

### 事实核对（先纠正两个数）

- 远端：`origin = https://github.com/zai-org/ZCode.git`，本地分支 `main`。
- `origin/main..HEAD = 296` 个本线提交；其中 `8f7daaf0..HEAD = 163` 个是批次提交。
  **「257+」对不上任何现有口径**（最接近的是 296），本清单以 296 / 163 为准。
- `HEAD..origin/main = 2`：远端有两个 `chore: sync ZCode source` 提交（最新 `a9fe401e`），
  本地**落后 2 个**，直接推 `main` 必然 non-fast-forward。
- 工作树干净，`git status` 无未提交改动。

### 选项 ①：推到 origin 的新分支

```powershell
git push origin HEAD:refs/heads/annot-cleanup
```

- **能不能做**：取决于对 `zai-org/ZCode` 的写权限。`main` 受保护且本地落后 2 个，不能直推 `main`；
  推新分支可绕开 non-FF，但仍需仓库写权限（无权限时是 403，不是 non-FF）。
- **需要什么**：该组织仓库的 `write` 权限或 PAT；若仓库公开，等于把 296 个提交（含内部台账文档）公开。
- **对方怎么用**：`git fetch origin annot-cleanup && git switch annot-cleanup`，拿到完整历史。
- **信息损失**：无提交信息损失；代价是基线落后 2 个 sync 提交，评审需先 rebase/merge，
  且台账文档会进入公开历史。
- **额外风险**：推之前必须做 secrets 扫描（历史里的 `.env`、token），mirror/分支推送都会带上全部历史。

### 选项 ②：patch 包（series 或单文件）

```powershell
# series：保留每个提交的作者/时间/消息
git format-patch 8f7daaf0..HEAD -o d:/code/_patch_b287
# 单文件：体积小，但丢失提交边界与消息
git diff 8f7daaf0..HEAD > d:/code/zcode-annot-b287.patch
```

- **能不能做**：不需要远端权限，本地即可完成。
- **需要什么**：只需把目录/文件交给对方；对方需要有 `8f7daaf0` 这个基线提交。
- **对方怎么用**：series 用 `git am d:/code/_patch_b287/*.patch`；单文件用 `git apply`。
- **信息损失**：
  - series：保留 author/date/message，**无信息损失**；代价是 163 个文件、逐个 `am`，基线不一致时逐个冲突。
  - 单文件：丢失提交边界、作者与消息，只剩最终 diff；**有信息损失**。
- **额外风险**：163 个 patch 对 `main` 落后 2 个 sync 提交的情况同样敏感，冲突需手工解。

### 选项 ③：保持本地不动

- **能不能做**：可以，零权限、零网络。
- **需要什么**：无；只需保证仓库不丢（本地备份 / 磁盘快照）。
- **对方怎么用**：拿不到；只能由本机导出（临时改用 ②）。
- **信息损失**：对外为零，因为不交付；风险全部留在本机（磁盘故障 = 全丢）。

### 建议（供用户决策，不代替决策）

1. 若只是**存档与评审**：选 ② series，零权限、零信息损失，冲突可控。
2. 若要**长期协作**：选 ① 的新分支，但先 rebase 到 `a9fe401e`、做 secrets 扫描，并确认仓库可见性。
3. 若短期内不交付：③ + 定期 `git bundle create` 备份（bundle 可离线克隆，等价于完整历史）。

## 5. 收口当天的执行顺序

1. 跑断言 ①→②→③→④，四条全绿再宣布 A1。
2. 固化 `post-b<last>` 快照与 `SELF-CLEAR` 总账，写入 SPEC 新增节。
3. 更新 `INDEX.md`：计时样本、白名单行数、首轮命中率、池外最终值。
4. 按 §4 选定远端方案并执行；执行前做 secrets 扫描。
5. 打 tag（建议 `annot-cleanup-b<last>`），bundle 备份一份。
