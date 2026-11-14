# ZC-DEEP-b118

> 批次：B118（6 文件，按 31.4% 口径目标 263 行，落地 263 行）。
> 逐文件独立 spec、逐份自检后按序插入；单批 6 个文件，按缺口降序选批，优先同目录。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b118`；开工前 6 文件均为 `newComments` 偏低。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，顺延到后续批次。

## 校验

```
node zc-verify.mjs ZC-deep-b118
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=263

node check-batch.mjs ZC-deep-b118 ZC-deep-b118-files.txt
TOTAL added=263 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.08  148   46  43  packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx
31.14  167   52  43  packages/ui/src/settings/AddMarketplaceSourceDialog.tsx
31.21  157   49  43  packages/ui/src/project-sidebar/ProjectNode.tsx
31.36  169   53  45  packages/ui/src/settings/pluginCapabilityProjection.ts
31.39  137   43  43  packages/ui/src/settings/SettingsResourceHeaderActions.tsx
31.40  258   81  46  packages/ui/src/settings/ShortcutSettingsSection.tsx
min=31.08 max=31.40 added=263
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/settings/pluginCapabilityProjection.ts` | 设置页插件、技能与命令的作用域投影和分组 | INV-01~18；未物化过滤；内置排序；名称归一；双组搜索；作用域不再二次归属；名称唯一回退 | 45 |
| `ui/src/settings/ShortcutSettingsSection.tsx` | 快捷键设置分区，展示命令表并提供录制、冲突与重置入口 | INV-01~18；多绑定数组；覆盖优先；保存串行与禁用；追加替换抢绑清除四种语义；键盘独占双通道 | 46 |
| `ui/src/settings/AddMarketplaceSourceDialog.tsx` | 添加插件市场源弹窗，支持地址输入、拖放与目录选择 | INV-01~18；按来源去重；防重入；失败保留输入；平台能力开关；输入法组合态；拖离按容器 | 43 |
| `ui/src/settings/SettingsResourceHeaderActions.tsx` | 设置页资源头部操作区，统一刷新、导入导出与新建入口 | INV-01~18；溢出菜单条件；刷新态；标签覆盖与国际化缺省；可访问名称；测试与埋点 id 注入 | 43 |
| `ui/src/settings/usage-stats/usageStatsUiParts.tsx` | 使用统计页的数值格式化、指标卡与空态展示部件 | INV-01~18；范围两档；非有限数占位；紧凑格式精度；中文摘要间距；UTC 日期解析；卡片尺寸与布局 | 43 |
| `ui/src/project-sidebar/ProjectNode.tsx` | 侧边栏单个项目节点，组合排序、折叠与会话拖入放置 | INV-01~18；在线可编辑；拖入深度计数；捕获阶段清理；失效不折叠；落点同源推导；远端身份单根 | 43 |
