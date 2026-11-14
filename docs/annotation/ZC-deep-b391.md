# ZC-deep-b391

> 批次：b391 ｜ **20 行 / 20 文件** ｜ 提交 `8575456a` ｜ **cap 20 试验批**

## 0. 普通批；`fix=0`；**判据类 0 / 格式类 0 / lint 7**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | 7 | 6 条分隔符 ≥2（`bundled-plugins:430`、`script-workflow-runtime:368`、`session-facade:707`、`workflow-methods:171`、`interaction-broker:297`）+ 2 条禁用词（`script-workflow-process:175` 的「据此」、`subagent-session-query:122` 的「不该」），其中 1 条同时命中两项；改成分号与同义替换后一次过 |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 0 | `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

### 0.1 cap 20 试验：三项判据全过，**继续试验（n=1）**

| 判据 | 阈值 | 实测 | 结论 |
| --- | --- | --- | --- |
| `controllable` 不失控 | `≤ 1.5 × 130.4 = 195.6s` | **106.0s**（模型的 `0.81×`，比 b390 的 114.0s 还低） | **PASS** |
| 六闸一次全 PASS | 全绿 | `scope` / `record` / `verify` / `commit` / `pool-diff` / `order` 全 PASS | **PASS** |
| `pool-diff removed` | `== 20` | **20** | **PASS** |

- 20 文件批没有抬高固定成本：20 个都是单行文件，逐文件开销（预检、diff、记录）随文件线性增长的部分被单行内容抵消。
- **决定：b392 继续按 cap 20 试验**；连续两批全绿才写死进 CLOSING，期间任一闸异常立即回退 cap 10 并把回退记成结论。n=1 不构成规律。
- 若写死，剩余批数 `179 ÷ 20 = 8.95 → 9 批`，收口次数减少 9 次、约 `9 × 136.3 ≈ 1,227s`。
- 口径变更已同步 `closeout.mjs --cap` 与 `estimate-lib.mjs`（`batches = ceil(files / cap)`），见 §7。

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `apps/dev-docs/src/data/protocolDocs.ts` | 1 | 0 |
| `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-results.ts` | 1 | 0 |
| `apps/zcode-cli/packages/adapters/src/fs/index.ts` | 7 | 6 |
| `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts` | 3 | 2 |
| `apps/zcode-cli/packages/adapters/src/model/runner-status.ts` | 2 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | 2 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-tool-port.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-methods.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts` | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-session-query.ts` | 1 | 0 |
| `apps/zcode-cli/packages/cli/src/command-center/types.ts` | 1 | 0 |
| `apps/zcode-cli/packages/cli/src/prompt-command.ts` | 2 | 1 |
| `apps/zcode-cli/packages/cli/src/run.ts` | 1 | 0 |
| `apps/zcode-cli/packages/core/src/browser-client/manifest.ts` | 1 | 0 |
| `apps/zcode-cli/packages/core/src/hooks/runner.ts` | 1 | 0 |
| **合计** | **31** | **11** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **20** | **15** | **0** | 1,448 → 1,433 | 1,352 | **81** | `1,448 − 15 + 0 = 1,433` ✔（清理侧，独立）；`1,352 + 81 = 1,433`（**定义恒等，非校验**） |

- 表内 1,520 = ACTIVE 1,352 + CLEARED 168。
- **表外差集：新增 0 / 移除 3**（名单落盘 [`ZC-deep-b391-outside-diff.tsv`](ZC-deep-b391-outside-diff.tsv)）：
  `node-execution-adapter-results.ts`、`workflow-methods.ts`、`hooks/runner.ts`——三文件最后一行 weak 被清，整体退出表外集合。
- **交叉核对（两套独立记录）**：全仓清零 `15 = 表内 12 + 表外 3`，与表外差集移除的 3 个文件逐一对应；
  单条恒等式之外多了一条独立验算。
