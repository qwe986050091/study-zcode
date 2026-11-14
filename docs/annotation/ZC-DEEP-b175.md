# ZC-DEEP-B175（4 文件，+138 行）

> 范围：侧栏套餐升级入口推导、导航历史栈、记忆更新时间格式化与机器人绑定群 hook（合计 524 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b175\orig`；清单：`ZC-deep-b175-files.txt`。
> 目标密度 31.4%，实际落点 31.09%~31.82%。

## 1. 验收输出

```text
[ok] packages/ui/src/lib/sidebarCodingPlanUpgrade.ts: 5 blocks, 34 lines
[ok] packages/ui/src/lib/taskNavigationHistory.ts: 5 blocks, 35 lines
[ok] packages/ui/src/settings/memoryUpdatedAt.ts: 5 blocks, 35 lines
[ok] packages/ui/src/hooks/useBotBoundGroups.ts: 5 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=138
TOTAL added=138 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.09% code=119 comment=37 packages/ui/src/lib/sidebarCodingPlanUpgrade.ts
31.49% code=181 comment=57 packages/ui/src/lib/taskNavigationHistory.ts
31.82% code=110 comment=35 packages/ui/src/settings/memoryUpdatedAt.ts
31.58% code=114 comment=36 packages/ui/src/hooks/useBotBoundGroups.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/lib/sidebarCodingPlanUpgrade.ts` | 推导升级入口指向的提供方 | 家族回退、词元边界匹配、终态与顶级识别、认证与原因白名单、选择优先级 | 34 |
| `packages/ui/src/lib/taskNavigationHistory.ts` | 工作区导航前进后退栈 | 身份含工作区隔离键、相邻去重、上限与指针偏移、删除只删任务条目、指针夹取 | 35 |
| `packages/ui/src/settings/memoryUpdatedAt.ts` | 记忆更新时间格式化 | 无效时间归刚刚、分钟相对值、本地日界与周一、跨年补年份、固定二十四小时制 | 35 |
| `packages/ui/src/hooks/useBotBoundGroups.ts` | 机器人绑定群读取与开关 | 归属过滤、主题聚合去重、代次防迟到、保存在途锁、写入后读权威状态 | 34 |

## 3. 说明

- `sidebarCodingPlanUpgrade.ts` 的块落在接口、家族回退、终态判断与提供方选择函数签名前，过滤与查找回调体未插入。
- `taskNavigationHistory.ts` 首行 `/**` 在文件内重复（删除函数上方还有一处），规格加 `firstNth: 1`。
- `memoryUpdatedAt.ts` 的块落在常量、当天起点、主入口与时间格式化函数前，日期分支体保持零改动。
- `useBotBoundGroups.ts` 的块落在行接口、投影函数、hook 入口与切换回调前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2022 needLines=31289 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2018 needLines=26697
```

累计 1,206 文件 / 121,435 行。
