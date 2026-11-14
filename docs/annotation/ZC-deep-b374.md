# ZC-deep-b374

> 批次：b374 ｜ **30 行 / 10 文件** ｜ 提交 `2825f227`

## 0. 普通批；`fix=0`；`hit_rate=0.0%`

- `plan_lines_covered=30/30`；`removed=30 added=0 allowed=42 auto_self_clear=0`。
- **首轮 0 行命中**（`precheck` 0 / `judge` 0 / 等集断言 0 / 六闸 0 首跑通过），`hit_rate = 0 ÷ 30 = 0.0%`，`fix=0`。
- 本批按 §5.3 新清单执行：每行都带反引号标识符，且绕开「注释里写带参调用」——
  30 行里没有一条触发 `seps >= 2`。

## 1. 选行、目录分布与**逐文件对账**（订正上一版错误结论）

| 文件 | 批前 weak | 批后 weak | 是否仍在 `1,572` 集合 |
| --- | ---: | ---: | --- |
| `apps/zcode-cli/packages/office-runtime/src/adapters/parse/xlsx.ts` | 4 | 1 | 是 |
| `apps/zcode-cli/packages/office-runtime/ui/main.tsx` | 4 | 1 | 是 |
| `apps/zcode-cli/packages/office-runtime/ui/shell/parts.tsx` | 5 | 2 | 是 |
| `packages/desktop/scripts/mcp-apps-host-fixture/background-main.ts` | 3 | 0 | 否 |
| `packages/desktop/src/host/index.ts` | 3 | 0 | 否 |
| `packages/desktop/src/host/windowRemoteConnectionRegistry.ts` | 3 | 0 | 否 |
| `packages/desktop/src/renderer/src/plugin-sandbox/aliasRuntime.ts` | 4 | 1 | 是 |
| `packages/desktop/src/scheduler/index.ts` | 5 | 2 | 是 |
| `packages/e2e-report/src/viewer/App.tsx` | 3 | 0 | 否 |
| `packages/provider-node/src/endpoint-scoped-zcode-builtin-source.ts` | 3 | 0 | 否 |
| **合计** | **37** | **7** | — |

- **订正**：上一版写「池内清零 10 / 全仓清零 10」是**错的**——那是我按「计划行都改完」推的，没有实测。
  实测：**池内清零 10 / 全仓清零 5**，`37 − 30 = 7` 行池外残留留在 5 个文件里。
- 集合恒等式闭合：`1,577 − 5 = 1,572`，**新进 weak 文件 0 个**（`Compare-Object` 复核：`entered=` 空、
  `left=5`）。没有「相邻行改写带出新 weak」的情况。
- **b373 的 10 对 7 同样闭合**：3 个文件（`model.ts` 128/129/130、`slashCommandHelpers.ts:51`、
  `SuggestedPromptsContainer.tsx:743`）只剩池外上游残留，仍留在集合里，所以 `1,584 − 7 = 1,577`，新进 0。
- 两个差额都**不是质量问题**：`池内清零 − 全仓清零` = 该批「余生池外残留」的文件数（b373 为 3、b374 为 5）。

## 2. 改动内容

- `xlsx.ts`：`ROWS_PER_UNIT` 双职责；`locator` 为空时每 sheet 一份预览；空表只出 `sheetLabel` 占位。
- `main.tsx`：INV 表索引写 `INV-xx`；`loadSeq` 代次与两处 `mine !== loadSeq.current`；
  `document.visibilityState !== "visible"` 的跳过语义。
- `parts.tsx`：`IDLE_MS` 只管淡出；`onSend` 失败提示的改动面；`onClose` / `onNext` 只回调。
- `background-main.ts`：`admitted` 存 `win` / `guest` 引用；`mode` 三值顺序；`env.guests.set` 还原。
- `host/index.ts`：`OffPeakRuntime` 三元组；`sourceAvailability=offline` 的展示口径；`basePortClosed` 局部标志。
- `windowRemoteConnectionRegistry.ts`：`closing` 期间拒绝同 key 新建；`normalizeServerConnectionUrl` 不做探测；
  `waitForScopedServices` 可能永不返回。
