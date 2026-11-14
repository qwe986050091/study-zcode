# ZC-DEEP-b111

> 批次：B111（6 文件，按 31.4% 口径目标 275 行，落地 273 行）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b111\orig`；开工前 6 文件均为 `newComments=0`。
> 回调：`TodoPanel.tsx`（32.18%）与 `RemoteSkillSyncSelectionList.tsx`（32.21%）各删 1 行本次新增注释，回到 31.61% / 31.54%。

## 校验

```
node zc-verify.mjs ZC-deep-b111
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=273

node check-batch.mjs ZC-deep-b111 ZC-deep-b111-files.txt
TOTAL added=275 hardBad=0 suspicious=0   （回调前；回调后 zc-verify 记为 273）
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.08  196  148  46  45  packages/ui/src/root/GlobalDatabaseStartupLoading.tsx
31.17  217  154  48  45  packages/ui/src/ToolCallBlocks/renderers/search.tsx
31.21  213  157  49  45  packages/ui/src/v4/ConversationQuotaBanner.tsx
31.25  274  192  60  46  packages/ui/src/settings/mcpSettingsShared.ts
31.54  204  149  47  46  packages/ui/src/settings/RemoteSkillSyncSelectionList.tsx
31.61  237  174  55  46  packages/ui/src/TodoPanel.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.08 median=31.27 newComments=273
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/root/GlobalDatabaseStartupLoading.tsx` | 数据库启动加载界面 | INV-01~18；可见性；计时清理；复制反馈；标签推导 | 45 |
| `ui/src/settings/mcpSettingsShared.ts` | MCP 配置与表单互转 | INV-01~18；超时保留；类型推断；JSON 双形态；版本守卫 | 46 |
| `ui/src/settings/RemoteSkillSyncSelectionList.tsx` | 远程技能同步候选列表 | INV-01~18；整卡命中判定；本地展开集合；无障碍关联 | 46 |
| `ui/src/TodoPanel.tsx` | 任务计划面板 | INV-01~18；早退条件；活动步骤推导；两套状态样式；头部交互 | 46 |
| `ui/src/ToolCallBlocks/renderers/search.tsx` | 检索类工具卡 | INV-01~18；摘要回退链；选择语法；单行截断；快照提示开关 | 45 |
| `ui/src/v4/ConversationQuotaBanner.tsx` | 会话额度告警横幅 | INV-01~18；视口上报；文案键细分；数值夹取；折扣徽标 | 45 |
