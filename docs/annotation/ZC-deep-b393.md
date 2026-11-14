# ZC 深度注释 · b393 台账（cap 20 试验第 3 批）

> 提交：`7f8e4c7c`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b392-repo-post.txt`；批后快照：`b393-repo-post.txt`
> 口径：`CLOSING.md` §5 / `_tools/INDEX.md` §5.3 与 §6.2

## 0. 三列

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset-assert` missing=0 extra=0） | **首轮 10 → 修后 0** |

- lint 首轮 **10 条 BAD（按文件计：分隔符 ≥2 共 4、禁用词「此」「该」共 2、无锚点共 5，1 个文件同时命中两类）**；
  修法只有三种：分隔符换分号、禁用词同义替换、补常量名/方法名作锚点，改后一次过，无脚本往返。

## 0.1 cap 20 第三批：首轮全绿

| 判据 | 阈值/公式 | b391 | b392 | b393 |
| --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | 0 | **3**（登记后 0） | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 20 = 20 | 23 − 3 = 20 | **20 − 0 = 20** |
| `controllable` | **≤ 177.0s** | 105.1 | 150.0 | **118.0** |

- **阈值改法（b394，答 ③）：`195.6s` 作废。** 它 `= 1.5 × (61.4 + 20 × 3.45)`，而 `61.4` 是 cap 10 四点的截距——
  cap 20 每批文件翻倍，若 `c_f` 不为 0（上界 `1.3s/文件`），20 文件本就该比 10 文件多约 26s，用该模型给自己设阈值是自证。
- **新阈值 = `1.5 × 窗口内 controllable 中位` = `1.5 × 118.0 = 177.0s`**，每批随窗口重算：
  只用实测值，与 cap、与 `61.4 / 3.45` 无关；`1.5` 沿用旧系数，含义仍是「返修余量」。b393 `118.0 ≤ 177.0` ✔。
  未选「用 20 文件批重估 `a`」：三批同形状（20 文件 / 20 行），`a` 与 `c_f` 无法分离，重估会得到一族解。
- **首轮干净率 2/3**：b391 干净、b392 首轮 3 条未登记、b393 干净。cap 20 的**净收益为正**（8 批 vs 16 批，约省 `0.38h`），
  但**判据稳定性偏低**——三批里只有两批首轮通过。
- **因此本批不写「cap 20 立住」**，写「净收益为正、首轮干净率 2/3」；b394 继续记录首轮 `n`，连续两批首轮 `n=0` 才改口径。
- 本批 `allowed = 20 计划 + 18 已登记 + 0 自动 = 38`（`selfclear_batch=0`：本批没有邻接自清行）。

## 1. 逐文件（批前 weak → 批后 weak，合计 20 → 0）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/desktop/scripts/mcp-apps-host-fixture/agent.ts` | 1 | 0 |
| `packages/desktop/scripts/mcp-apps-host-fixture/chain-combinations.ts` | 1 | 0 |
| `packages/desktop/scripts/mcp-apps-host-fixture/widget.tsx` | 1 | 0 |
| `packages/desktop/src/renderer/src/desktopPlatform.ts` | 1 | 0 |
| `packages/desktop/src/renderer/src/main.tsx` | 1 | 0 |
| `packages/desktop/src/renderer/src/plugin-sandbox/relay.ts` | 1 | 0 |
| `packages/e2e-report/src/viewer/ChartPanels.tsx` | 1 | 0 |
| `packages/formal-proof/src/model.ts` | 1 | 0 |
| `packages/model-option-map/src/parser.ts` | 1 | 0 |
| `packages/provider/src/config/provider-data-schema.ts` | 1 | 0 |
| `packages/rpc/src/channelClient.ts` | 1 | 0 |
| `packages/rpc/src/channelServer.ts` | 1 | 0 |
| `packages/server/src/http.ts` | 1 | 0 |
| `packages/server/src/remote/remoteAssetCache.ts` | 1 | 0 |
| `packages/server/src/remote/zcodeAgentDeploy.ts` | 1 | 0 |
| `packages/services/src/bigmodel/codingPlanEntitlement.ts` | 1 | 0 |
| `packages/services/src/bots/bots.ts` | 1 | 0 |
| `packages/services/src/bots/channelMentionResolver.ts` | 1 | 0 |
| `packages/services/src/bots/groupAdminAttention.ts` | 1 | 0 |
| `packages/services/src/bots/messages.ts` | 1 | 0 |

