# ZC-DEEP-B194（4 文件，+128 行）

> 范围：配额重置机会徽标、当前会话提交范围、远端插件同步刷新与主活动判定（合计 627 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b194\orig`；清单：`ZC-deep-b194-files.txt`。
> 目标密度 31.4%，实际落点 31.03%~31.68%。

## 1. 验收输出

```text
[ok] packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.tsx: 4 blocks, 32 lines
[ok] packages/ui/src/git-action-menu/currentSessionFileScope.ts: 4 blocks, 32 lines
[ok] packages/ui/src/lib/remotePluginSyncRefresh.ts: 4 blocks, 32 lines
[ok] packages/ui/src/lib/taskMainActivity.ts: 4 blocks, 32 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=128
TOTAL added=128 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.15% code=122 comment=38 packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.tsx
31.68% code=101 comment=32 packages/ui/src/git-action-menu/currentSessionFileScope.ts
31.03% code=116 comment=36 packages/ui/src/lib/remotePluginSyncRefresh.ts
31.37% code=102 comment=32 packages/ui/src/lib/taskMainActivity.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.tsx` | 配额重置入口 | 倒计时非负、惰性初值、单机会定时器、受控合并、文案同源、两种形态返回 | 32 |
| `git-action-menu/currentSessionFileScope.ts` | 提交范围裁剪 | 路径归一、空路径回退、前缀裁剪、大小写兜底、三种路径命中、无范围放行 | 32 |
| `lib/remotePluginSyncRefresh.ts` | 远端插件同步 | 空路径早退、标识归一、三段串行、归属一致才写回、失败只记日志、通知投影 | 32 |
| `lib/taskMainActivity.ts` | 主活动判定 | 空批次激活、事件分支、主代理归属、时间线占位排除、忙碌优先级 | 32 |

## 3. 说明

- `CodingPlanQuotaResetOpportunity.tsx` 的块落在组件签名、文案派生与弹框分支前；既有倒计时与可见性注释未动。
- `currentSessionFileScope.ts` 原为零注释，块落在归一函数、裁剪函数与导出过滤入口前；正则与集合逻辑保持原样。
- `remotePluginSyncRefresh.ts` 的块落在命令刷新、同步入口与技能刷新调用前；既有命令面板补写注释未动。
- `taskMainActivity.ts` 原为零注释，块落在事件判定、消息判定与忙碌判定函数前；`switch` 分支保持原样。
- 本批 4 份 spec 均一次 check 通过，所有锚点经计数确认唯一。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1946 needLines=28842 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1942 needLines=24250
```

累计 1,282 文件 / 123,997 行。
