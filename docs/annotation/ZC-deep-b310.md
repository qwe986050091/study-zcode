# ZC-deep-b310

> 批次：b310 ｜ 36 行 / 4 文件 ｜ 提交 `43feb7ca`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本轮前置：§12.3「两个口径回答两个问题」落盘（`b33041fa`）

- 写进 `_tools/INDEX.md` §12.3，作为 b310 起对外报数的**唯一允许方式**：
  - **句子级口径**回答「这块代码有没有解释」→ 注释的语义单位是句子，这是**工程完成度**的主口径。
  - **逐行口径**回答「每一行是否自足」→ 自足性指标，**并列展示**，不是完成度的另一个说法。
  - 两个都要给，且每次写明哪个是工程完成度；禁止单拿 50.7% 说「才做了一半」，
    也禁止单拿 64.8% 说「快做完了」而不带自足性。
- 同节记录理由：那 1,046 行绝大多数是**同一句话的续行、锚点在前半句**（b309 抽读 10/10 均为此形态），
  单独判弱是**度量口径**造成的，不是内容缺失；但「续行不自足」确实是事实，所以逐行口径不能丢。

## 1. 选行

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts` | 11 | 0 | 11 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` | 11 | 0 | 11 | 0 |
| `apps/zcode-cli/packages/cli/src/commands-command.ts` | 11 | 1 | 11 | 0 |
| `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts` | 3 | 0 | 3 | 0 |
| **合计** | **36** | **1** | **36** | **0** |

- 候选池已无 12 行文件，改用 3×11 + 1×3 凑满 36。
- `commands-command.ts:279` 是池外 own 行，**未改**，但本批收尾时从 weak 集合消失，
  按规则登记到 `POOL-SELF-CLEAR.tsv`（见 §5），不占配额。

## 2. 改动内容

- `embedded-search-prelude.ts`：4 组（便捷入口、函数体生成、backend 分派、注入脚本）。
  补锚点：`buildEmbeddedSearchPreludeContent`、`prelude.kind`、`shellDialect`、
  `BFS_DEFAULT_ARGS`、`command -v backendCommand`。
  订正一处事实：`findAndGrepEnabled === false` 时 `content` 为空数组、`join` 得到**空串**
  （不是 `undefined`），原句「四个函数都不生成」之外没有说明返回值形态。
  另一处订正：`internal-cli` 分支**不带** `BFS_DEFAULT_ARGS`，只有 `argv0-dispatch` 带。
- `runtime-config.ts`：4 组（接口三字段、主收集函数、日志投影）。
  三字段写成 `configuredMcpServers` / `runtimeConfig` / `untrustedProjectMcpServers`；
  日志投影写明实际输出「开关布尔 + mode/model + memoryRoot + workingDirectory」，
  订正原句「只输出布尔与计数」——它漏了字符串与路径字段。
- `commands-command.ts`：4 组（list/inspect 惰性解析、metadata 投影、JSON 输出）。
  惰性解析写明解析函数名；`--verbose` 与 `Content` 段对齐；
  投影写明「稳定字段逐个列出、不用 spread」与「条件展开的键缺失时整键不出现」。
- `edit.ts`：2 组（stat 的信号透传、diff 矩阵两处）。
  写明 `context.abortSignal` 与取消语义；补「外层遍历左串 + 第二个内层循环回写」；
  三个候选写成「删除 `current[j-1]+1`；插入 `previous[j]+1`；替换 `previous[j-1]+cost`」，
  并订正原句「整行压回上一行」——实际是逐格回写（见 615 行既有注释）。

## 3. 门禁读数（十一闸）

```text
gate: PASS start     n=0 t-start=2026-11-11T07:55:56.432Z
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=43feb7ca files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=37 added=0 allowed=38
gate: PASS order     n=0 total=136.0s controllable=40.0s
```

- **`pool-diff` 首跑判红**：`removed=37 / allowed=37`，多出的 1 行是未登记自清
  `commands-command.ts:279`。该行是池外 own 行、本批**没碰**，消失原因是邻接改写（见 §5）。
  登记后 `--from pool-diff --sha 43feb7ca` 补跑 → `removed=37 added=0 allowed=38` PASS。
  **commit 在首跑时已落盘**（`43feb7ca`），补跑只重验后两道闸，未重提交。
