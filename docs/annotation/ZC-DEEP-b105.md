# ZC-DEEP-b105

> 批次：B105（6 文件，按 31.4% 口径目标 283 行，实际 +283）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b105\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b105
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=283

node check-batch.mjs ZC-deep-b105 ZC-deep-b105-files.txt
TOTAL added=283 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.21  225  157  49  46  packages/ui/src/lib/toolCallTree.ts
31.25  268  192  60  47  packages/ui/src/components/TaskTitleOverflowText.tsx
31.25  248  176  55  47  packages/ui/src/global-notice/globalNoticeStore.ts
31.37  291  204  64  47  packages/ui/src/app-shell/useAppChromeState.ts
31.40  354  258  81  48  packages/ui/src/highspeed/highspeedShare.ts
31.43  309  210  66  48  packages/ui/src/mentions/mentionMarkdown.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.21 median=31.31 newComments=283
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/app-shell/useAppChromeState.ts` | 应用外壳状态与更新就绪监听 | INV-01~18；像素值兜底；legacy ready 版本；订阅清理幂等 | 47 |
| `ui/src/components/TaskTitleOverflowText.tsx` | 任务标题溢出滚动文本 | INV-01~18；溢出测量；遮罩关键帧；跑马灯调度与取消 | 47 |
| `ui/src/global-notice/globalNoticeStore.ts` | 全局通知存储 | INV-01~18；通知信封；遗留模拟数据过滤；持久化与可见性 | 47 |
| `ui/src/highspeed/highspeedShare.ts` | 高速模式分享卡片 | INV-01~18；分享资格；加速比与节省比例；SVG 光栅化；payload 解析 | 48 |
| `ui/src/lib/toolCallTree.ts` | 工具调用树构建与复用 | INV-01~18；深度相等预算；渲染相等判定；父链折叠；引用复用 | 46 |
| `ui/src/mentions/mentionMarkdown.ts` | mention Markdown 序列化与解析 | INV-01~18；目标路径规范化；标签转义；内联 token；plugin stable id | 48 |
