# b235 改写批（23–25 行档，三段计时第 2 批）

- 日期：2026-11-10
- base：`HEAD`（本批改写前 HEAD = `71b58952`）
- 范围：23–25 行档取 2 个文件（整文件不拆）
- 本批附带：b234 改前快照覆盖对照、b234 剩余 2 条 weak 定性

## 1. 文件与 numstat

| 文件 | weak 基线 | + | − |
| --- | --- | --- | --- |
| `packages/services/src/session/offPeakMockGateway.ts` | 24 | 24 | 23 |
| `apps/zcode-cli/packages/tui/src/app-submit.ts` | 23 | 1 | 24 |
| 合计 | 47 | 25 | 47 |

`app-submit.ts` 的 23 行是四段「一句话一行」的复述块（`:72-76`、`:130-135`、`:178-183`、`:268-273`），
每块上方已有完整 JSDoc，逐行删除；`+1` 是文件头补 `模块职责：`（见 §5）。
`offPeakMockGateway.ts` 是 22 行 1→1 改写 + 1 行删除（`// 取号。`）+ 1 行补回（同位置改为点名 `handleTake`，见 §5.3）
+ 1 行文件头补 `模块职责：`；另有 1 行（`:699`）改写后判定为上游注释，已原样还原，不计入 diff。净 +1 行注释。

## 2. 门禁输出（改写模式）

```text
=== 改写门禁（base=HEAD）===
删本线注释    n=47  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=25  其中判据命中 0  （必须 0；已扣除搬移行）
```

- 登记表：`docs/annotation/ZC-deep-b235-rewrite.tsv`（47 行，`file / baseLine / blame / kind / content`）。
- **本批搬移行数 = 0**（无行号可列）。按 §2.22 不变量，搬移行既不计入改写量也不计入新增注释行数；
  本批 25 行新增全部是重写句或新补的 `模块职责：` 行。
- 门禁跑第 1 次时失败，两项都是我自己的错，已修正后重跑：
  1. 补文件头时把块注释末行拆成两行，`*/` 行的前半段没有注释前缀 → 判成「删代码 1 / 新增非注释行 2」；
     改回「块注释原样 + 独立 `//` 行」后归零。
  2. `// 响应已发出，忽略。` 的 blame 是 `feat: open source`（上游），改写会被判「删上游注释」；
     已原样还原，该行继续留在 weak 里（见 §6）。

## 3. b234 改前快照对照（覆盖数变化）

方法：`git show 59dcc46d^:<path>` 字节还原到 `_annot_baseline/b234-pre/`（与仓库同相对路径），
以同一 `deep-quality v3 / --field-mode ast` 跑改前，与改后并排。

| 文件 | 单元（前/后） | coverage（前/后） | weak（前/后） | comments（前/后） |
| --- | --- | --- | --- | --- |
| `cuaDetails.tsx` | 99 / 99 | 4.0% / 4.0% | 24 / 2 | 46 / 30 |
| `highlighted-lightweight-diff-preview.tsx` | 79 / 79 | 5.1% / 5.1% | 23 / 0 | 45 / 30 |
| 合计 | 178 / 178 | 4.5% / 4.5% | 47 / 2 | 91 / 60 |

**未覆盖单元集合逐条对照：前 170 条、后 170 条、`onlyPre=0`、`onlyPost=0`。**
即删除的 45 行注释没有任何一行是某个单元的唯一注释；覆盖数的每一个分子分母都逐单元相同，
不是「应该不变」。命令与产物：`b234-pre-uncovered.tsv` / `b234-post-uncovered.tsv`（按 `path|unitText` 取差集）。

## 4. b234 剩余 2 条 weak 的定性

| 行 | 判据命中 | 定性 | 依据 |
| --- | --- | --- | --- |
| `cuaDetails.tsx:14` `INV-14 环境行有项才渲染…` | 仅「同义重复」 | **口径差（登记，不动）** | 「同义重复」判据是相邻两行 bigram Jaccard ≥ 0.6（`deep-quality.mjs:587-590`），属字形相似，不区分「同模板不同对象」。该行与 `INV-13`（权限行）只差一个名词，但各自绑定 `environmentRows` / `permissionRows` 与不同故障（空环境显示空表 / 空权限显示空表），且行内有 `INV-14` 数字锚点，其余判据均未命中。删除会让 INV 清单缺号并丢掉「环境行」这一条映射。 |
| `cuaDetails.tsx:86` `原始数据继续保留在协议与持久化层；这里仅渲染…` | 「无指代」+「无解释」 | **真水（b236 清）** | 该句没有标识符/数字/反引号，也没有 PRECOND/INVARIANT/谓词，且「这里」没有先行词——读者无法检索到它说的是哪个组件、哪一层。事实本身有价值（解释了为什么不全量渲染 tool call JSON），所以不删，改写成点名 `CuaToolCallDetails` / `toolCall.input` / 协议层的句子，按 §2.22「纯缺锚点只补符号名」。 |

