# ZC-DEEP-B199（4 文件，+128 行）

> 范围：桌面数据库启动状态中继、插件沙箱会话锁定、Provider 配置双套 zod 契约与会话分享契约（合计 748 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b199\orig`；清单：`ZC-deep-b199-files.txt`。
> 目标密度 31.4%，实际落点 31.13%~31.33%。

## 1. 验收输出

```text
[ok] packages/desktop/src/main/databaseStartupRelay.ts: 6 blocks, 31 lines
[ok] packages/desktop/src/main/pluginSandbox/session.ts: 6 blocks, 31 lines
[ok] packages/provider/src/config/provider-data-schema.ts: 6 blocks, 31 lines
[ok] packages/shared/src/conversation-share.ts: 7 blocks, 35 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=128
[packages/desktop/src/main/databaseStartupRelay.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/desktop/src/main/pluginSandbox/session.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/provider/src/config/provider-data-schema.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/shared/src/conversation-share.ts] added=35 nonComment=0 starSlash=0 suspicious=0
TOTAL added=128 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.13% code=106 comment=33 packages/provider/src/config/provider-data-schema.ts
31.25% code=112 comment=35 packages/desktop/src/main/databaseStartupRelay.ts
31.30% code=131 comment=41 packages/desktop/src/main/pluginSandbox/session.ts
31.33% code=399 comment=125 packages/shared/src/conversation-share.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/src/main/databaseStartupRelay.ts` | Host 启动状态中继 | 单窗口单绑定、startupId 换代、sequence 单调、ready 一次性广播、控制命令身份校验、退出合成 failed | 31 |
| `desktop/src/main/pluginSandbox/session.ts` | 沙箱会话能力锁定 | 一次性准备、origin 交叉校验、https 仅 shell 脚本、vendor 失败即取消、默认 cancel、权限闸门默认拒绝 | 31 |
| `provider/src/config/provider-data-schema.ts` | Provider 配置契约 | 稀疏与完整成对、sparseShape 展开、strict 边界、必填 issue code、判别联合、Personal 放宽 baseUrl | 31 |
| `shared/src/conversation-share.ts` | 会话分享契约 | 路径解析、code 不解码、版本只升、逐行降级、出站严格入站宽容、能力收窄与错误分类 | 35 |

## 3. 说明

- `databaseStartupRelay.ts` 原 3.57%，块分别锚定旧绑定释放、状态合并、控制命令、退出收尾与释放幂等点；
  未改动任何 IPC 名称或状态机分支。
- `pluginSandbox/session.ts` 原 7.63%，块锚定幂等早退、请求拦截入口、https 分支、资源改写与权限处理器；
  `onBeforeRequest` 的分支顺序在注释中固定下来，避免后续重排导致放行。
- `provider-data-schema.ts` 原 1.89%，块锚定必填串、API Key 访问、智谱账号、API 与 Provider 五处；
  首次插入时有一行以 `type` 开头被自检启发式误判为代码行，已从基线还原后改写措辞重插，最终 `suspicious=0`。
- `conversation-share.ts` 原 22.56%，五个块全部落在函数体内首条语句，避免拆开既有 JSDoc 与签名；
  只补不变量与失败路径，不改任何 schema 字段与 `.strict()` 取舍。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1926 needLines=28232 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1922 needLines=23640
```

累计 1,302 文件 / 124,647 行。
