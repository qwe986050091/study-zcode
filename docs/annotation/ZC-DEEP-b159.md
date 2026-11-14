# ZC-DEEP-B159（4 文件，+151 行）

> 范围：Source Server 传输运行时、反馈工单共享类型、营销横幅与翻页数字组件（合计 639 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b159\orig`；清单：`ZC-deep-b159-files.txt`。
> 目标密度 31.4%，实际落点 31.28%~31.75%。

## 1. 验收输出

```text
[ok] packages/server/src/source-server/sourceServerTransportRuntime.ts: 6 blocks, 37 lines
[ok] packages/shared/src/feedback.ts: 6 blocks, 38 lines
[ok] packages/ui/src/components/marketing-touch/MarketingBanner.tsx: 5 blocks, 38 lines
[ok] packages/ui/src/components/ui/flip-metric-value.tsx: 6 blocks, 38 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=151
TOTAL added=151 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.34% code=134 comment=42 packages/server/src/source-server/sourceServerTransportRuntime.ts
31.28% code=179 comment=56 packages/shared/src/feedback.ts
31.71% code=123 comment=39 packages/ui/src/components/marketing-touch/MarketingBanner.tsx
31.75% code=126 comment=40 packages/ui/src/components/ui/flip-metric-value.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/server/src/source-server/sourceServerTransportRuntime.ts` | 远端命令的引号转义、中断检查、JSON 行解析、版本提取与 stdio 双工封装 | 单引号安全转义、终止错误名、倒序取 JSON 行、语义化版本唯一性、多流并发收敛、双工 end/error 传播 | 37 |
| `packages/shared/src/feedback.ts` | 反馈工单的类型、状态、模块枚举与下拉选项常量 | 状态机取值、模块固定集合、未指定 sentinel、框架归一、设备快照字段、选项顺序即 UI 顺序 | 38 |
| `packages/ui/src/components/marketing-touch/MarketingBanner.tsx` | 营销横幅：图片/视频/交互 bundle 三态展示与关闭、loading 覆盖层 | key 驱动重建、bundle 就绪前隐藏占位、鼠标悬停判定、失焦与页面隐藏清理、单按钮裁切 | 38 |
| `packages/ui/src/components/ui/flip-metric-value.tsx` | 指标数字逐字符翻页动画，支持 reduced-motion 降级 | 媒体查询监听双分支清理、字符宽度分级、非数字走静态、AnimatePresence key 唯一、父级布局不抖动 | 38 |

## 3. 说明

- `sourceServerTransportRuntime.ts` 的 `duplexFromStdio` 块锚定函数签名，插入在函数体之前，未进入 `new Duplex({...})` 对象字面量。
- `MarketingBanner.tsx` 的注释只落在组件函数体与 `useEffect` 之前，未插入 JSX 子节点或属性区。
- `flip-metric-value.tsx` 的 `return (` 块使用 `nth: 2` 定位组件返回值处，避开 `MetricCharacter` 内部的提前返回分支。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