- `aliasRuntime.ts`：`markForeignApp()` 的 `connectPromise` 前置条件；`foreignApp` 单向标记（三行拆成三条独立事实）。
- `scheduler/index.ts`：退避不写库省 `AutomationRepo`；派发三步次序；`inFlight` 逐条释放。
- `App.tsx`：不轮询的理由；不细分错误的理由；`statsValue` 只做空值与格式化。
- `endpoint-scoped-zcode-builtin-source.ts`：退订直接 `#listeners.delete`；`#ensureCurrent` 共享解析；
  `#assertNotDisposed`。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=2825f227 files=10/10 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=42 auto_self_clear=0
gate: PASS order n=0 total=390.0s controllable=112.0s
GATE ALL PASS batch=b374 sha=2825f227
```

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` 数据行仍 **11 行**。

## 5. 进度

- 全仓 weak：**3,823 → 3,793**（−30）；filler 107 → 104；weak 文件 **1,577 → 1,572**（−5）。
- 池内：**554 行 / 354 文件**（`ALIGNED diff=0`、`ASSERT PASS`）。
- `done 6,867 / remain 554`；`6,867 + 554 = 7,421`。
- **行侧进度 92.5%**（6,867 ÷ 7,421）——唯一进度分母；文件侧 `653 ÷ 1,007 = 64.8%`（辅助）。
- 可清 **52**（57 − 5）；含不可写残留 **1,520** 未变。
- 剩余批数（cap 10）：**36 批**（354 ÷ 10），行/批均值 `554 ÷ 36 = 15.4`。

## 6. 计时（收口首次分段实测）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `4c1e0d15` | `2825f227`（14:16:54） | 390.0 |
| `controllable` | `--start` | 批次提交 | **112.0**（`s/行 = 3.73`） |
| **收口 S0**（提交 → 收口命令启动） | 14:16:54 | 14:17:04 | **10** |
| **S1** 改写表落盘 + `deep-quality` 全仓扫描 | 14:17:04 | 14:17:12 | **8** |
| **S2** `own-commits-gen` + `capacity-estimate` | 14:17:12 | 14:17:13 | **1** |
| **S3** 台账写作 | 14:17:19 | 14:17:55 | **36** |
| **S4** `git add` + `commit` | 14:17:55 | 14:17:56 | **1** |
| **S3 前的间隔**（读 `RATIOS` 行） | 14:17:13 | 14:17:19 | 6 |
| **合计** | 14:16:54 | 14:17:56 | **61s** |
| `批墙钟` | 14:10:24（`--start`） | 14:17:56 | **451s** |

- **工具段合计 9s**（S1+S2）。这条把 b372 那条「扫描 ≈95s」彻底钉死：**扫描 8s**。
  b372 的 332s、b371 的 416s 全部是写作与轮次间隔，不是工艺必需——与 b373 的 47s 互相印证。
- 但按 §5.3 第 6 条：**这仍只是窗口内的点，不改主报**。滚动中位窗口移到 b372–b374 后见 §7。

## 7. 滚动中位（估计器口径，每次只报窗口移动）

| 窗口 | 中位 `s/行` | 中位收口 | 中位墙钟 | 剩余批数 | 区间读数 |
| --- | ---: | ---: | ---: | ---: | --- |
| b371–b373（上轮） | 4.20 | 332s | 500s | 37 | 4.2–5.1h |
| **b372–b374（本轮）** | **3.73** | **61s** | **451s** | **36** | **1.3–4.5h** |

- 窗口移动：`416s` 移出（b371），`61s` 移入（b374）→ 中位收口 `332 → 61s`，
  区间读数 `4.2–5.1h → 1.3–4.5h`（下沿降 2.9h，上沿降 0.6h）。
- **主报仍为 2.6–4.5h**：b374 只是第 2 个 `收口 ≤60s` 的点（b373 47s、b374 61s），
  连续三批判定点仍在 **b375**（窗口 b373–b375）。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `2825f227` | `+30/−30` |
| `ZC-deep-b374-rewrite.tsv` + 本台账 + 白名单（641 行） | `11c68559` | — |
