# ZC-DEEP-B134（3 文件，+121 行）

> 范围：侧边栏标签展示、后台 bash 输出面板与远程控制连接过程页。
> 快照：`d:\code\_annot_baseline\ZC-deep-b134\orig`；清单：`ZC-deep-b134-files.txt`。
> 目标密度 31.4%，实际落点 31.11%~31.30%。

## 1. 验收输出

```text
[ok] packages/ui/src/app-shell/sidePaneTabPresentation.ts: 5 blocks, 40 lines
[ok] packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx: 5 blocks, 40 lines
[ok] packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx: 5 blocks, 41 lines
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=121
TOTAL added=121 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.11% code=135 comment=42 packages/ui/src/app-shell/sidePaneTabPresentation.ts
31.30% code=131 comment=41 packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx
31.21% code=141 comment=44 packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/app-shell/sidePaneTabPresentation.ts` | 侧边栏标签的搜索词、本地化标题与类型标签 | 搜索面覆盖、映射回退、类型合并与文案注入 | 40 |
| `packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx` | 后台 bash 输出侧栏面板与跟随滚动 | 可见性贴底、上翻暂停、进退阈值与数据属性 | 40 |
| `packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx` | 远程控制连接过程的全屏进度页 | 阶段穷举、线性阶段进度、文案整包与无障碍播报 | 41 |

## 3. 说明

- `sidePaneTabPresentation.ts` 的搜索词函数签名为单行，锚点按整行匹配。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
