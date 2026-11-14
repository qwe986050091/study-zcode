# ZC-deep-b327

> 批次：b327 ｜ 40 行 / 4 文件 ｜ 提交 `15a50dab`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b326-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 十一闸全部首跑 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=40/40`、
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`。
- 首轮 `judge-generic` 即 `hits=0`，无需返修；`git diff --stat` 始终 `40 insertions / 40 deletions`，无连带。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/desktop/scripts/mcp-apps-host-fixture/managed-renderer.tsx` | 10 | 0 | 10 | 0 |
| `packages/ui/src/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.tsx` | 10 | 0 | 10 | 0 |
| `packages/ui/src/browser-use/HumanBrowserView.tsx` | 10 | 0 | 10 | 0 |
| `packages/ui/src/components/ai-elements/schema-display.tsx` | 10 | 0 | 10 | 0 |
| **合计** | **40** | **0** | **40** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,777 → 1,773。
- 10 × 4 = 40，落在 33–44 浮动区间内。

## 2. 改动内容

- `managed-renderer.tsx`：`proxy` 工厂按方法名动态转发、`realSetTimeout`/`realClearTimeout` 同一条声明绑定、
  `window.setTimeout` 只拦 `300_000` 一档、`clearTimeout` 先查 `fakeIds` 再撤 `deadlines`、
  `useState` 初值由 `config.mode` 推导且只允许 `renderState` 改、`drained.add(check)` 后立即 `check()` 自查、
  复用 `buildPluginUiSurfaceKey` 拼键、`Promise.withResolvers` 等待而非轮询、`rows` 模式独立 `ServiceProvider` 装配、
  `createRoot` 根引用不保留。
- `ArtifactOpenAsFileButton.tsx`：`onReveal` 可选与缺项语义、`canOpenAsFile` 的判型前提
  （`materializeWorkflowArtifactFile` + `openExternalFile` 双必需、任一 `undefined` 即不支持）、
  纯同步判定不做异步探测、`bytes` 为 `null` 时不物化、`pending` 写 `pathsRef`、失败即删 `key` 以便重试。
- `HumanBrowserView.tsx`：`agentOpened` 决定取 `DEFAULT_AGENT_BROWSER_VIEWPORT` 还是持久化偏好、
  `initialPreferenceRef` 在 `loading` 转假后只算一次、`settings` 在加载期不参与、
  `unifiedProps` 原样透传、`commitPreference` 经 `clonePreference` 深拷贝、
  写回从 `updateRef.current` 读 `update`、`catch` 分支只 `logger.warn`、
  `writeTimerRef.current` 的空值短路与 `clearTimeout` 后置空、`clearPendingWrite` 幂等。
- `schema-display.tsx`：`SchemaDisplayContextType` 六个字段不做嵌套分组、
  `Badge` 的 `variant` 固定 `secondary`、`SchemaDisplayMethod` 不校验 `HttpMethod`、
  `className` 经 `cn()` 合并、`method` 保持可选以便无参可用、
  `requestBody` 交给 `SchemaDisplayProperty` 且 `depth` 归零、
  `responseBody` 与 `requestBody` 对称复用同一套语义、`SchemaDisplayBody` 只管分隔线与内边距。

## 3. 门禁读数

```text
gate: PASS start     t-start=09:38:33Z pre-weak=b326-repo-post.txt
gate: PASS scope     n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=15a50dab files=4/4 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=40 added=0 allowed=46 auto_self_clear=0
gate: PASS order     total=139.0s controllable=107.0s
```

## 4. 首轮命中与返修

- 首轮 **0 / 40**，无返修。
- 40 行全部按「每行点一个具体标识符」写（`proxy`、`realClearTimeout`、`buildPluginUiSurfaceKey`、
  `pathsRef`、`updateRef.current`、`SchemaDisplayProperty` 等），因此没有踩到 b326 的两类坑：
  无 ASCII 锚点导致的 `W`，以及 ASCII 逗号被算作列举分隔导致的 `L`。

## 5. 自清（累计第 17 批无自清；本批 0 自动、0 人工）

- `removed=40`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=46`）。
- b325 的自动自清未引发后续，本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b326 5,221` → `post-b327 5,181`（**−40**），文件 `1,777 → 1,773`。
- **句子级口径**：`done 5,485 / remain 1,936`，`5,485 + 1,936 = 7,421`，**73.9%**。
- **逐行口径**：`remain ≈ 1,936 + 1,046 = 2,982`，`done ≈ 4,439 / 7,421`，约 **59.8%**。
- 池外：`5,181 − 1,936 = 3,245`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b326-guard-post.txt`）。
- `capacity-estimate --batch b327`：`done files=403 (+4) / lines=5,485 (+40)`，
  `REMAIN 604 files / 1,936 lines`，`ALIGNED acct_remain=1936 pool_remain=1936 diff=0`，分档合计 303 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`403 + 604 = 1,007`、`5,485 + 1,936 = 7,421` → **PASS**（`ROLL` 144/658/802 全 0 剩余）。
- 白名单重跑到 `15a50dab`，**429 行**（开批前 427 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b326-repo-post.txt
node _annot_baseline/pick-generic.mjs b327 d:/code/_annot_baseline/b327-files.txt d:/code/_annot_baseline/b326-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b327 --start
node _annot_baseline/judge-generic.mjs b327
node _annot_baseline/gate-run.mjs --batch b327 --subject "注释清水 b327：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b327-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b327-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b326-guard-post.txt --post d:/code/_annot_baseline/b327-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b327-repo-post.txt --pre-weak d:/code/_annot_baseline/b326-repo-post.txt --batch b327
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `c4ba712c`，17:38:01） | 批次提交 `15a50dab`（17:40:20） | 139.0s | 3.48s |
| `controllable` | `--start`（17:38:33） | 批次提交（17:40:20） | 107.0s | 2.68s |
| `批墙钟` | 本批最早可观测产物 `b327-files.txt`（17:38:23） | 台账提交 `2c5b95f5`（17:41:53） | 210s | 5.25s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，427 行） | `c4ba712c` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `15a50dab` | `+40/−40` |
| `ZC-deep-b327-rewrite.tsv` + 白名单 429 行 + 本台账 + INDEX 同步 | `2c5b95f5` | — |

- 收口判据：A1 `remain=1,936≠0`；A2 `5,485 + 1,936 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,485 + 0 + 1,936 = 7,421` 成立。
