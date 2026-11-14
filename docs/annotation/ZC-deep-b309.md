# ZC-deep-b309

> 批次：b309 ｜ 前置：批次外修订 6 处（`73632ef9`，不计入 done/remain）
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 批次外修订（不计入 done/remain）

- **来源**：跨仓全称断言审计，清单 `temp_20261109_01/quantifier-fix-ZCode.md`（6 条）。
  清单建议文案只作参考，逐条按代码实际核对后落笔。
- **规模**：6 文件 / 10 行，提交 `73632ef9`，`+10/−10`，零代码行。
  **这 10 行都不是批次新增行，不计入 `done/remain`，分母仍为 7,421 行。**
- **两棵 `packages` 树**：第 1–3 条在 `apps/zcode-cli/packages/`，第 4–6 条在根 `packages/`。
  清单与代码路径一致，无错置。

| # | 文件:行 | 原 | 现 |
| --- | --- | --- | --- |
| 1 | `apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts:19-20` | 不变量句后半「每次写入前清掉所有 alias」与 patch 路径混淆 | 「不变量…canonical 化。」+「patch 路径写前清掉所有 alias 键；`enablePluginsByDefaultInFileConfig` 按 id 合并，不清 alias。」 |
| 2 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-launch-anchor.ts:37-38` | 「全部内容」为全称断言，且第二行只剩 `providerId/modelId[...]` 片段 | 「记进 `run-launched` 的内容」+「（`subagentModel` 与 `subagentPermissionMode` 等字段见 RunLaunch 接口）。」 |
| 3 | `apps/zcode-cli/packages/core/src/workflow/scheduler/graph.ts:326-327` | 「有成员的集合都耗尽」漏掉 explorable 限定 | 「…explorable 且有成员的集合都耗尽，空集合与非 explorable 集合都不阻止本轮收尾。」 |
| 4 | `packages/services/src/cua-permission-broker/cuaPipSessionService.ts:3` | 「失败与跳过都记 warn」为全称断言，dispose 后跳过不记 | 「失败与带原因的跳过记 warn；dispose 后的投递直接返回、不记 warn。」 |
| 5 | `packages/ui/src/components/ai-elements/voice-selector.tsx:281-282` | 「以 string 收尾」与闭合联合的实际类型不符 | 「value 是闭合的字面量联合，不包含 string…不能回头加 `\| string` 求兼容。」 |
| 6 | `packages/ui/src/project-sidebar/index.tsx:99` | 「一次性解构全部字段」为全称断言，实际未解构 `projects` | 「一次性解构本组件需要的 Provider 字段（不含 projects）…」 |

- **清单与代码不符的一处**：清单建议写 `LaunchAnchor` 接口，仓内不存在该名；
  实际为 `RunLaunch`（`apps/zcode-cli/packages/bootstrap/src/app/run-launch.ts`），按代码写。
- **提交方式**：走 `zc-commit-v13` 默认模式，未带 `--rewrite-annot`。
  原因：第 2 条的 blame 是 `872ad960`，不在 `OWN-COMMITS.tsv`（只认作者 `zhanglingfeng`），
  会被判「删上游注释」整批拒绝；这 10 行本就是上游注释，默认模式（带 `--snapshot` 顺序断言）才是正确通道。
- **门禁读数**（十一闸，`gate-run` 同一 runner）：

```text
gate: PASS scope     n=0 plan=10 allow=0 diff_old=10 diff_new=10 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=2
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=2 verify_ok=true
gate: PASS commit    n=0 sha=73632ef9 files=6/6 numstat=10/10 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=0 added=0 allowed=11
gate: PASS order     n=0 total=41.0s controllable=38.8s
```

- 计时：`t-start 07:41:45.185Z` → `t-record 07:42:15.945Z` → `t-verify 07:42:17.446Z` → `commit 15:42:24+08:00`。

- **`record_runs=2` 返修原因**：首轮 `hits=1`，`launch-anchor.ts:38` 的新文案
  「`subagentModel` 与 `subagentPermissionMode` 等字段…」仍是「顿号列举 + 无谓词」，命中 `L/无信息列举`；
  改为带显式谓词（「…等字段见 RunLaunch 接口」）后 `hits=0`。
- **`POOL-DIFF`**：`removed=0 added=0`——这 10 行在改动前都不在弱集合内，
  改后也没有从 weak 消失的行，**无需 `POOL-SELF-CLEAR.tsv` 登记**。
- 口径限定：本节不产生任何 `done/remain` 变动；凡引用完成度处一律为
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 1. 选行

4 文件 / 36 行，全部 `ownIn`（池内），`ownOut=0`，不跨文件拼接半句。

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/web-share/src/main.tsx` | 12 | 0 | 12 | 0 |
| `packages/zcode-server-cli/src/runtime/releaseManager.ts` | 12 | 0 | 12 | 0 |
| `apps/zcode-cli/packages/adapters/src/browser/playwright-command.ts` | 11 | 0 | 11 | 0 |
| `apps/zcode-cli/packages/core/src/permission/service.ts` | 1 | 0 | 1 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

- `main.tsx` / `releaseManager.ts` / `playwright-command.ts` 是候选池前三名（12/12/11）；
  第四个文件取「池内恰好 1 行」的 `permission/service.ts` 补足 36，
  避免把 11 行文件再切一半跨批。四个文件本批后 weak 全为 0，直接退出弱文件名单。

## 2. 改动内容

