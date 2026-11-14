# ZC-DEEP-B185（4 文件，+132 行）

> 范围：新引导流场渲染器、项目任务导航 hook、Provider 登录入口守卫、待处理交互适配器（合计 466 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b185\orig`；清单：`ZC-deep-b185-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.53%。

## 1. 验收输出

```text
[ok] packages/ui/src/onboarding/onboardingMeshRenderer.ts: 4 blocks, 33 lines
[ok] packages/ui/src/project-sidebar/useProjectTaskNavigation.ts: 4 blocks, 33 lines
[ok] packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts: 4 blocks, 33 lines
[ok] packages/ui/src/v4/pendingInteractionAdapter.ts: 4 blocks, 33 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=132
TOTAL added=132 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=112 comment=35 packages/ui/src/onboarding/onboardingMeshRenderer.ts
31.53% code=111 comment=35 packages/ui/src/project-sidebar/useProjectTaskNavigation.ts
31.30% code=115 comment=36 packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts
31.25% code=128 comment=40 packages/ui/src/v4/pendingInteractionAdapter.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../onboarding/onboardingMeshRenderer.ts` | 引导背景流场 | 无上下文返回空、编译/链接/缓冲逐级清理、尺寸上限与取整、宽高比用逻辑尺寸、释放逆序 | 33 |
| `.../project-sidebar/useProjectTaskNavigation.ts` | 项目任务导航 | 回调稳定引用、最新入参放引用、请求序号自增、当前性多维比较、远控优先、连接前复验 | 33 |
| `.../root/useProviderAvailabilityLoginEntryGuard.ts` | 登录入口守卫 | 未启用视为可用、强制刷新后重读、判定与弹窗同源、启动检查一次、失败也结束门禁 | 33 |
| `.../v4/pendingInteractionAdapter.ts` | v4 交互适配 | 拒绝三态归一、永远允许带精确规则、选项响应优先自带值、来源与展示按需透传、问卷空清单返回空 | 33 |

## 3. 说明

- `onboardingMeshRenderer.ts` 首行为说明注释，header 插在其上；块落在工厂入口、返回对象与 `dispose` 前，着色器源码字符串内部未插入。
- `useProjectTaskNavigation.ts` 的块落在 hook 入口、`isCurrent` 与 `open` 前；既有「同一目录内切换任务」注释保持原样。
- `useProviderAvailabilityLoginEntryGuard.ts` 的块落在 hook 入口、同步判定与启动效果前；两处既有根因注释未动。
- `pendingInteractionAdapter.ts` 首行 `import type {` 与第 7 行重复，header 用 `firstNth: 1`；块落在三个映射函数前。
- 本批 2 次目标行数修正（守卫与适配器各多 1 行），修正后 check 一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1982 needLines=29977 min=0.00 median=31.32
本会话范围 files=4562 coreBelow30=1978 needLines=25385
```

累计 1,246 文件 / 122,805 行。
