# ZC-DEEP-B144（4 文件，+165 行）

> 范围：导出页独立校验脚本、浏览器控制桥、远端工作区服务集合与桌面网络策略。
> 快照：`d:\code\_annot_baseline\ZC-deep-b144\orig`；清单：`ZC-deep-b144-files.txt`。
> 目标密度 31.4%，实际落点 31.19%~31.78%。

## 1. 验收输出

```text
[ok] packages/desktop/scripts/gen-ui-fixture/standalone-checks.ts: 5 blocks, 40 lines
[ok] packages/desktop/src/host/browserControlMainBridge.ts: 5 blocks, 43 lines
[ok] packages/desktop/src/host/remoteWorkspaceServiceCollection.ts: 5 blocks, 42 lines
[ok] packages/desktop/src/main/desktopNetworkPolicy.ts: 5 blocks, 40 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=165
TOTAL added=165 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.78% code=129 comment=41 packages/desktop/scripts/gen-ui-fixture/standalone-checks.ts
31.49% code=362 comment=114 packages/desktop/src/host/browserControlMainBridge.ts
31.54% code=298 comment=94 packages/desktop/src/host/remoteWorkspaceServiceCollection.ts
31.19% code=218 comment=68 packages/desktop/src/main/desktopNetworkPolicy.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/scripts/gen-ui-fixture/standalone-checks.ts` | 真实 Chromium 下的导出页独立校验 | 隔离断言、双主题测量、仿真复位与窗口销毁 | 40 |
| `packages/desktop/src/host/browserControlMainBridge.ts` | host 到 main 的浏览器命令转发与结果关联 | 请求标识唯一性、超时与取消、副作用口径与落盘顺序 | 43 |
| `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` | 远端 RPC 服务面到 Host 服务集合的装配 | 合同对齐自检、单向转发、广播分流与 hostId 过滤 | 42 |
| `packages/desktop/src/main/desktopNetworkPolicy.ts` | Electron 会话的代理与证书校验策略 | 出口差异化、代理归一化、证书链匹配与失败降级 | 40 |

## 3. 说明

- `browserControlMainBridge.ts` 与 `remoteWorkspaceServiceCollection.ts` 既有注释密集（19.61% / 17.45%），本批正文块避开既有注释锚点。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
