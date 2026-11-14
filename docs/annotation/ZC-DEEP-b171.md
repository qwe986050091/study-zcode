# ZC-DEEP-B171（4 文件，+142 行）

> 范围：套餐状态动作、模型草稿 hook、设置顶栏面包屑与账号连接失效建议（合计 648 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b171\orig`；清单：`ZC-deep-b171-files.txt`。
> 目标密度 31.4%，实际落点 31.15%~31.54%。

## 1. 验收输出

```text
[ok] packages/ui/src/settings/model-provider-section/CodingPlanStatusActions.tsx: 4 blocks, 35 lines
[ok] packages/ui/src/settings/model-provider-section/useProviderModelDraft.ts: 4 blocks, 35 lines
[ok] packages/ui/src/settings/SettingsHeaderBreadcrumb.tsx: 4 blocks, 36 lines
[ok] packages/ui/src/root/accountConnectionLossSuggestion.ts: 4 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=142
TOTAL added=142 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.45% code=124 comment=39 packages/ui/src/settings/model-provider-section/CodingPlanStatusActions.tsx
31.15% code=122 comment=38 packages/ui/src/settings/model-provider-section/useProviderModelDraft.ts
31.54% code=130 comment=41 packages/ui/src/settings/SettingsHeaderBreadcrumb.tsx
31.54% code=130 comment=41 packages/ui/src/root/accountConnectionLossSuggestion.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../model-provider-section/CodingPlanStatusActions.tsx` | 套餐卡片登录、断开与升级动作 | 登录三条件、已购买禁断、两个加载态独立、点击只切面板、折扣高亮仅未展开 | 35 |
| `.../model-provider-section/useProviderModelDraft.ts` | 添加与编辑共用的模型草稿 | 作用域同生共死、代次丢弃过期恢复、解析缺失即抛错、仅按需等待基线 | 35 |
| `packages/ui/src/settings/SettingsHeaderBreadcrumb.tsx` | 设置子页路径投影到顶栏 | 注销按版本授权、报告函数身份稳定、签名只覆盖文案、无动作项退化为文本 | 36 |
| `packages/ui/src/root/accountConnectionLossSuggestion.ts` | 连接失效时的套餐切换建议 | 只建议不落盘、原始连接仍须不可用、连接键防重连、团队按组织项目精确查询、写入带前置条件 | 36 |

## 3. 说明

- 两个 `.tsx` 文件的块只落在组件签名与局部常量，未进入任何 JSX children。
- `useProviderModelDraft.ts` 的块落在 hook 签名、作用域纠正分支与提交函数入口。
- `SettingsHeaderBreadcrumb.tsx` 的块落在接口、提供方与报告者签名，未插入渲染分支。
- `accountConnectionLossSuggestion.ts` 的块落在入口签名、原始校验函数与候选声明处。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2038 needLines=31822 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2034 needLines=27230
```

累计 1,190 文件 / 120,862 行。
