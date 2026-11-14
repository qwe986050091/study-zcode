# ZC-deep-b390

> 批次：b390 ｜ **20 行 / 10 文件** ｜ 提交 `e29e6b3f`

## 0. 普通批；`fix=0`；**判据类 0 / 格式类 0 / lint 8**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | 8 | 8 行逗号 / 顿号 ≥2 被判否（`WindowsCaptionMenuButton:88/224`、`webAuthService:113`、`webRemoteControlTransport:429`、`contracts/transport:106`、`cli.ts:147`、`stageCli:41/87`），拆成 1 个分隔符后一次过 |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 0 | `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

- **判据类 0 的抓取步骤**：`precheck` 0 + `judge` `hits=0` + 六闸 `判据=0` + 全仓扫描 0 残留。
  lint 的 8 条属**落笔前**拦截，不计入 `hit_rate` 分子（INDEX §6.2-16 拆分口径）。

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/WebRemoteControlMobileShell.tsx` | 2 | 0 |
| `packages/ui/src/WelcomeScreen.tsx` | 2 | 0 |
| `packages/ui/src/WindowsCaptionMenuButton.tsx` | 2 | 0 |
| `packages/ui/src/WorkspaceHeader.tsx` | 5 | 2 |
| `packages/web/src/auth/webAuthService.ts` | 2 | 0 |
| `packages/web/src/web-remote-control/adapters/webRemoteControlTransport.ts` | 2 | 0 |
| `packages/web/src/web-remote-control/contracts/transport.ts` | 2 | 0 |
| `packages/zcode-server-cli/src/cli.ts` | 3 | 1 |
| `packages/zcode-server-cli/src/packaging/stageCli.ts` | 2 | 0 |
| `packages/zcode-server-cli/src/runtime/updateHandoff.ts` | 2 | 0 |
| **合计** | **24** | **3** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **10** | **8** | **0** | 1,456 → 1,448 | 1,364 | **84** | `1,456 − 8 + 0 = 1,448` ✔；`1,364 + 84 = 1,448`（**定义恒等，非校验**） |

- 2 个文件留池外上游残留：`WorkspaceHeader` 2 行（含 JSDoc 块的 `:44`，blame `3c5b2276`）、`cli.ts` 1 行（`:454`，blame `872ad960`）。
- **表外差集**：`b389 → b390` 新增 **0** / 移除 **0**，名单落盘
  [`ZC-deep-b390-outside-diff.tsv`](ZC-deep-b390-outside-diff.tsv)（空表）。
- 表内 1,520 = ACTIVE 1,364 + CLEARED 156。
- **AUTO-SELF-CLEAR 1 条**：`WorkspaceHeader.tsx:46`（块尾 `*/`，邻接自清，blame `3c5b2276` 属上游、池外），已自动登记，不进 `done/remain`。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=e29e6b3f files=10/10 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=21 added=0 allowed=35 auto_self_clear=1
gate: PASS order n=0 total=367.0s controllable=114.0s
GATE ALL PASS batch=b390 sha=e29e6b3f
```

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=1 → allowed=35
[1b 校验] batch=b390 pre=b389 weak=d:/code/_annot_baseline/b390-repo-post.txt weak_rows=3435 plan=20 head_added=20
```

## 3. 进度

- 全仓 weak：**3,456 → 3,435**（−21 = 20 条计划行 + 1 条邻接自清）；weak 文件 **1,456 → 1,448**。
- 池内：**199 行 / 199 文件**（`7,222 + 199 = 7,421`、`808 + 199 = 1,007`、`ALIGNED OK`）。
- **行侧进度 97.3%**（7,222 ÷ 7,421）；文件侧 `808 ÷ 1,007 = 80.2%`（辅助）。
- **残留两列**：池内可写 **199 行** / 池外残留 **3,236 行**（`3,435 − 199`）。
- 剩余批数（cap 10）：**20 批**（199 ÷ 10）。形状：`199 ÷ 20 ≈ 10.0 行/批`、`199 ÷ 20 ≈ 10 文件/批`。
- **剩余形状（已确认，b391 前置核对）**：**199 个文件 × 恰好 1 行 = 199 行**，即「一文件一行」。
  推导：b389 末为 209 文件 / 219 行，其中 199 个文件各 1 行、10 个文件各 2 行（`199×1 + 10×2 = 219`）；
  b390 清掉的 10 个文件正是这 10 个两行文件（20 行）。故剩余全为单行文件，`每批 10 文件 = 10 行`。

## 4. 计时（一位小数；`S3a + S3b` 分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `72e9210a` | `e29e6b3f`（18:15:00） | 367.0 |
| `controllable` | `--start`（18:13:06.7） | 批次提交（18:15:00） | **114.0 ± 0.5** |
| **S0** 提交 → closeout | 18:15:00 | 18:15:08.7 | **8.7** |
| **S1** 扫描 + 1b/1c | — | — | **7.3** |
| **S2** rewrite.tsv + own-commits + capacity | — | — | **1.3**（0.0 + 0.2 + 1.1） |
| **S3a** 台账（稳态） | 18:15:18 | 18:16:05 | **47.0** |
| **S3b** CLOSING + INDEX 填数（文档） | 18:16:05 | 18:17:01 | **56.0** |
| **S4** 提交 | 18:17:01 | 18:17:17 | **16.0**（含一次 `git add` 路径写错的重跑） |
| **收口 S0–S4（分段和）** | 18:15:00 | 18:17:17 | **136.3**（8.7 + 7.3 + 1.3 + 47.0 + 56.0 + 16.0） |
| **批墙钟（实测端点）** | 18:13:06.7 | 18:17:17 | **250.3** |

- `controllable` 与模型 `61.4 + 20 × 3.45 = 130.4s` 对比：本批 `114.0s`，**低于模型 12.6%**（b388 `+18.9%`、b389 `−27%`）。
  返修轮次：本批 **1 轮**（lint 批量拦 8 条后一次改完）+ 1 次 `apply`，少于 b388 的 3 轮 / b389 的 2 轮。
- **S0 = 8.7s 高于窗口内其它批（1.3–3.0s）**：提交后我先把 `git log` / 文件 mtime 采集了一轮再启动 `closeout`，
  这段是工具调用间隔，不是 closeout 自身开销（其内部首步扫描仍为 7.3s）。按端点口径如实计入，不扣。
- **S1/S2 与窗口一致**（7.3 + 1.3）；`closeout` 自报总耗时 9s。

## 5. 点估计（主报）

```
[窗口锚点] b390（本批台账已落盘）
[成本口径] 主报与包络同用「含文档全成本」；窗口缺 S3b 打点：b388 / b387
[窗口] b390 / b388 / b387（b389 标事故，中位与包络同时剔除）
[窗口滚动] 滚入 b390（250.3s）；滚出 b386（152s）
[点估计] 1.29h = 20批 × 61.4 + 199行 × 3.45 + 20批 × 136.3s（含文档全成本收口中位 b387 65 / b390 136.3 / b388 155）→ 4640.6s  ← 主报
[点估计] 1.29h（收口维持 b390 的 136.3s）→ 4640.6s  ← 收口是唯一剩余杠杆
[点估计] 0.89h（收口回到窗口最低 b387 的 65s）→ 3214.6s
[预测区间] 0.94–1.53h（点估计 ×0.73 / ×1.19；实测比值 b388 1.19 / b389 0.73 / b390 0.874）
[观测包络] 0.92–1.72h（含文档全成本：同窗口 min 165s / max 309.4s；参考，不进主报）
[表外差集] 新增 0 / 移除 0（b389 → b390）
```

- **主报 = `1.29h`**：A 含文档全成本，收口中位 `136.3s`（b390）/ `155s`（b388）/ `65s`（b387）。
  `S3b` 是每批都发生的文档填数，按 A 口径计入；不再用「65 + 56」拆分。
- **窗口滚动（订正）**：滚入 `b390`（250.3s）、滚出 `b386`（152s）；下沿 `152 → 165s`，
  包络由 `0.84–1.72h` 改为 **`0.92–1.72h`**（20 批）。
- **预测区间 `0.94–1.53h`**：系数直接取三次外推的**实测比值** `b388 1.19 / b389 0.73 / b390 0.874`，
  取极值 `×0.73 / ×1.19`；`4640.55 × 1.19 ÷ 3600 = 1.534 → 1.53h`（按点位 `1.29 × 1.19` 算会得 `1.54`，
  差在先把主报四舍五入到 `1.29`；统一用秒数算，不乘取整后的小时数）。
  **4.2% 是四点拟合的 in-sample 残差，不是预测误差**。
  原报 `×0.8 / ×1.25 = 1.03–1.61h` **作废**：下沿没包住 `−27%`，上沿又多留余量，且系数与实测比值无关。
- **作废留痕（b391 前置订正）**：
  - 原报「窗口未滚动 / 主报 0.89h / 下沿 0.84h」**作废**。`closeout.mjs` 的窗口锚在 `--pre` 而不是本批，
    b389 恰是事故批被跳过，才让 b390 的旧窗口看起来正确；这是 off-by-one，不是规则。
    已改为**显式锚点** `--anchor=batch|pre`（不给就报错，脚本不按台账文件是否存在去猜），
    并用 `--report-only --anchor=batch` 在台账写完后重算。
  - 「`20 × (65 + 56)` = 1.20h」**不入账**：`65` 本身已是 A 口径收口（b388 的 `155` 已含 ~75s 文档），
    再加 `56` 属重复计入；单一口径下 A 中位是 `136.3`，对应 `1.29h`。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `e29e6b3f` | `+20/−20` |
| rewrite.tsv + outside-diff + 本台账 + CLOSING/INDEX 填数 + 白名单 706 行 | `5fdf397f` | — |