固定对账三列（含清零口径拆分）：

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **20** | **20** | **0** | **0** |

- **交叉核对**：`全仓清零 20 = 表内 +7 + 表外 −13`。`CLEARED 177 → 184`（+7），表外 `76 → 63`（−13）。
- **表外差集**（`ZC-deep-b393-outside-diff.tsv`，`dir/path/cause` 三列）：新增 **0** / 移除 **13**，13 行 `cause` 全为 `annotation`（按行号判，非文件级）。
- **池外残留本批不动**：`3,233 → 3,233`，因为本批没有「无计划行的块尾 `*/` 位移」。

## 2. 六闸原文（同一次跑，无二段）

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=7f8e4c7c files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 total=1748.0s controllable=118.0s
GATE ALL PASS batch=b393 sha=7f8e4c7c
```

- 收口侧判据：`[cap 判据] removed=20 − selfclear_batch=0 = 20，plan.tsv=20 → OK`。
- `total=1748.0s` 是「上一提交 → 本提交」，含批间动作，不当成本用。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **139**（done 7,282 / 7,421 = **98.1%**） |
| 池内文件 | **139**（done 868 / 1,007 = 86.2%），辅助 |
| 全仓 weak | **3,372 行** |
| 池外残留 | **3,233 行**（3,372 − 139，本批未动） |
| 集合 | `1,399 = ACTIVE 1,336 + 表外 63`（**定义恒等，非校验**） |
| 表内 | `1,520 = ACTIVE 1,336 + CLEARED 184`（**定义恒等，非校验**） |

- `ALIGNED OK`：`acct_remain 139 == pool_remain 139`。
- 剩余形状 **139 文件 × 1 行**，cap 20 下 `ceil(139 / 20) = 7` 批。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `cf77a870` 之后批间 | `7f8e4c7c`（19:39:06） | 1748.0 |
| `controllable` | `--start`（19:37:08.2） | 批次提交（19:39:06） | **118.0 ± 0.5** |
| **S0** 收口准备 | 19:39:06 | 19:39:29.1 | **23.1**（`closeout` 自报 扫描 7.5 + own-commits 0.2 + capacity 1.2 + 其他 14.2） |
| **S1** 失败诊断 | — | — | **0.0**（首轮六闸全绿，无诊断） |
| **S2** 人工登记 + 第二段六闸 | — | — | **0.0**（`selfclear_batch=0`，无登记；未跑二段） |
| **S3a** 台账与快照 | 19:39:29.1 | 19:40:07.7 | **38.6** |
| **S3b** CLOSING + INDEX 填数 + 计时回填（文档） | 19:40:07.7 | 19:44:01.5 | **233.8** |
| **S4** 提交 | 19:44:01.5 | 19:44:13.0 | **11.5** |
| **收口 S0–S4（分段和）** | 19:39:06 | 19:44:13.0 | **307.0**（23.1 + 0 + 0 + 38.6 + 233.8 + 11.5） |
| **批墙钟（实测端点）** | 19:37:08.2 | 19:44:13.0 | **424.8** |
| **S5** 回填（§4/§5/CLOSING/INDEX 修正 + 回填提交 `ba39c654`） | 19:44:13.0 | 19:46:53 | **160.0**（**收口外**，不参与中位，单独记账） |

TOOL_TRIP: 20.0（`S3b` 内：文档提交后白名单失效 → `WHITELIST STALE` 报错 → 重建 `OWN-COMMITS` → 重跑 `--report-only`；S3b `233.8` 里约 `213.8` 是真实填数）
- b394 回标：净收口 `307.0 − 20.0 = 287.0s`，净墙钟 `424.8 − 20.0 = 404.8s`。
- `S5 160.0s` 的位置：既不在 `收口`（它在主报定稿之后），也不在 `controllable`（`controllable` 止于代码提交 `7f8e4c7c`）。
  从 b394 起固定记 `S5`，并在批报里单列；**主报不含它**，7 批合计约 `7 × 160 = 1,120s ≈ 0.31h` 是主报的系统性低估项（已写入 CLOSING §5.5）。

## 5. 主报

- 剩余 139 行 / 139 文件 → cap 20 下 `ceil(139 / 20) = 7` 批。
- 窗口 `b393 / b392 / b391`，净收口 `287.0 / 244.0 / 124.1`，中位 **`244.0s`**。
- **主报 `0.73h`**：`7 × 61.4 + 139 × 3.45 + 7 × 244.0 = 429.8 + 479.55 + 1708.0 = 2617.35s`；区间 `0.53–0.87h`（`×0.73 / ×1.19`）。
- 参考档（不进主报）：收口维持 `287.0s` → `0.81h`；回到窗口最低 `124.1s` → `0.49h`；
  观测包络 `0.45–0.79h`（净墙钟 `229.1 / 393.1 / 404.8`）；cap 10 退路 `1.03h`（14 批）。
- **旧数留痕**：`0.85h / 0.62–1.01h / 包络 0.53–0.98h` 是「S3b 未拆工具往返」的读法，**作废**（原因见 §0.1 阈值与 §4 `TOOL_TRIP`）。
- **本批口径变更 3 条**：① 表外差集 `cause` 降到行级并新增 `mixed`；② 全量 `closeout` 固定排在文档提交前（选 (a)，不加 `--scope`）；③ `S4` 定义为第一次文档提交，回填提交不计入收口。
- `S3b = 233.8s`，高于 b392 的 `145.5s`——**不是因为口径条数（本批 3 条 vs b392 十数条），而是文档提交后白名单失效重跑 + 两轮 `--report-only` 的往返**。
  这推翻「S3b 主变量是口径条数」的单因子解释：**工具往返轮次**同样是主变量。`S3b` 已计入 A 口径，不改主报口径。

## 5.5 收口顺序（b393 起强制，替代记性）

```
 1  node gate-run.mjs --batch bXXX --start
 2  node pick-generic.mjs bXXX files.txt <pre>-repo-post.txt
 3  落笔 + plan-new / sentence-precheck / diffset-assert / judge
 4  node gate-run.mjs --batch bXXX --subject "…"                       ← 代码提交，记 controllable 终点
 5  node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
 6  node closeout.mjs bXXX --pre bYYY --cap 20 --anchor=pre --cost=A     ← 唯一一次全量，产出 outside-diff（含 cause）；必须在第 9 步之前
 7  写台账 ZC-deep-bXXX.md（S0–S3b 用时间戳）
 8  填 CLOSING/INDEX（数据行）
 9  git commit 文档                                                      ← 记为 S4，收口截止点
10  node own-commits-gen.mjs d:/code/ZCode                               ← 文档提交后白名单必失效，必须重建
11  node closeout.mjs bXXX --pre bYYY --cap 20 --report-only --anchor=batch --cost=A
12 回填台账 §4（S4/合计/批墙钟）、§5 主报、CLOSING §0/§5、INDEX 主报
13  git commit 文档（回填）                                              ← 记 S5（收口外）；**此后禁止再跑全量 closeout**
```

- 第 6 步必须在第 9 步之前：全量 `closeout` 校验 `HEAD 新增行 == plan`，文档提交会把新增行抬高（b392 是 59），只能旁路。
  本批选 (a)「顺序固定」，**没有**加 `--scope=src|all`：差集与 `cause` 本来只统计源码路径，加开关会让「全量」出现两种语义。
- 第 10 步不能省：`capacity-estimate` 校验 `OWN-COMMITS.meta.head == HEAD`，文档提交后直接 `WHITELIST STALE` 退出（b393 实测）。
- 第 12 步的 `S4` 只能在第 9 步之后才知道，所以主报必然落在回填提交里；第 13 步**只改文档**，不影响任何判据。
- b392 的差集列曾用旁路脚本补 `cause`；本批起由第 6 步直接产出，不再有旁路。
