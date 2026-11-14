# ZC-deep-b384

> 批次：b384 ｜ **20 行 / 10 文件** ｜ 提交 `6a0f8038`

## 0. 普通批；`fix=0`；**判据类 0 / 格式类 0 / lint 2（写盘前）**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | **2** | `feedbackLogArchive.ts:392` 的「据此」、`gitCliRepo.ts:1917` 的「在此」命中禁用代词，改成「按实际字节」「转成」后通过 |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 0 | `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

- 本批 20 行全部靠反引号标识符过锚点判据（`removeBotRuntimeLockPath`、`deps.read`、`stat`、`preflight` 等）；
  按 b383 前的旧口径，其中 6 行会被判 W。

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/services/src/bots/channelRuntime.ts` | 2 | 0 |
| `packages/services/src/bots/groupResultDelivery.ts` | 2 | 0 |
| `packages/services/src/conversation-share/conversationShareHttpClient.ts` | 4 | 2 |
| `packages/services/src/conversation-share/conversationSharePublicProjection.ts` | 2 | 0 |
| `packages/services/src/conversation-share/conversationShareWorkflowSnapshot.ts` | 2 | 0 |
| `packages/services/src/credential/providers/credentialCipherProvider.ts` | 2 | 0 |
| `packages/services/src/feedback/feedbackLogArchive.ts` | 2 | 0 |
| `packages/services/src/git/repo/gitCliRepo.ts` | 2 | 0 |
| `packages/services/src/model-provider/codingPlanProviderAvailability.ts` | 2 | 0 |
| `packages/services/src/session/claude-native/claudeNativeSessionHeadParser.ts` | 2 | 0 |
| **合计** | **20** | **2** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **10** | **9** | **0** | 1,503 → 1,494 | 1,405 | **89** | `1,503 − 9 + 0 = 1,494` ✔；`1,405 + 89 = 1,494` ✔ |

- **四个数必须同时出现**（b385 起固定）：`集合 = ACTIVE + 表外`，差 0 才闭合。
  b384 的表外是 **89**，比 b383 的 91 少 2——那 2 个是表外文件被本批彻底清零，不是新进。
  「新进 0」是**前后批文件集差**，只回答「有没有新文件进来」；表外列回答「快照当初漏了多少」。

- 未全仓清零的 1 个：`conversationShareHttpClient.ts`（`4 → 2`，剩余两行为上游 `872ad960` 的 297/298），与 `pick` 的 `upOut=2` 一致。
- **`可清` 指标本批退役**：`NEVER-CLEAR.tsv` 按当前扫描重算状态列——**CLEARED 115 / ACTIVE 1,405**。
  b383 时是 108 / 1,412；本轮 9 个全仓清零文件中 7 个在表内，另 2 个本就在表外。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=6a0f8038 files=10/10 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=34 auto_self_clear=0
gate: PASS order n=0 total=140.0s controllable=133.0s
GATE ALL PASS batch=b384 sha=6a0f8038
```

**`allowed` 拆三项（b384 起必写）**：

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
```

- 自清表数据行现为 **14**（手工 6 + 自动 8），不再是 b378 写的常数 12；本批无新增自动登记。

## 3. 进度

- 全仓 weak：**3,576 → 3,556**（−20）；weak 文件 **1,503 → 1,494**。
- 池内：**319 行 / 259 文件**（`7,102 + 319 = 7,421`、`748 + 259 = 1,007`、`ALIGNED OK`）。
- **行侧进度 95.7%**（7,102 ÷ 7,421）；文件侧 `748 ÷ 1,007 = 74.3%`（辅助）。
- **残留两列**：池内可写 **319 行** / 池外残留 **3,237 行**（`3,556 − 319`，两列相加 = 全仓 weak）。
- 剩余批数（cap 10）：**26 批**（259 ÷ 10）。
- 集合末行只作观测：1,494 = `1,520 − 115 CLEARED + 89 表外`，不再据此判定「到底」。

## 4. 计时（一位小数，S0–S4 之和 = 收口）

TOOL_TRIP: 29.0（S1+S2 全段：两次 closeout 解析返修——`ACCT` 千分位 + 「合计」行误匹配。取整段为上界，正常单轮 closeout 也在内，故实际往返略小于 29.0；`S3` 的 129.3s 是台账写作，属真实成本，不扣）
> b394 回标：原 `ACCIDENT_TIMING`（整批剔除）撤销。理由同 b381：扣往返、留批次。b384 收口 `166.3 − 29.0 = 137.3s`。

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `5c28b3bd`（16:45:33） | `6a0f8038`（16:47:53） | 140.0 |
| `controllable` | `--start`（16:45:40） | 批次提交 | 133.0 |
| **S0** 提交 → closeout | 16:47:53 | 16:48:00 | **7.0** |
| **S1+S2** 扫描 + 1b/1c + rewrite/白名单/capacity | 16:48:00 | 16:48:29 | **29.0**（3 次；首两次被 `ACCT` 千分位与「合计」行误匹配拖住） |
| **S3** 台账 | 16:48:29 | 16:50:38.3 | **129.3** |
| **S4** 提交 | 16:50:38.3 | 16:50:39 | **1.0** |
| **收口 S0–S4** | 16:47:53 | 16:50:39 | **166.3**（7.0 + 29.0 + 129.3 + 1.0） |
| **批墙钟** | 16:45:40 | 16:50:39 | **299.3**（133.0 + 166.3） |

**`[1b 校验]` / `[1c allowed]` 首行原文（b384 实跑证据）**：

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
[1b 校验] batch=b384 pre=b383 weak=d:/code/_annot_baseline/b384-repo-post.txt weak_rows=3556 plan=20 head_added=20
```

- 批号显式传入、无默认值；`plan=20 == head_added=20` 才继续。

## 5. 点估计（主报）

```
[点估计] 1.14h = 26批 × 61.4 + 319行 × 3.45 + 26批 × 53.6s（收口中位 b383 31 / b382 53.6 / b381 130）→ 4090.6s
[点估计] 0.97h（收口维持 b383 的 31s）→ 3502.9s
```

- **主报 = `1.14h`**（模型输出）。批数 26 = `259 ÷ 10` 上取整；剩余 319 行；收口取 b381–b383 中位 `53.6s`。
- **收口是唯一剩余杠杆**：若维持 b383 的 `31.0s` 则 `0.97h`，差 `0.17h`。
- **观测上下界 `0.7–1.8h` 仍为参考**，不进主报（窗口 b381–b383 批墙钟 `240 / 139 / 96s`）。
- **⚠ 本批 S1+S2 的 29.0s 含两次解析返修**，是工具缺陷的代价，不是收口常态；修好后末次 closeout 为 9s。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `6a0f8038` | `+20/−20` |
| rewrite.tsv + 本台账 + 白名单 680 行 | `948423d3` | — |