## 5. b235 执行细节

### 5.1 改写方式

| 处理 | 行数 | 例 |
| --- | --- | --- |
| 整块复述删除（上方 JSDoc 已覆盖） | 23 | `app-submit.ts:72-76` 与 `:67-71` 逐句同义 |
| 保留事实、补符号名或具体字段 | 22 | `// 结算时间取服务端时钟。` → `// settled_at 取服务端时钟，不用请求携带的时间。` |
| 纯复述删除 | 1 | `// 取号。`（路由字符串与 `handleTake` 已自明） |
| 文件头补 `模块职责：<export> ——` | 2 | `appendAgentResult / submitIdleTurn`、`startOffPeakMockGateway` |

没有一行属于「调标点凑判据」：门禁「标点级改写 = 0」；新增 25 行逐句核对，都带了被删句没有的
符号名、字段名或后果。

### 5.2 覆盖数变化与逐条归因

| 文件 | 单元（前/后） | coverage（前/后） | branch（前/后） | 归因 |
| --- | --- | --- | --- | --- |
| `app-submit.ts` | 177 / 177 | 9.0% / 9.0% | 7.7% / 7.7% | 无变化；删的 23 行都不是任何单元的唯一注释 |
| `offPeakMockGateway.ts` | 545 / 545 | 33.4% / 33.4% | 61.7% / 61.7% | 首轮出现 −1 单元覆盖，已定位并修回（见 5.3） |
| 合计 | 722 / 722 | 27.4% / 27.4% | 52.1% / 52.1% | — |

### 5.3 唯一一处覆盖下降的归因（已修回）

首轮删掉 `// 取号。` 后，单元集合差集出现 **1 条新增未覆盖**：

```text
ONLY_POST  offPeakMockGateway.ts | B | if (url === "/api/v1/off-peak/ticket") {
```

即这行 2 字注释是该路由单元上方唯一的注释（同时是 branch 单元），删掉它 coverage 33.4%→33.2%、
branch 61.7%→60.0%。处理：同位置补回一句点名调用目标的注释
`// POST /api/v1/off-peak/ticket 交给 handleTake 取号。`，重测后 coverage / branch 与改前逐位相同。
这不是「为覆盖数硬凑」：原句只有「取号」两个字，补回句给出了方法与路径的对应关系，且过 W/L 判据（判据命中 0）。

## 6. 复测

| 指标 | 改写前 | 改写后 |
| --- | --- | --- |
| weak（两文件） | 47 | 1 |
| 其中 filler | 23 | 0 |
| comments | 341 | 319 |
| substance / explain | 78.9% / 89.1% | 89.0% / 99.7% |

剩余 1 行：`offPeakMockGateway.ts:699 // 响应已发出，忽略。`，blame 为上游提交 `feat: open source`，
门禁禁止改上游注释，登记为**口径差（上游归属，不可改）**，不计入本线待清。

## 7. 三段计时

| 段 | 起 | 止 | 秒 |
| --- | --- | --- | --- |
| 读+判（开文件 → 决定第一处怎么改） | 15:23:22 | 15:24:18 | 56 |
| 写（连续编辑） | 15:24:18 | 15:25:18 | 60 |
| 门禁+提交 | 15:25:18 | 15:26:32 | 74 |
| **合计** | 15:23:22 | 15:26:32 | **190** |

合计与墙钟一致（190 = 56+60+74）。第 3 段里包含三次门禁（前两次失败）、b235 改前快照与未覆盖集合取差，
不是纯提交耗时；单看门禁+提交约 20 秒，其余是核对与返工。

累计（仅三段计时批）：

| 批 | 读+判 | 写 | 门禁+提交 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| b234 | 30 | 39 | 48 | 117 |
| b235 | 56 | 60 | 74 | 190 |

**中位数尚不成立**：只有 2 批有三段数据。凑第 3 批时按约定**排除 b231**（起点时间戳丢失，只有
mtime 推的 60–70 秒区间，无法拆段），并在表里注明排除原因，不静默丢弃。在此之前不给产能承诺。

## 8. 证据原文

```text
ruler=deep-quality v3 sha1=4be849e81205   zc-gate sha1=f53d75cdc9d7   zc-commit sha1=72349bb23278
```

与 b230 台账记的 `sha1=09c50b7bd5a2 / f75c5e64246f / 165fa79f96a1` 不一致：当前值取自本批实际运行的
`_annot_baseline/` 三件工具，b234/b235 的改前改后都用同一份（批内一致）。跨批 weak 计数以各批当时输出为准，
不能用旧 sha1 复原。

