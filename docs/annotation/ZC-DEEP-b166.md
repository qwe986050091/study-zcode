# ZC-DEEP-B166（4 文件，+147 行）

> 范围：任务分组 hook、账号连接失效通知 hook、工作区钩子审核命令与侧栏远程连接详情（合计 694 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b166\orig`；清单：`ZC-deep-b166-files.txt`。
> 目标密度 31.4%，实际落点 31.03%~31.78%。

## 1. 验收输出

```text
[ok] packages/ui/src/project-sidebar/useTaskGroups.ts: 4 blocks, 37 lines
[ok] packages/ui/src/root/useAccountConnectionLossNotification.ts: 4 blocks, 37 lines
[ok] packages/ui/src/settings/workspaceHookReviewCommands.ts: 4 blocks, 37 lines
[ok] packages/ui/src/WorkspaceSidebar/RemoteProjectConnectionDetails.tsx: 4 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=147
TOTAL added=147 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.54% code=130 comment=41 packages/ui/src/project-sidebar/useTaskGroups.ts
31.78% code=129 comment=41 packages/ui/src/root/useAccountConnectionLossNotification.ts
31.72% code=145 comment=46 packages/ui/src/settings/workspaceHookReviewCommands.ts
31.03% code=116 comment=36 packages/ui/src/WorkspaceSidebar/RemoteProjectConnectionDetails.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/project-sidebar/useTaskGroups.ts` | 任务分组结构快照与写入动作 | 请求序号丢弃过期回包、失败保留旧结构、按宿主分批登记、签名只含事实输入、卸载让在途结果失效 | 37 |
| `packages/ui/src/root/useAccountConnectionLossNotification.ts` | 账号连接失效的一次性通知与切换建议 | 引用读最新值、意图变化先失效、过期事件不出通知、动作幂等、卸载顺序 | 37 |
| `packages/ui/src/settings/workspaceHookReviewCommands.ts` | 钩子信任动作到协议命令的翻译 | 先登记后发送、回执必应用、原因码可选、身份不一致即拒绝、等待有上限、超时专用原因码 | 37 |
| `packages/ui/src/WorkspaceSidebar/RemoteProjectConnectionDetails.tsx` | 侧栏远程工作区连接详情 | 纯展示、模型外部计算、回调全可选、错误详情双条件、连接中禁用、文案走消息键 | 36 |

## 3. 说明

- `useTaskGroups.ts` 的块落在 hook 签名、结构状态与登记签名处，未插入广播回调与分批循环内部。
- `useAccountConnectionLossNotification.ts` 的块落在 hook 签名、首个意图副作用与接受函数处；重复锚点用 `nth: 1` 定位。
- `workspaceHookReviewCommands.ts` 的块落在两个导出函数与信任主入口签名，未进入提示构建与命令载荷。
- `RemoteProjectConnectionDetails.tsx` 的块只落在函数签名与两个派生常量，未插入任何 JSX children。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2058 needLines=32507 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2054 needLines=27915
```

累计 1,170 文件 / 120,117 行。