- AUTO-SELF-CLEAR 本批 **0** 条。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=8575456a files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=35 auto_self_clear=0
gate: PASS order n=0 total=106.0s controllable=106.0s
GATE ALL PASS batch=b391 sha=8575456a
```

```
[1c allowed] plan=20 + selfclear_rows=15 + auto=0 → allowed=35
[1b 校验] batch=b391 pre=b390 weak=d:/code/_annot_baseline/b391-repo-post.txt weak_rows=3415 plan=20 head_added=20
```

- 20 文件下 `scope` 的 `diff_old/diff_new` 仍是 `20/20`，`record` 仍 `n=0`：文件数翻倍没有引入路径或快照错位。

## 3. 进度

- 全仓 weak：**3,435 → 3,415**（−20）；weak 文件 **1,448 → 1,433**。
- 池内：**179 行 / 179 文件**（`7,242 + 179 = 7,421`、`828 + 179 = 1,007`、`ALIGNED OK`）。
- **行侧 97.6%**（7,242 ÷ 7,421）；文件侧 `828 ÷ 1,007 = 82.2%`（辅助）。
- **残留两列**：池内可写 **179** / 池外残留 **3,236**（`3,415 − 179`）。
- 剩余批数（cap 20）：**9 批**（179 ÷ 20 上取整）。形状：`179 文件 × 1 行 = 179 行`。

## 4. 计时（一位小数；`S3a + S3b` 分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `9e8cae3e`（18:34:33） | `8575456a`（18:36:19） | 106.0 |
| `controllable` | `--start`（18:34:33.9） | 批次提交（18:36:19） | **105.1 ± 0.5**（闸报 106.0） |
| **S0** 提交 → closeout | 18:36:19 | 18:36:26.8 | **7.8** |
| **S1** 扫描 + 1b/1c | — | — | **7.2** |
| **S2** rewrite.tsv + own-commits + capacity | — | — | **1.3**（0.0 + 0.2 + 1.1） |
| **S3a** 台账（稳态） | 18:36:35.2 | 18:37:26 | **50.8** |
| **S3b** CLOSING + INDEX 填数（文档） | 18:37:26 | 18:39:07 | **101.0** |
| **S4** 提交 | 18:39:07 | 18:39:08 | **1.0** |
| **收口 S0–S4（分段和）** | 18:36:19 | 18:39:08 | **169.1**（7.8 + 7.2 + 1.3 + 50.8 + 101.0 + 1.0） |
| **批墙钟（实测端点）** | 18:34:33.9 | 18:39:08 | **274.1** |

- `controllable 105.1s` + 收口 `169.1s` = **274.2s**，实测墙钟 **274.1s**，差 `0.1s`：
  `S0` 与 `S4` 由整秒 `git` 时间戳推导，各带 `±0.5s`，合计区间 `274.1–274.2s`，实测值落在区间内；
  不做「凑等式」的反向调数。
- `controllable 105.1s` vs 模型 `61.4 + 20 × 3.45 = 130.4s`：**0.81×**，低于模型 `19%`。
  cap 从 10 翻到 20、行数仍 20，起草段没有变贵；返修 **1 轮**（lint 批量拦 7 条后一次改完）+ 1 次 `apply`。
- `total ≈ controllable`：`--start` 与上一提交（`9e8cae3e`，形状文档）几乎同秒，两者差值不足以分开读。

## 5. 点估计（主报）

```
[窗口锚点] b391（anchor=batch）
[成本口径] 主报与包络同用「含文档全成本」；窗口缺 S3b 打点：b388
[窗口] b391 / b390 / b388（b389 标事故，中位与包络同时剔除）
[窗口滚动] 滚入 b391（274.1s）；滚出 b387（165s）
[点估计] 0.71h = 9批（cap 20） × 61.4 + 179行 × 3.45 + 9批 × 155s（含文档全成本收口中位 b390 136.3 / b388 155 / b391 169.1）→ 2565.2s  ← 主报
[点估计] 0.75h（收口维持 b391 的 169.1s）→ 2692.1s  ← 收口是唯一剩余杠杆
[点估计] 0.67h（收口回到窗口最低 b390 的 136.3s）→ 2396.9s
[预测区间] 0.52–0.85h（点估计 ×0.73 / ×1.19；实测比值 b388 1.19 / b389 0.73 / b390 0.874）
[观测包络] 0.63–0.77h（含文档全成本：同窗口 min 250.3s / max 309.4s；参考，不进主报）
```

- 本批采用 **cap 20**，`batches = ceil(179 / 20) = 9`；剩余收口次数从 18 降到 9。
- **主报 `0.71h`**（A 中位 `155s`）；收口维持 `169.1s` 则 `0.75h`，回到 `136.3s` 则 `0.67h`。
- **S3b `101.0s` 偏高**：其中约 40–50s 是 4 次多行 `Edit` 在 CRLF 文件上匹配失败后的重试（见 §7），
  不是文档填数本身的稳态成本。
- b394 回标：`TOOL_TRIP: 45.0`（40–50 取中值），**从收口与墙钟扣除**（原「A 口径按端点如实计入，不扣」作废）；
  净收口 `169.1 − 45.0 = 124.1s`。即便往返取 50s（净 `119.1s`）也改变不了本窗口中位（由 b392 的 `244.0s` 决定）。
- **窗口滚动**：滚入 `b391`（274.1s）、滚出 `b387`（165s）；包络下沿 `0.60h → 0.63h`（9 批）。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `8575456a` | `+20/−20` |
| rewrite.tsv + outside-diff + 本台账 + CLOSING/INDEX 填数 + 白名单 713 行 | `a18270dd` | — |