```text
$ git log --oneline -4
14e81d85 b235 改写 2 文件的水句 (+25/−47)
71b58952 docs(注释): b234 三段计时、搬移不变量与 b229 登记表 judge 列 (+191/−54)
59dcc46d b234 改写 2 文件的水句 (+14/−45)
03b4d934 docs(注释): b230–b233 台账、抽样表与计时 (+258)
```

```text
$ deep-quality --files <b235 两文件> --metric-version v3 --field-mode ast   # 改前（快照 b235-pre）
SUMMARY metric=v3 files=2 units=722 coverage=27.4% branch=52.1% field=26.0% comments=341 substance=78.9% explain=89.1% filler=6.7% weak=13.8%
RATIOS weak=47/341 filler=23/341

# 改后
SUMMARY metric=v3 files=2 units=722 coverage=27.4% branch=52.1% field=26.0% comments=319 substance=89.0% explain=99.7% filler=0.0% weak=0.3%
RATIOS weak=1/319 filler=0/319
```

```text
$ deep-quality --files <b234 两文件> --metric-version v3 --field-mode ast   # 改前（快照 b234-pre = 03b4d934）
SUMMARY metric=v3 files=2 units=178 coverage=4.5% branch=0.0% field=0.0% comments=91 substance=54.9% explain=69.2% filler=49.5% weak=51.6%
RATIOS weak=47/91 filler=45/91

# 改后
SUMMARY metric=v3 files=2 units=178 coverage=4.5% branch=0.0% field=0.0% comments=60 substance=95.0% explain=98.3% filler=0.0% weak=3.3%
RATIOS weak=2/60 filler=0/60
```

## 9. 遗留

1. `cuaDetails.tsx:86` 真水，b236 清（补 `CuaToolCallDetails` / `toolCall.input` 锚点）。
2. `cuaDetails.tsx:14` 口径差，登记不动。
3. `offPeakMockGateway.ts:699` 上游注释，登记不动。
4. 23–25 行档剩余未做文件 4 个：`runner-debug.ts`、`standalone-account-provider-runtime.ts`、
   `app-question-state.ts`、`runtime-checks.ts`。

## 10. 更正：§8 的 ruler 行混了两种 sha1 算法

§8 记的 `4be849e81205 / f53d75cdc9d7 / 72349bb23278` 是**文件 content sha1**，b230/b234 记的是
**git blob sha1**。两者对不同文件必然不同，所以看上去像三把尺子全变了。逐条核对结果：

| 工具 | b230 记（blob） | 本批记（content） | 同一条目？ | 结论 |
| --- | --- | --- | --- | --- |
| `zc-gate` | `f75c5e64246f` | `f53d75cdc9d7` | 是（v3，`f75c5e64246f` / `f53d75cdc9d7`） | **未改动** |
| `zc-commit` | `165fa79f96a1` | `72349bb23278` | 否 | **真改**：v3→v4（搬移行从新增注释扣除），b234 起生效 |
| `deep-quality` | `09c50b7bd5a2`（v1.8） | `4be849e81205`（v1.9） | 否 | **真换版**：另线 `4364e2e`（15:21）v1.8→v1.9，本线未参与 |

批次 ↔ 版本对照与归档见 `docs/annotation/_tools/INDEX.md`（含每版 sha1、改动、首个使用批次）。
从 b236 起 `ruler=` 一律写 blob sha1 + 版本号。

### 10.1 同尺重算（b234 / b235 改前改后）

用当前活文件（deep-quality v1.9、zc-gate v3、zc-commit v4）对四个快照各重算一次，并与批内当时的
v1.8 输出逐行比对 weak 集合：

| 快照 | v1.8 weak | v1.9 weak | 集合差异 |
| --- | ---: | ---: | --- |
| b234-pre | 47 | 47 | `onlyV18=0 / onlyV19=0` |
| b234-post | 2 | 2 | `onlyV18=0 / onlyV19=0` |
| b235-pre | 47 | 47 | `onlyV18=0 / onlyV19=0` |
| b235-post | 1 | 1 | `onlyV18=0 / onlyV19=0` |

**同尺重算逐字一致。** RATIOS 原文：

```text
b234 改前  RATIOS weak=47/91 filler=45/91
b234 改后  RATIOS weak=2/60 filler=0/60
b235 改前  RATIOS weak=47/341 filler=23/341
b235 改后  RATIOS weak=1/319 filler=0/319
```

唯一跨版本差异是 `substance`：b235 在 v1.9 下为 78.9% / 89.0%，v1.8 下为 78.6% / 88.7%（+0.3pp，
来自 `identTokens` 纳入全大写缩写）；b235 报告原本就用 v1.9，数字一致。结论：**六批的 weak 分子分母
可以并列写在同一张表里；substance / explain 不能跨版本比较。**

