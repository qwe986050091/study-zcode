# ZC-deep-b363

> 批次：b363 ｜ **19 行 / 6 文件** ｜ 提交 `46bdb449`

## 0. 方案 ① 普通批；`fix=2`；`hit_rate=10.5%`

- `TALLY {"ownIn":19,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":19,"planOut":0}` / `files=6/6`。
- **首轮 `hits=2`，均为 `L` 无信息列举**：
  - `OnboardingAgentsFileStep.tsx:71`（「…，…，没有额外按钮」缺谓词）→ 改「必须调 `setSelected`」；
  - `highspeedOutputFooter.ts:104`（三条并列，`为` 不算谓词）→ 补「为真」「必须跳过」。
  第二轮 0。`fix=2`；`hit_rate = 2 ÷ 19 = 10.5%`。
- 等集断言先跑：`plan=19 diff=19 missing=0 extra=0`。
- `fix≥2` 连续计数：b362=0、b363=2 → **当前 1**（未达连续两批）。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/onboarding/OnboardingAgentsFileStep.tsx` | 4 | 4 | 0 | ui/onboarding |
| `packages/ui/src/gen-ui/app/tweaks.ts` | 3 | 3 | 0 | ui/gen-ui/app |
| `packages/ui/src/highspeed/highspeedOutputFooter.ts` | 3 | 3 | 0 | ui/highspeed |
| `packages/services/src/client-config/clientConfigService.ts` | 3 | 3 | 0 | services/client-config |
| `packages/shared/src/zcode-protocol-v4/apply.ts` | 3 | 3 | 0 | shared/zcode-protocol-v4 |
| `packages/stream-animate/src/server/dataStore.ts` | 3 | 3 | 0 | stream-animate/server |
| **合计** | **19** | **19** | **0** | — |

- 4 个顶层目录（ui / services / shared / stream-animate），6 文件全部清零。

## 2. 改动内容

- `OnboardingAgentsFileStep.tsx`：`supported !== true` 时 `selected` 必须为 false；`disabled` 由 `supported` 直接决定；整卡按钮即切换入口；透明文字模拟空图标。
- `tweaks.ts`：`selection` 全局单值；入口先 `parse` 再按类型收窄；逐控件比较当前值与提交值。
- `highspeedOutputFooter.ts`：`cardStateById` 后写覆盖前写、停在组尾；三条判完成；零令牌返回 null。
- `clientConfigService.ts`：每次抓取新建 `AbortController`；`Promise.race` 竞速；`options` 先过 schema。
- `apply.ts`：`row.appended` 总数与首行锚点同增；首行裁剪重置活跃分支；`state.updated` 键级替换。
- `dataStore.ts`：`createRunId` 时间戳加随机后缀；`flags: "a"` 追加；必须 `a` 不能 `w`。

## 3. 六闸

```
gate: PASS scope n=0 plan=19 allow=0 diff_old=19 diff_new=19 out_of_scope_edits=0 plan_lines_covered=19/19
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=46bdb449 files=6/6 numstat=19/19 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=19 added=0 allowed=29 auto_self_clear=0
gate: PASS order n=0 total=89.0s controllable=70.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 进度（双分母）

- 全仓 weak：`4,105 → 4,086`（−19），文件 `1,638 → 1,632`（−6）。
- 池内：**845 行 / 432 文件** = **可写 350** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,576 / remain 845`；`6,576 + 845 = 7,421`。
- **对基线 88.6%**；**对可达上限 6,926：94.9%**。
- 可清到零文件 **112**；含不可写残留 **1,520**；池外残留 3,241 行。

## 6. 计时（B 段第 14 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `2aa22a6f`（12:22:01） | 批次提交 `46bdb449`（12:23:30） | 89.0s | 4.68s |
| `controllable` | `--start`（12:22:20） | 批次提交（12:23:30） | 70.0s | **3.68s** |
| 收口段 | 批次提交（12:23:30） | 台账提交 `50dce5a8`（12:24:11） | 41s | — |
| `批墙钟` | 最早产物 `b363-t-start.txt`（12:22:20） | 台账提交 `50dce5a8`（12:24:11） | 111.0s | 5.84s |

**近三批滚动窗口**（b365 后统一看，暂不改 1.7h 基准）：

| 批 | 行/批 | s/行 | 收口 |
| --- | ---: | ---: | ---: |
| b361 | 25 | 4.76 | 46s |
| b362 | 20 | 3.45 | 35s |
| b363 | 19 | 3.68 | 41s |
| **均值** | **21.3** | **3.96** | **40.7s** |

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `46bdb449` | `+19/−19` |
| `ZC-deep-b363-rewrite.tsv` + 本台账 + INDEX | `50dce5a8` | — |
