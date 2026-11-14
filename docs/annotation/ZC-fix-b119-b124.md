# ZC-fix-B119 ~ B124：按队列清的 6 个单文件批

> 判据：`zc-gate.mjs`（poem run + W/L/B，合并 `weaklines` 与 `qc-poem-audit` 口径）。
> 每文件一批、一次改完，不跨批反复动同一文件；每批均跑
> `zc-verify.mjs --rewrite`、`zc-gate.mjs --scan`、`zc-inner.mjs` 三项。
> 共同结果：`codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`、
> `nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`，且 `waterRate=0.00%`。

| 批次 | 文件 | 修复前 waterLines | `rewrittenSegments` | `deletedOwnCommentLines` | waterRate | 内文率 | 关键文件 | 处理 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| B119 | `packages/provider/src/registry-service.ts` | 42 | 8 | 44 | 0.00% | 1.94% | **是**（协议状态机 / 并发合并 / 密钥边界） | 待补到 ≥30% |
| B120 | `packages/provider-node/src/personal-provider-config-repository.ts` | 37 | 7 | 37 | 0.00% | 7.85% | **是**（持久化 / 文件锁 / 轮询恢复） | 待补到 ≥30% |
| B121 | `packages/ui/src/WorkflowPermissionBlock.tsx` | 28 | 6 | 28 | 0.00% | 10.00% | 否（纯展示块） | 写尽即止，已有 JSDoc + 主干锚点 |
| B122 | `packages/provider-node/src/provider-config-runtime.ts` | 27 | 6 | 27 | 0.00% | **35.45%** | **是**（资源生命周期 / 单飞并发 / 降级回退） | **样板：已补到 ≥30%** |
| B123 | `packages/ui/src/app-shell/WorkflowRunDirectorySidePane.tsx` | 27 | 6 | 27 | 0.00% | 6.98% | 否（数据装配，无持久化） | 写尽即止 |
| B124 | `packages/ui/src/browser-use/BrowserViewportSurface.tsx` | 26 | 6 | 26 | 0.00% | 18.80% | 否（布局外壳） | 写尽即止 |

## 关键文件判定规则（清完即判）

满足任一条即视为 v2 关键文件，**不能只删不补**，须按语句组补到内文率 ≥30%：

- 并发/单飞/代际合并、锁与竞态；
- 持久化、文件读写、崩溃恢复；
- 协议或状态机（启动 → 刷新 → 发布 → 销毁）；
- 资源生命周期（定时器、监听器、子资源释放顺序）；
- 安全边界（密钥、权限、信任域）；
- 序列化兼容（字段演进、跨版本读取）。

非关键文件保持「写尽即止」：允许低于 30%，但必须有文件头（职责/状态所有权）与主干锚点，
不允许出现整段裸代码而无一处解释（B122 修复前的 0.91% 即反例）。

### B122 样板：补什么、不补什么

- **补**：每个方法体内的分支条件、并发假设、释放顺序与失败语义（构造 9 行、`start()` 5 行、
  `#checkBackground()` 6 行、`dispose()` 5 行、`refreshZCodeBuiltin()` / 路径解析 / 监听注册各 1–2 行）。
- **不补**：类字段与类型已自解释的部分不做逐行复述；注释只回答「为什么这样写 / 改错会怎样」。
- 结果：`innerZh=39 / innerCode=110 = 35.45%`，同时 `waterRate=0.00%`（既不注水也不裸奔）。

## 队列口径

派活**以 `zc-gate.mjs --scan` 当次结果为准，不以 `zc-work-queue-poem.txt` 的历史命中数为准**。
本次复扫发现 5 个队列头部条目（`RootWorkspaceContent.tsx`、`virtualized-top-level-list.tsx`、
`StorageCategoryDetail.tsx`、`OffPeakHistoryTab.tsx` 等）已为 0 命中——属队列数据陈旧，不是漏清。
原因：队列按 `zc-clean-queue.mjs --all` 的旧快照生成，而其间已有批次清过同一文件。
后续每次开工先对候选文件重扫，命中为 0 直接跳过。

## 处理方式

1. **已有高质量 JSDoc/行内注释覆盖的 poem run 直接删除**，不做同义改写——
   避免「删旧注水、写新注水」的循环（B121 的来源徽标、B123 的 5 组 run 即此类）。
2. **没有邻近散文的 run 改写为 2–3 行含真实标识符 + 前置条件/后果的注释**，
   例如 `#observedRevision`、`#writeGeneration`、`withFileLock()`、`narrowTimelineToFill()`。
3. **W 行**（`模块职责` / `状态所有权`）补 ASCII 标识符或「做错会怎样」，
   例如 B120 的 `NodePersonalProviderConfigRepository` 与 B123 的 `useWorkflowRunJournalSummaries`。

## 判据边界

- `L`（无信息列举）按「≥2 个 `、,，` 且无谓词」判定，容易在「标题 + 两个逗号」的摘要行上误报；
  B122/B124 各出现 1 次，靠补谓词（`否则会` / `决定`）收敛，未改语义。
- `W`（单行无信息）会把「全中文但有因果」的句子判为弱行（B122 补注时 2 次）；
  处理方式是补一个真实标识符（`this.#disposed`、`#checkListeners`），不删句子。
- 删除 poem run 后 `deletedOwnCommentLines` 会大于 `rewrittenSegments × 平均行数`，
  这是去重而非漏改：被删行全部满足「相对 HEAD 新增 + 注释行」两条。
