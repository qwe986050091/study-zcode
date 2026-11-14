# ZC-DEEP-B211（4 文件，+122 行）

> 范围：远程项目连接请求分派、连接类型与状态标签、远程工作区控制器、重连日志收集（合计 413 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b211\orig`；清单：`ZC-deep-b211-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~32.65%。

## 1. 验收输出

```text
[ok] packages/ui/src/remote-connection-flow/requestRemoteProjectConnection.ts: 14 blocks, 30 lines
[ok] packages/ui/src/remote-connection/RemoteConnectionTags.tsx: 9 blocks, 30 lines
[ok] packages/ui/src/remote/remoteWorkspaceController.ts: 15 blocks, 31 lines
[ok] packages/ui/src/root/useReconnectingRemoteWorkspaceLogs.ts: 15 blocks, 31 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=122
[packages/ui/src/remote-connection-flow/requestRemoteProjectConnection.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/remote-connection/RemoteConnectionTags.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/remote/remoteWorkspaceController.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/root/useReconnectingRemoteWorkspaceLogs.ts] added=31 nonComment=0 starSlash=0 suspicious=0
TOTAL added=122 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=112 comment=35 packages/ui/src/remote-connection/RemoteConnectionTags.tsx
31.73% code=104 comment=33 packages/ui/src/remote-connection-flow/requestRemoteProjectConnection.ts
32.32% code=99 comment=32 packages/ui/src/root/useReconnectingRemoteWorkspaceLogs.ts
32.65% code=98 comment=32 packages/ui/src/remote/remoteWorkspaceController.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/remote-connection-flow/requestRemoteProjectConnection.ts` | 连接请求分派 | 过期调用双重检查、等待前目标不可重选址、failed/pending 交向导、错误码优先级、catch 内二次归类、WSL 解析先校验 | 30 |
| `ui/src/remote-connection/RemoteConnectionTags.tsx` | 类型与状态标签 | 类型配色唯一来源、三套类名、as const、装饰图标、展示结果优先、status 角色与原子播报、恢复建议优先 | 30 |
| `ui/src/remote/remoteWorkspaceController.ts` | 意图分派器 | 判别联合、六分支全覆盖、每分支 await、打开会话一律拒绝、关闭须 user-close、重连选项两路、纯装配 | 31 |
| `ui/src/root/useReconnectingRemoteWorkspaceLogs.ts` | 重连日志收集 | 五十条配额、键列表入 ref、按项目分组、目标消失即清、空消息丢弃、匹配失败不写状态、复制最小化 | 31 |

## 3. 说明

- `requestRemoteProjectConnection.ts` 原 2.88%（已有 3 行注释），块锚定入口、双重时效检查、failedTarget 三重判定、向导分支、错误码三元、重连实参、catch 归类、profileId 收窄与 WSL 校验；
  `if (!isCurrent()) return;` 在入口与 catch 各出现一次，用 `nth: 1` 锚定入口那处。
- `RemoteConnectionTags.tsx` 原 4.46%（已有 5 行注释），块锚定配色表与三种类型、图标块解构、展示结果合并、status 角色、恢复建议分支；
  状态标签的简称回退分支未单独锚定，相关约束保留在 INV-12。
- `remoteWorkspaceController.ts` 原 1.02%，块锚定三个类型声明、控制器接口、工厂、switch 与拒绝分支、关闭来源校验；
  把「拒绝发生在副作用之前」与「未知意图不静默」写成两条独立不变量。
- `useReconnectingRemoteWorkspaceLogs.ts` 原 1.01%，块锚定上限常量、ref 与分组状态、键同步 effect、目标清理与引用复用、订阅与两处提前返回、截断与重置；
  重点标注「只有真正变化才复制对象」，避免每条日志重建整个映射。
- 本批首次插入把 `round(code×0.314)` 当成了新增行数，导致前两个文件各多写 3 行和 5 行（34.62%、35.71%）；
  已从快照还原后按「新增 30 行」重插，最终密度回到 31.25%~32.65%，`deletedNonZero` 仍为 0。
- 后两个文件各新增 31 行，因文件原有 1 行注释，落点 32.32%/32.65%，略高于 31%~32% 目标带但仍在验收门槛之上。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1878 needLines=26822 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1874 needLines=22230
```

累计 1,350 文件 / 126,129 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b211 | 提交 a8784b7e | numstat 121 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=26 / 121）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=121 waterLines=26 waterRate=21.49% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=121
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=110 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=32 missing=0
```

- 结论：**六件套未全通过**。waterLines=26 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
