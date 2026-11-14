# ZC-DEEP-b5

> 批次：B5。基线快照：`d:\code\_annot_baseline\ZC-deep-b5\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b5
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1803

deep-density --only 三文件
30.01  3455  2589  777  656  packages/ui/src/app-shell/WorkspaceShellLayout.tsx
30.16  2840  2153  660  586  packages/ui/src/SettingsPage.tsx
30.16  2723  1986  599  561  apps/zcode-cli/packages/core/src/subagent/runner.ts
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.01 median=30.16 newComments=1803
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | 工作区壳层布局：侧栏/侧面板/终端/浮窗编排与快捷键路由 | INV-01~20；宽度 ref/state 同步；拖拽期间只写 CSS 变量、pointerup 才 setState；pointerId 与 pointer capture 校验；面板四条件可见性；侧栏与面板正交；resize 仅 window + idle 去抖；fullView 跳过自动收起；浮窗隐藏终端但保留状态；identity 优先于 path；选中任务失败保留当前页；target workspace 绕过只读；远控回落 chat；workspaceKey 回收保活；文件链接 stat 分流；resetKeys 稳定性；监听 cleanup；导航入口统一 | 656 |
| `packages/ui/src/SettingsPage.tsx` | 设置页外壳：section 路由、深链、设置读写、平台能力分支 | INV-01~20；section 懒初始化与 pending 一次性消费；面包屑子覆盖父；插件 origin/scopeKey 成对；Coding Plan 页签 id 编解码；entitlement 缓存 key 含 provider fingerprint；本机 Host 与 workspace services 分离；平台能力差异（Linux 托盘、远程目录选择）；store 两种写回语义（对象 patch / 连续数值）；provider 视图三态；用量来源每帧重查；settings.get 与 system.info 并行、字段归属互斥；非 Linux 不构造能力对象；深链 pending intent | 586 |
| `apps/zcode-cli/packages/core/src/subagent/runner.ts` | 子代理运行器：启动、并发、取消、消息投递、终态与产物落盘 | INV-01~20；registry 注册顺序；AbortController 映射身份比较；readyGate 幂等；Promise.race 三路；后台通知幂等；终态不可二次 finalize；resume 回滚；FIFO 消息队列；活动看门狗；trace 层级；产物写盘顺序；usage/toolUseCount 汇总；allowedTools 解析；写文件失败路径 | 561 |

合计 **1803**，与 `added` 一致。

## 关键不变量（抽取）

- 布局：拖拽中不得触发 React 重渲染，宽度只经 ref + CSS 变量，否则每帧 setState 会让整个 shell 抖动。
- 布局：终端在浮窗下只隐藏不卸载，卸载会丢失 PTY 会话。
- 设置：`workspaceIdentity?.trim() || workspacePath` 是唯一身份 key，缓存/去重/持久化都必须用它。
- 子代理：终态只能 finalize 一次，重复 finalize 会把已结束的 agent 复活成 running。
