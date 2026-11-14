# ZC-deep-b369

> 批次：b369 ｜ **24 行 / 6 文件** ｜ 提交 `1ab29ce3`

## 0. 普通批；`fix=1`；`hit_rate=16.7%`

- `files=6/6`；`plan_lines_covered=24/24`；`removed=24 added=0 allowed=35 auto_self_clear=0`。
- **首轮 4 行命中**，全是 `missing_predicate` 与 judge `L` 同报（同一行按行去重，只计一次）：
  `app-components.tsx:64`、`app-transcript-components.tsx:41`、`account-provider-resolution.ts:40`、
  `bigmodelCodingPlanSubscriptionProvider.ts:273`。→ `4 ÷ 24 = **16.7%**`。
  一轮回改各补一个谓词（`不会` / `不会` / `不会` / `所以`）后 `0/0`、`hits=0`。
- 这 4 行都是「多分句 + 逗号列举」形状：句子结构没问题，缺的是关系词。**precheck 与 judge 同时命中**，
  说明两条检查对这类句子的判据已经一致（词表合并后本该如此）。

## 1. 选行与目录分布

| 文件 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | --- |
| `apps/zcode-cli/packages/debug/src/App.tsx` | 4 | 0 | zcode-cli/debug |
| `apps/zcode-cli/packages/tui/src/app-components.tsx` | 4 | 0 | zcode-cli/tui |
| `apps/zcode-cli/packages/tui/src/app-transcript-components.tsx` | 4 | 0 | zcode-cli/tui |
| `packages/desktop/scripts/mcp-apps-host-fixture/retention-main.ts` | 4 | 0 | desktop |
| `packages/provider/src/account-provider-resolution.ts` | 4 | 1（池外） | provider |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | 4 | 1（池外） | services |
| **合计** | **24** | **2** | — |

- 4 个文件清零、2 个各留 1 行池外 weak，全仓文件数 −4（1,605 → 1,601）。

## 2. 改动内容

- `App.tsx`：`lastChangeAt` 换成 `Date.now()` 的后果；`EmptyLine` 要写「下一步做什么」；
  `MetaLine` 调用处别自己拼分隔符；`isFullscreen` 决定 `axis` / `item` 的取舍。
- `app-components.tsx`：两种形态共用同一份 `sidebar` 子树、不重建；扣减项里只有 `sidebarWidth` 随布局变化。
- `app-transcript-components.tsx`：`h` 别名不外导；`USER_MESSAGE_VERTICAL_PADDING` 固定 1 行的理由；
  `MessageRow` 下传两种颜色、子组件不判角色；`parts.length > 0` 时不渲染整段正文。
- `retention-main.ts`：参数顺序写反的后果；非空断言失败即退出；脚本不校验可写性；视口尺寸不参与测量。
- `account-provider-resolution.ts`：判别联合的字段差异；`resetPrevious` 不落盘；
  `entitlementSourceProviderId` 读母体权益；访问栈检测循环引用。
- `bigmodelCodingPlanSubscriptionProvider.ts`：不缓存凭据的开销依据；`flatMap` 而非 `filter` 的类型收益；
  附加字段不新建 envelope；预览只做最小校验。

## 3. 六闸

```
gate: PASS scope n=0 plan=24 allow=0 diff_old=24 diff_new=24 out_of_scope_edits=0 plan_lines_covered=24/24
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=1ab29ce3 files=6/6 numstat=24/24 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=24 added=0 allowed=35 auto_self_clear=0
gate: PASS order n=0 total=113.0s controllable=112.0s
GATE ALL PASS batch=b369 sha=1ab29ce3
```

## 4. 自清

- `auto_self_clear=0`，无新增登记。

## 5. 进度（双分母）

- 全仓 weak：`3,975 → 3,951`（−24），文件 `1,605 → 1,601`（−4）。
- 池内：**711 行 / 398 文件** = **可写 216** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,710 / remain 711`；`6,710 + 711 = 7,421`（capacity `ASSERT PASS`）。
- **对基线 90.4%**（6,710 ÷ 7,421）；**对可达上限 96.9%**（6,710 ÷ 6,926）。
- 可清到零文件 **81**（85 − 4）；含不可写残留 **1,520**（未变）。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 | `1ab29ce3`（13:08:19） | 113.0s | 4.71s |
| `controllable` | `--start`（13:06:27） | 批次提交（13:08:19） | 112.0s | **4.67s** |
| 收口段 | 13:08:19 | 台账提交 `668ac8a6`（13:09:05） | 46s | — |
| `批墙钟` | 13:06:27 | 台账提交（13:09:05） | 158.0s | 6.58s |

| 批 | 行/批 | 行/文件 | s/行 | 收口 |
| --- | ---: | ---: | ---: | ---: |
| b366 | 30 | 5.00 | 7.17 | 123s |
| b367 | 26 | 4.33 | 6.04 | 235s |
| b368 | 24 | 4.00 | 4.25 | 86s |
| b369 | 24 | 4.00 | **4.67** | 46s |

- b368 / b369 都是 24 行 / 6 文件，`s/行` 4.25 vs 4.67（+10%），差额来自**一轮回改**（`fix=1`）。
  两批合计把「每文件固定开销 ~24s」进一步否掉：同形状两批都落在 4.2–4.7，而不是 6 以上。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `1ab29ce3` | `+24/−24` |
| `ZC-deep-b369-rewrite.tsv` + 本台账 + INDEX + 白名单 | 见回填 | — |
