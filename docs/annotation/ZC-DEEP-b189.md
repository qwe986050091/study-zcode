# ZC-DEEP-B189（4 文件，+133 行）

> 范围：工作区连接注册表、分享预览模拟客户端、控制套接字服务端、不可变发布晋升（合计 587 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b189\orig`；清单：`ZC-deep-b189-files.txt`。
> 目标密度 31.4%，实际落点 31.11%~31.62%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/workspaceConnectionRegistry.ts: 4 blocks, 34 lines
[ok] packages/web/src/share/mockConversationSharePreviewClient.ts: 4 blocks, 33 lines
[ok] packages/zcode-server-cli/src/ipc/controlServer.ts: 4 blocks, 33 lines
[ok] packages/zcode-server-cli/src/runtime/immutableRelease.ts: 4 blocks, 33 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=133
TOTAL added=133 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.22% code=221 comment=69 packages/ui/src/v4/workspaceConnectionRegistry.ts
31.62% code=117 comment=37 packages/web/src/share/mockConversationSharePreviewClient.ts
31.11% code=135 comment=42 packages/zcode-server-cli/src/ipc/controlServer.ts
31.58% code=114 comment=36 packages/zcode-server-cli/src/runtime/immutableRelease.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/v4/workspaceConnectionRegistry.ts` | 共享连接注册表 | 端点与工作区拼键、复用清预热、失效标记与清场、归零延迟释放、租约幂等、代际单向切换 | 34 |
| `packages/web/src/share/mockConversationSharePreviewClient.ts` | 分享预览模拟客户端 | 特殊码到错误映射、私有令牌校验、软提示计数、样例三行覆盖、完整性占位、签名与真实客户端一致 | 33 |
| `packages/zcode-server-cli/src/ipc/controlServer.ts` | 控制套接字服务端 | 启动清旧端点、权限收紧、关闭幂等与有界等待、连接错误隔离、帧解析失败回写、响应前校验 | 33 |
| `packages/zcode-server-cli/src/runtime/immutableRelease.ts` | 不可变发布晋升 | 摘要格式与大小写、目录哈希含权限位与分隔符、既有发布逐项比对、并发命中复用、临时目录清理 | 33 |

## 3. 说明

- `workspaceConnectionRegistry.ts` 首行是既有文件说明，header 插在其上；块落在键构造、获取入口与诊断计数前，既有预热注释未动。
- `mockConversationSharePreviewClient.ts` 的块落在样例构造函数、类声明与软提示分支前；对象字面量与字符串内容均未改动。
- `controlServer.ts` 的块落在创建入口、连接处理与响应写出前；`close` 内既有安全注释保持原样。
- `immutableRelease.ts` 的块落在目录哈希、既有发布校验与晋升入口前；`finally` 内既有清理注释未动。
- 本批 4 份 spec 均一次 check 通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1966 needLines=29463 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1962 needLines=24871
```

累计 1,262 文件 / 123,346 行。
