# ZC-DEEP-B201（4 文件，+125 行）

> 范围：营销弹窗适配、切分支协助面板状态、OAuth 登录 hook 与手机远控 task 打开流程（合计 464 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b201\orig`；清单：`ZC-deep-b201-files.txt`。
> 目标密度 31.4%，实际落点 31.00%~31.72%。

## 1. 验收输出

```text
[ok] packages/ui/src/components/marketing-touch/marketingPopupAdapter.ts: 6 blocks, 31 lines
[ok] packages/ui/src/git-branch-switcher/switchAssist.ts: 7 blocks, 31 lines
[ok] packages/ui/src/hooks/useOAuth.ts: 7 blocks, 32 lines
[ok] packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts: 6 blocks, 31 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=125
[packages/ui/src/components/marketing-touch/marketingPopupAdapter.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/git-branch-switcher/switchAssist.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/hooks/useOAuth.ts] added=32 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts] added=31 nonComment=0 starSlash=0 suspicious=0
TOTAL added=125 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.00% code=100 comment=31 packages/ui/src/git-branch-switcher/switchAssist.ts
31.40% code=121 comment=38 packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts
31.63% code=98  comment=31 packages/ui/src/components/marketing-touch/marketingPopupAdapter.ts
31.72% code=145 comment=46 packages/ui/src/hooks/useOAuth.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/.../marketingPopupAdapter.ts` | 营销弹窗适配 | 可弹条件、危险节点移除、纯文本取值、按钮与 action 同 key、动作穷尽映射 | 31 |
| `ui/git-branch-switcher/switchAssist.ts` | 切分支协助状态 | issue 早退、allSettled 降级、文件合并去重、stage 并集、身份判定口径 | 31 |
| `ui/hooks/useOAuth.ts` | OAuth 登录 hook | attempt 防串号、解密失败降级边界、finally 收尾、轮询开关、埋点只取 hostname | 32 |
| `ui/hooks/useWebRemoteControlTaskOpen.ts` | 远控 task 打开 | 工作区键、跨区判定、未读即发即忘、切换态复位、断连退回首页 | 31 |

## 3. 说明

- `marketingPopupAdapter.ts` 原为零注释，块锚定可弹出判断、template 解析、按钮映射、actions 表与返回结构。
- `switchAssist.ts` 原为零注释，块锚定列表格式化、身份判定、issue 早退、并发查询、stage 并集与返回结构；
  该文件落到 31.00%，仍在门槛之上，未再加行。
- `useOAuth.ts` 原 9.66%，既有文件头 JSDoc 保留，块全部落在函数体内（含两处 attempt 比较只注释第一处）。
- `useWebRemoteControlTaskOpen.ts` 原 5.79%，块锚定入口、跨区判定、未读分支、切换请求与断连降级；
  既有中文 bugfix 注释未改写。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1918 needLines=27992 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1914 needLines=23400
```

累计 1,310 文件 / 124,897 行。
