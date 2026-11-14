# ZC-FIX-B2（1 文件：OpenSplitButton.tsx）

> B29 共 5 个命中文件，本批先清最大的 `OpenSplitButton.tsx`（15 处 / 51 行）。
> 校验基线：`ZC-fix-b2/orig`，由 `_replay_pre.mjs` 把 `spec-b29-a.json` + `spec-b29-b.json`
> 重放进 `ZC-deep-b29/orig` 得到，等价于「B29 已插入、尚未改写」的状态；插入是确定性的，可逐行复现。

## 1. 验收输出

```text
[ok] packages/ui/src/OpenSplitButton.tsx
SUMMARY files=11 rewrittenSegments=15 deletedOwnCommentLines=58 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
numstat: +15 / -58
```

三条删行约束全部为 0 违例；`files=11` 是本批清单（B29 全部），只有目标文件被改动。

## 2. 改写对应关系

| 原位置 | 原写法 | 改写后锚定的真实标识符 |
| --- | --- | --- |
| `OpenSplitButtonTarget` 前 | 4 行「网页/文件两种形态」 | `type: "website" \| "file"`、`url`、`localPath`、`title`、`label`、`MessageFileLinkTarget` |
| `OpenSplitButtonProps` 前 | 3 行「能力都是可选回调」 | `onOpenBrowserUrl` / `onOpenFileLink` / `onOpenCodeViewer`、`canPreview` |
| `OpenSplitButton` 前 | 3 行「两个默认值」 | `hideOpenWithMenu`、`stopPropagation`、`renderCard` |
| `isRemoteSource` 前 | 4 行「三个来源任一为真」 | `previewSource.workspaceIdentity`、`workspaceRemoteSessionId`、`matchedOpenContext.isRemoteWorkspace`、`canOpenNative` |
| `useFileContextActions` 前 | 3 行「路径动作按远程初始化」 | `canOpenLocalFileManager`、`isRemoteSource` |
| `canOpenNative` 前 | 3 行「两个条件都要判」 | `platform.canOpenLocalFiles`、`handleOpenDefault` |
| `editorRequest` 前 | 5 行「请求号是唯一并发保护」 | `useRef`、`editorRequest.current`、虚拟列表复用 |
| `editors` 前 | 3 行「列表与标志成对」 | `editors`、`editorsLoaded`、`loadingEditors`、`loadEditors` 首个早退 |
| `sortedEditors` 前 | 4 行「远程无目标返回空」 | `isRemoteSource`、`openInEditorRemoteTarget`、`resolveWorkspaceEditorSelection`、`availableEditors` |
| 目标变化 `useEffect` 前 | 5 行「依赖含身份」 | 三个依赖字段、`editorRequest`、清理函数 |
| `loadEditors` 前 | 4 行「三个早退」 | `editorsLoaded`、`loadingEditors`、`target.type !== "file"`、`platform.getInstalledEditors` |
| `handlePreview` 前 | 4 行「网页不落文件分支」 | `onOpenBrowserUrl`、`onOpenCodeViewer`、`onOpenFileLink`、`return` |
| `handleOpenInEditor` 前 | 5 行「先持久化再打开」 | `persistLastSelectedEditorId`、`platform.openInEditor`、`result.success`、`Error(result.error ?? "unknown-error")` |
| `const button` 前 | 4 行「同一容器两个可点区域」 | `stopEventPropagation`、`DropdownMenuTrigger`、`hideOpenWithMenu`、`px-2` |
| `if (!renderCard)` 前 | 3 行「不包右键容器」 | `renderCard`、`ContextMenu`、`ContextMenuTrigger asChild` |

## 3. 说明

- 全部合并为单行，且每条都写出「哪个标识符 / 顺序为什么不能反 / 破坏后什么现象」，不再出现无指代短句。
- 顺带把紧邻的 2 行残句（低于 3 行阈值、未被脚本命中）合并进同一条，避免留下半截排比。
- 本批净删 43 行注释；密度按「内容优先」不再设门槛。