- `main.tsx`：4 组句元（启动主题、OAuth 回调判定、返回地址解析、分享页渲染）。
  补上具体键名与函数名（`zcode-theme`、`window.location.pathname`、`resolveSafeAppReturnTo`、
  `invalid_contract`、`VITE_CONVERSATION_SHARE_PREVIEW_MOCK`），并把「模拟模式仅在开发态生效」
  改成实际条件「DEV 且开关为 true」。
- `releaseManager.ts`：4 组（Windows 重命名重试、原子写、类职责摘要、恢复与边界校验）。
  退避写成 `10 * attempt`，恢复写明由 `recoverInterruptedUpdate` 读事务里的 `previous` 指针，
  边界校验写明「Core 执行前」与「越界拒绝」。
- `playwright-command.ts`：4 组（超时归一、定位封装、修饰键映射、CDP 求值、方法分派兜底）。
  超时写明 `[1, 3000]` 夹取；求值写明 `returnByValue` 与 `exception.description ?? text`；
  分派写明「每个 case 一次调用、elapsedMs 由外层补」。
- `permission/service.ts:309`：唯一一行，保留 `[权衡]` 标记，
  把「不额外增加审计负担」这种无锚点断言换成「放行理由固定记为 `tool.webfetch.preapproved`，
  调用方仍能从返回的 decision 里读到来源」。

## 3. 门禁读数（十一闸）

```text
gate: PASS start     n=0 t-start=2026-11-11T07:46:28.925Z
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=ca38493e files=4/4 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=0 added=0 allowed=36
gate: PASS order     n=0 total=171.0s controllable=46.1s
```

- 计时：`t-start 07:46:28.925Z` → `t-record 07:46:55.066Z` → `t-verify 07:46:56.253Z` → `commit 15:47:15+08:00`。
  `s/行 = 46.1 / 36 ≈ 1.28`，`record_runs=1`。

## 4. 首轮命中与返修

- 首轮预判据 **3 / 36 = 8.3%**，三处都是 `W/单行无信息`（无标识符、无前置条件、无不变量锚点）：
  1. `releaseManager.ts:36`「退避间隔是 10ms 乘以第几次尝试」——`10ms` 不构成标识符（`ms` 只有 2 字符），
     改为「由 `setTimeout` 设为 `10 * attempt` 毫秒」。
  2. `releaseManager.ts:80`「中断恢复优先恢复到事务里的旧指针」——整句无 ASCII 锚点，
     改为以 `recoverInterruptedUpdate` 与 `previous` 开头。
  3. `playwright-command.ts:181`「页面级求值与下载由独立工具承担」——无锚点，
     改为「两个动作在 locator 层没有对应 API，抛错让调用方改用页面级工具」。
- 三处都在 `--record` 之前用 Edit 直接改掉，所以 `record_runs=1`、`write_phase 3 / record_phase 0`。

## 5. 自清

`pool-diff removed=0 added=0 allowed=36`：36 行都在 `allowed`（本批登记）里，
**没有未登记消失，也没有 weak 新增**。`POOL-SELF-CLEAR.tsv` 未新增，仍只有
`workspaceConnectionRegistry.ts:184` 那一条（b307 遗留）。

## 6. 池外对账（口径限定）

- 全仓（句子级）weak：`post-b308 5,896` → `post-b309 5,860`（**−36**），文件 `1,827 → 1,823`（−4）。
  快照同域：`--root packages,apps,docs/knip`，`comments=329,700`、`units=1,265,605` 与 §12.1 一致。
- 池内：`done 4,811 / remain 2,610`，`done + remain = 7,421`；
  完成度 **64.8%**——**句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期**。
  若按逐行口径，`remain` 约为 `2,610 + 1,046 = 3,656`，完成度约 50.7%，两者不可混用。
- 池外：`5,860 − 2,610 = 3,250` 行，仍**永久不排期**，只作外部观测。

## 7. 守卫与产能

- `GUARD` 15 文件（`b254-802-files.txt`）：`pre=4 post=4 新增=0 max=8` → PASS。
  本批未碰这 15 个文件（`git show --numstat ca38493e` 仅 4 个文件），pre/post 同源扫描，读数相等是结构性结果。
- `capacity-estimate.mjs --batch b309`：`done files=337 (+4) / lines=4,811 (+36)`，
  `REMAIN 670 files / 2,610 lines`，`ALIGNED acct_remain=2610 pool_remain=2610 diff=0`，分档合计 336 批。
- `ledger-assert.mjs`：`PASS`。
- 白名单：重跑到 `ca38493e`，**364 行**（`meta.head=ca38493e...`），随台账同批提交。

## 8. 复算命令

```powershell
# 批后全仓快照（与 §12.1 同域；--root 三根写法与 --file-list 写法实测逐字节一致）
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b309-repo-post.txt

# 选行与落盘
node _annot_baseline/pick-generic.mjs b309 _annot_baseline/b309-files.txt _annot_baseline/b308-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b309 --start
node _annot_baseline/apply-run.mjs b309
node _annot_baseline/judge-generic.mjs b309
node _annot_baseline/gate-run.mjs --batch b309 --subject "注释清水 b309：4 文件 1→1 改写"
```

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单至 `73632ef9` + 本台账 §0（批次外修订） | `eb3f5247` | 3 文件 |
| b309 批次本体（4 文件 1→1 改写） | `ca38493e` | `+36/−36` |
| 白名单至 `ca38493e` + 本台账 §1–§9 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,610≠0` 未到，不触发收口；A2 `4,811 + 2,610 = 7,421` 成立；A3 `ledger-assert PASS`。
- 后续：b310 起继续 36 行/批；约 b390 前后插 10 行 N/P 语义双读。