- **`order` 的重跑读数失真**：补跑时 `prev` 默认取 HEAD，恰好就是本批提交，
  所以 `total=0.0s`。真实墙钟为上一提交 `ef382fd6`（15:54:20）→ `43feb7ca`（15:56:36）= **136.0s**；
  `controllable=40.0s`（`t-start 07:55:56.432Z` → commit `07:56:36Z`），`s/行 = 40.0 / 36 ≈ 1.11`。

## 4. 首轮命中与返修

- 首轮预判据 **1 / 36 = 2.8%**：`embedded-search-prelude.ts:152`
  「每个分支末尾都带 `"$@"`」——`"$@"` 不构成标识符（`$` 开头），判 `W/单行无信息`；
  改为「把 bash 位置参数原样透传给后端」后 `hits=0`。
- 在 `--record` 之前用 Edit 直改，所以 `record_runs=1`、`write_phase 1 / record_phase 0`。

## 5. 自清（本批首次出现非 b307 条目）

`pool-diff` 首跑 `removed=37` 中，36 行是本批登记行，第 37 行是
**`apps/zcode-cli/packages/cli/src/commands-command.ts:279`（blame `10e9df51`，池外 own）**。

- 该行本批未改，但它与 278 行同属一个短句堆叠组；280–282 由无锚点碎片句改成带标识符的整句后，
  整组不再成立，279 自身转强。
- 已按规则写入 `POOL-SELF-CLEAR.tsv`（`b310` / `10e9df51` / `out-of-pool`），
  `capacity-estimate` 回读 `SELF-CLEAR n=1 可写桶 0 / 池外 1 / 上游桶 0`，**不扣配额**。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b309 5,860` → `post-b310 5,823`（**−37** = 36 批内 + 1 自清），
  文件 `1,823 → 1,819`（−4）。
- **句子级口径（工程完成度）**：`done 4,847 / remain 2,574`，`4,847 + 2,574 = 7,421`，**65.3%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,574 + 1,046 = 3,620`，
  `done ≈ 3,801 / 7,421`，**约 51.2%**。
  两个数回答不同问题，不可互相替代。
- 池外：`5,823 − 2,574 = 3,249` 行，**永久不排期**，只作外部观测。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b310`：`done files=341 (+4) / lines=4,847 (+36)`，
  `REMAIN 666 files / 2,574 lines`，`ALIGNED acct_remain=2574 pool_remain=2574 diff=0`，分档合计 335 批。
- `SELF-CLEAR n=1`（`commands-command.ts:279`，out-of-pool）。
- `ledger-assert`：`ACCT files 341 + 666 = 1007`、`ACCT lines 4,847 + 2,574 = 7,421` → **PASS**。
- 白名单重跑到 `43feb7ca`，**368 行**。

## 8. 复算命令

```powershell
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b310-repo-post.txt
node _annot_baseline/pick-generic.mjs b310 _annot_baseline/b310-files.txt _annot_baseline/b309-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b310 --start
node _annot_baseline/apply-run.mjs b310
node _annot_baseline/judge-generic.mjs b310
node _annot_baseline/gate-run.mjs --batch b310 --subject "注释清水 b310：4 文件 1→1 改写"
# 首跑 pool-diff 因未登记自清判红后：
node _annot_baseline/gate-run.mjs --batch b310 --from pool-diff --sha 43feb7ca --subject "注释清水 b310：4 文件 1→1 改写"
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| INDEX §12.3 两个口径回答两个问题 | `b33041fa` | 1 文件 |
| 白名单至 b33041fa（开批前） | `ef382fd6` | 2 文件 |
| b310 批次本体（4 文件 1→1 改写） | `43feb7ca` | `+36/−36` |
| `POOL-SELF-CLEAR.tsv` + 白名单 368 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,574≠0` 未到；A2 `4,847 + 2,574 = 7,421` 成立；A3 `ledger-assert PASS`。
- 后续：b311 起继续 36 行/批；约 b390 前后插 10 行 N/P 语义双读。
