# ZC-DEEP-B169（4 文件，+154 行）

> 范围：UI 包公共出口、内嵌浏览器视口外壳、工具卡片与转写段落组件（合计 703 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b169\orig`；清单：`ZC-deep-b169-files.txt`。
> 目标密度 31.4%，实际落点 31.21%~31.62%。

## 1. 验收输出

```text
[ok] packages/ui/src/index.ts: 4 blocks, 36 lines
[ok] packages/ui/src/browser-use/BrowserViewportSurface.tsx: 6 blocks, 48 lines
[ok] packages/ui/src/components/ai-elements/tool.tsx: 4 blocks, 35 lines
[ok] packages/ui/src/components/ai-elements/transcription.tsx: 4 blocks, 35 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=154
TOTAL added=154 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.62% code=117 comment=37 packages/ui/src/index.ts
31.35% code=185 comment=58 packages/ui/src/browser-use/BrowserViewportSurface.tsx
31.21% code=141 comment=44 packages/ui/src/components/ai-elements/tool.tsx
31.53% code=111 comment=35 packages/ui/src/components/ai-elements/transcription.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/index.ts` | UI 包唯一公共出口 | 桶文件契约、类型与值分离、同模块合并导出、注册与解绑对称、按领域分段 | 36 |
| `packages/ui/src/browser-use/BrowserViewportSurface.tsx` | 内嵌浏览器视口外壳 | 失败优先级、受控视口、节点稳定挂载、仅在创建时声明弹窗与子框架、布局补偿条件、警告条语义 | 48 |
| `packages/ui/src/components/ai-elements/tool.tsx` | 工具调用卡片 | 两张状态表同键、标题剥离前缀、失败态只留错误文本、结果按类型分流、许可头保留 | 35 |
| `packages/ui/src/components/ai-elements/transcription.tsx` | 转写容器与可点击段落 | 上下文判空、受控与非受控时间、三态互斥、左闭右开边界、段组件只读 | 35 |

## 3. 说明

- `index.ts` 首个导出与头部锚点同行，故首个内容块下移到按钮导出，避免同一行重复定位；头部仍落在文件首行之前。
- `BrowserViewportSurface.tsx` 的块落在函数签名、两个派生常量、ref 回调与 `return` 语句前，未插入任何 JSX children。
- 两个 ai-elements 文件首行分别是许可块与客户端指令，头部整块前置；内容块只锚定类型、状态表与组件签名。
- `tool.tsx` 中 `return (` 之类的 JSX 起点未被选作锚点，避免注释落入 JSX 表达式。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2046 needLines=32094 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2042 needLines=27502
```

累计 1,182 文件 / 120,578 行。
