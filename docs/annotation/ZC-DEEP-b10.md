# ZC-DEEP-b10

> 批次：B10。基线快照：`d:\code\_annot_baseline\ZC-deep-b10a\orig`、`ZC-deep-b10b\orig`（两个子批并行，合并校验见下）。

## 校验

```
node zc-verify.mjs ZC-deep-b10a
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=896

node zc-verify.mjs ZC-deep-b10b
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=933

deep-density --only b10a
30.22  2045  1532  463  425  packages/desktop/src/main/desktopRemoteSessions.ts
32.39  2619  1809  586  471  packages/desktop/src/main/autoUpdater.ts
SUMMARY files=2 coreBelow30=0 needLines=0 min=30.22 median=31.31 newComments=896
PASS: all 2 file(s) >= 30% (mode=code)

deep-density --only b10b
30.94  1883  1393  431  427  packages/ui/src/settings/ExternalAgentImportDialog.tsx
35.63  2417  1670  595  506  packages/shared/src/validation.ts
SUMMARY files=2 coreBelow30=0 needLines=0 min=30.94 median=33.28 newComments=933
PASS: all 2 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/main/autoUpdater.ts` | 桌面自动更新：检查、下载、待安装状态机与菜单/渲染进程广播 | INV-1~20；menuState 唯一写入口；check 互斥覆盖请求+结果处理；check 收口按 checkId 校验世代；ready 只由真正下载完成写入；pending 与取消 token 同生共死；quitAndInstall 单向状态机 recovering 为终态；安装准入校验 ready 版本等于当前目标；recovering 时失败回调短路；下载失败回退 available 并保留元数据；取消需同时标记与 token.cancel 并吞掉迟到错误；取消错误配额只被同语义消耗；available/downloading/ready 三组字段互斥；渠道刷新在 check 中只登记 pending；stale 只比较启动时锁定的渠道 | 471 |
| `packages/desktop/src/main/desktopRemoteSessions.ts` | 桌面远控会话注册表：路由、attachment、建连与重连 | INV-1~16；routesBySessionId 是唯一权威注册表；webContentsId 是所有权边界；attachmentState 单向 closed 不可复活；pendingRendererAttachment 单槽需 supersede；确认 ready 必须三元匹配；handleConnected 精确匹配 pending；同 sessionId 并发 connect 等待同一 route；mobileOnly 桌面 join 前不建 attachment；connectFinalized 只允许一次；建连失败必须三件事同做；providerProvisioningDispose 与 route 同生命周期；重连换代先删旧键再写新键；bind flight 按 sessionId 去重且 contextKey 不同拒绝；bind 期间不更新 descriptor | 425 |
| `packages/ui/src/settings/ExternalAgentImportDialog.tsx` | 外部 Agent 资源导入弹窗：扫描、选择、导入三态 | INV-1~16；step 三态固定流向；selectedKeys 是选择唯一真相；资源 key 为四元组 JSON；activeScope 与 importTargetScope 独立；importMode 仅对 skills/commands/plugins 生效；detect 失败必须落空数组避免重试风暴；自动扫描三重条件守护单飞；导入成功先落定结果再 await 回调；失败回 selection 且不清选择；重置只发生在 open=true；importProgress 是前端估算；仅 importable 可勾选且不计分母；全选只作用于当前 scope；project 目标依赖 workspacePath | 427 |
| `packages/shared/src/validation.ts` | 共享 zod 校验 schema：协议消息与路径/标识符边界 | INV-1~18；schema 只管形状不管业务可用性；固定字段集用 strict、向前兼容不用；可选字段用 optional 不用 default；nullable 与 optional 不可互换；id/路径统一 nonEmptyStringSchema；长度上限取 PROTOCOL_V4_LIMITS；进入 URL/帧头/文件名的 id 加字符白名单；时间戳与度量用 finite；计数用 int 非负；路径不做归一化；枚举用 z.enum；判别字段互斥唯一；union 严格形状在前；跨字段 refine 显式处理 undefined | 506 |

合计 **1829**（896 + 933），与两次 `added` 之和一致。

## 关键不变量（抽取）

- 更新器：ready 只能由真正下载完成写入；半包被当可安装会让升级后的应用起不来。
- 更新器：check 收口必须按 checkId 校验世代，否则迟到的旧检查会清掉新 in-flight，出现并发检查。
- 远控会话：建连失败必须三件事同做（dispose 登记、删 route、通知 Host 释放），否则留下半注册状态。
- 导入弹窗：detect 失败也必须落 `{ agents: [] }`，保留旧结果会形成失败重试风暴。
- 校验：路径不做归一化——折叠大小写/分隔符会把 Windows 上两个真实目录误合为一个。

## 进度

本批前：4 文件全部 below30（min 0.29%、needLines=1676）。
本批后：4 文件全部 ≥30%（min 30.22%、needLines=0）。
