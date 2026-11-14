# ZC-DEEP-b120b

> 批次：B120b（2 文件，按 31.4% 口径目标 85 行，落地 85 行）。
> 本批为 B120 拆分后的第二子批，逐文件独立 spec、逐份自检后按序插入。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b120b`。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，顺延到后续批次。

## 校验

```
node zc-verify.mjs ZC-deep-b120b
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=85

node check-batch.mjs ZC-deep-b120b ZC-deep-b120b-files.txt
TOTAL added=85 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.11  135   42  42  packages/ui/src/BotsDialog/shared.tsx
31.62  136   43  43  packages/ui/src/components/ui/input-group.tsx
min=31.11 max=31.62 added=85
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/BotsDialog/shared.tsx` | 机器人设置弹窗共享类型、常量与展示工具 | INV-01~18；工作区空列表语义；共享有效期常量；双域名状态；渠道图标回退；运行文案与分色；倒计时取整 | 42 |
| `ui/src/components/ui/input-group.tsx` | 输入组容器与附加区、按钮、输入控件封装 | INV-01~18；分组角色；数据槽；焦点与非法态传染；块级纵向；附加区点击不抢焦点；四档按钮尺寸 | 43 |
