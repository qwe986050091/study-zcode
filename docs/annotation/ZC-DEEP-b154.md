# ZC-DEEP-B154（4 文件，+155 行）

> 范围：截图 surface 就绪验证、控件提示、内置浏览器 URL 工具与会话滚动记忆（合计 750 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b154\orig`；清单：`ZC-deep-b154-files.txt`。
> 目标密度 31.4%，实际落点 31.10%~31.50%。

## 1. 验收输出

```text
[ok] packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts: 6 blocks, 39 lines
[ok] packages/ui/src/ControlHintTooltip.tsx: 5 blocks, 38 lines
[ok] packages/ui/src/embeddedBrowserHelpers.ts: 6 blocks, 40 lines
[ok] packages/ui/src/lib/chatSessionScrollMemory.ts: 6 blocks, 38 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=155
TOTAL added=155 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.37% code=204 comment=64 packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts
31.10% code=164 comment=51 packages/ui/src/ControlHintTooltip.tsx
31.37% code=255 comment=80 packages/ui/src/embeddedBrowserHelpers.ts
31.50% code=127 comment=40 packages/ui/src/lib/chatSessionScrollMemory.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts` | 在后台合成层等候两个稳定帧后上报截图 surface 就绪 | rAF 与 timer 竞速、版本号作废旧验证、截止时间停止重试、两帧一致才上报、尺寸/dom-ready/可见性三处重启 | 39 |
| `packages/ui/src/ControlHintTooltip.tsx` | 包装 Radix Tooltip，统一标题、描述、快捷键与侧栏延迟 | ref 合并与身份稳定、描述分支布局、共享 Provider、侧栏延迟与上下文标记、禁用元素适配层 | 38 |
| `packages/ui/src/embeddedBrowserHelpers.ts` | 内置浏览器 URL 归一化、协议白名单、本机判定与 guest 容错 | 仅可恢复原因重建、生命周期竞态边界收敛、协议白名单分层、地址栏补全规则、证书错误区间、链接目标分流 | 40 |
| `packages/ui/src/lib/chatSessionScrollMemory.ts` | 按工作区、面板与会话记住聊天滚动位置 | 容量上限与 LRU 淘汰、键构造优先级、任务桶迁移到会话桶、读取刷新顺序、恢复位置夹取区间 | 38 |

## 3. 说明

- `ControlHintTooltip.tsx` 含 JSX，新块只插在模块级函数签名之前与函数体语句之前，未进入 JSX 子节点或属性区。
- `chatSessionScrollMemory.ts` 首行 `export interface ChatSessionScrollMemoryState {` 已是文件首个节点，文件头直接锚定首行，未与块锚点冲突。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
