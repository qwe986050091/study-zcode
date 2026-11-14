# ZC-deep-b350

> 批次：b350 ｜ **38 行 / 6 文件** ｜ 提交 `54890d48`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`（含 `plan_lines_covered`）、`gate-run.mjs`

## 0. 形状 B 首批（6 文件上限）：只作实测，不定案

- 形状 B：行目标 33、**文件上限 6**（b350 起）。本批 6 文件合计 **38 行**，**33 达成**（首个达成的批次）。
- `TALLY {"ownIn":38,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":38,"planOut":0}` / `plan=38` / `files=6/6`。
- **本批只当实测开销，不据此宣布形状 B 定案**；定案等 §6.1 的成本核对结论。
- **全量候选已跑完（后台，`CAND_LIMIT=9999`）**：`rows=1709 ownInPosFiles=516 sumOwnIn=1255`，
  即池内可写 **516 文件 / 1,255 行**，与 `capacity-estimate` 的 `REMAIN 516/1255` 完全一致；
  `cand` 旧的 60 行截断确认为统计上限，已修。（这一条回答「1,255 与 24 谁是真的是」：1,255 真，24 是截断。）

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/v4/composer/useDraftConfigControl.ts` | 7 | 7 | 0 | ui/v4/composer |
| `packages/ui/src/v4/workbenchLayout.ts` | 7 | 7 | 0 | ui/v4 |
| `apps/zcode-cli/packages/adapters/src/browser/page-command.ts` | 6 | 6 | 0 | adapters/browser |
| `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts` | 6 | 6 | 0 | adapters/exec |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-git.ts` | 6 | 6 | 0 | core/tool/handlers |
| `apps/zcode-cli/packages/tui/src/app-selection-panel.tsx` | 6 | 6 | 0 | tui |
| **合计** | **38** | **38** | **0** | — |

- **目录分布**：`packages/ui` 2（v4 布局与 composer）、`adapters` 2（browser / exec）、`core/tool/handlers` 1、`tui` 1。
  **跨 4 个顶层目录**——按 §6.1 第 5 条（软约束：同目录优先，允许跨目录，一批不超过 4 个顶层目录），
  **本批在规则内**，不是例外。可写候选只有 6 个文件、分散在 4 处（全量候选确认 516 文件分布极散，
  密度 1,255/516≈2.4 行/文件），无法在 6 文件内聚到同一域。
  读链按「UI 布局 → 浏览器命令 → 进程执行 → 只读策略 → TUI 选择面板」串起，未出现无关域混读。

## 2. 改动内容

- `useDraftConfigControl.ts`：`pendingRequests` 模块级 Map；菜单处理器只调 `setDraft`；`waitForRemote` 启动读取；
  只改 `draft` 局部、持久化交 `useEffect`；回调读 `draftRef.current`；写回先校验 `scope` 再比对捕获值；
  计划模式开关语义写 `plan` / 回退 `previousMode`。
- `workbenchLayout.ts`：`--v4-split-` 变量前缀契约；`Rect` 四个 CSS 表达式；`Splitter` 记 `ratio` 与 `dragRect`；
  `leaf` 终止递归；`horizontal` 切 `width`；对外只暴露 `flatten` 结果；`splitterStyle` 按 `orientation` 分支。
- `page-command.ts`：`action` 抛错按 `errorCode` 分类；`modifiers` 为空只执行 `action`；`keys` 除末项作修饰键；
  `drag` 必须成对 `down/up`；`path` 为空抛错；中间点按 `steps` 插值。
- `node-execution-adapter-process.ts`：被 `lifecycle` 复用；先建 `env` 再 `resolveCommand`；`wrapped` 重新 `resolve`；
  先等 `graceMs` 窗口；`keepAlive` 传 `Infinity`；超时先 `killProcessTree` 再 `destroy stream`。
- `bash-readonly-policy-flags-git.ts`：`--date` 取值、其余无值；`--stat` 只改展示；`--color` 不影响判定；
  无值开关可复用；表外 `option` 判危险；`--quiet`/`--exit-code` 只改语义。
- `app-selection-panel.tsx`：非内容行只算 `title`/`border`/`padding`；常量同时决定 `overlay` 定位；
  单位为终端 `cell`；列宽基于 `usableWidth`；子函数不再归一化；空 `items` 只替换列表行。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-12T02:43:55.042Z pre-weak=b349-repo-post.txt
gate: PASS scope     n=0 plan=38 allow=0 diff_old=38 diff_new=38 out_of_scope_edits=0 plan_lines_covered=38/38
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=54890d48 files=6/6 numstat=38/38 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=38 added=0 allowed=47 auto_self_clear=0
gate: PASS order     total=114.0s controllable=112.0s
```

- **`plan_lines_covered` 首跑：38/38**（负控 20/23 在 b350 前已验，纯平移 `exit 1`；本批为正控）。

## 4. 判据与返修（`fix`）

`fix=0/0/0s`

- `judge` **首跑即 `hits=0`**，无回改；`deep-quality` 也未报空泛提醒/堆叠。
- 这是 A 段末三批以来首次「零返修」，与 §5.3 禁用句式（不并列铺陈、每条给因果）直接相关。
- `b350-fix.tsv` 尚未落盘（本轮未单独记两次 judge 的时刻）；**b351 起补**，本批记 `0/0/0s` 是事实（无回改，耗时为 0）。

## 5. 自清

- `pool-diff removed=38 added=0 auto_self_clear=0`；累计仍 **9 行 / 9 文件**（自动 4、人工 5），距阈值 20 行差 11。

## 6. 池外对账

- 全仓 weak：`post-b349 4,497` → `post-b350 4,459`（**−38**），文件 `1,709 → 1,703`（六个文件全清）。
- **句子级**：`done 6,204 / remain 1,217`，`6,204 + 1,217 = 7,421`，**83.6%**。
- **逐行**：`remain ≈ 1,217 + 1,046 = 2,263`，`done ≈ 5,158 / 7,421`，约 **69.5%**。
- 池外：`4,459 − 1,217 = 3,242`，永久不排期。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0` → **PASS**。
- `capacity --batch b350`：`done files=497 (+6) / lines=6,204 (+38)`，`REMAIN 510 files / 1,217 lines`，
  `ALIGNED diff=0`；`ledger-assert`：`497 + 510 = 1,007`、`6,204 + 1,217 = 7,421` → **PASS**。
- 白名单 537 行（blob `89b838a5`）。

## 8. 复算命令

```powershell
$env:CAND_LIMIT='9999'; node d:/code/_annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b349-repo-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak b350-repo-post.txt --pre-weak b349-repo-post.txt --batch b350 --plan 6x100
node _annot_baseline/pick-generic.mjs b350 d:/code/_annot_baseline/b350-files.txt d:/code/_annot_baseline/b349-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b350 --start
node _annot_baseline/judge-generic.mjs b350
node _annot_baseline/gate-run.mjs --batch b350 --subject "注释清水 b350：6 文件 1→1 改写"
```

## 9. 计时（B 段第 1 批，单独起算，不与 A 段合并）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `74c18eb3`） | 批次提交 `54890d48` | 114.0s | 3.00s |
| `controllable` | `--start`（02:43:55.042Z） | 批次提交 | 112.0s | 2.95s |
| 起草段 | `b350-files.txt`（10:43:44） | `--start` | 11s | — |
| 收口段 | 批次提交（10:45:47） | 台账提交（10:46:40） | 53s | — |
| `批墙钟` | 最早产物（10:43:44） | 台账提交 `a4b7e46c`（10:46:40） | 176s | 4.63s |

- **与 A 段对比（不可合并，仅供观察）**：A 段尾部批可控 3.5–5.2 s/行、碎尾 4.2–5.5 s/行；
  b350 的 **2.95 s/行** 是 A/B 两段最低值，与「6 文件同批读完、无需回改」一致。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，529 行） | `74c18eb3` | 2 文件 |
| 批次本体（6 文件 1→1 改写） | `54890d48` | `+38/−38` |
| `ZC-deep-b350-rewrite.tsv` + 白名单 537 行 + 本台账 + INDEX 同步 | `a4b7e46c` | — |

- 收口判据：A1 `remain=1,217≠0`；A2 `6,204 + 1,217 = 7,421`；A3 `ledger-assert PASS`；
  A4 `6,204 + 0 + 1,217 = 7,421`。
