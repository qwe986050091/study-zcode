# ZC-DEEP-b39

> 批次：B39（12 文件；含 B38 全部 7 个顺延文件，再补 5 个）。
> B39-A：`ui` 6 文件（+637 行）；B39-B：`ui` 3 + `bootstrap` 1 + `cli` 1 + `office-runtime` 1（+650 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b39\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b39
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1287

node check-batch.mjs ZC-deep-b39 ZC-deep-b39a-files.txt
TOTAL added=637 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b39 ZC-deep-b39b-files.txt
TOTAL added=650 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.27   540   371  116  106  packages/ui/src/lib/taskChangeSummary.ts
31.27   506   355  111  105  packages/ui/src/lib/askUserQuestion.ts
31.33   792   581  182  109  apps/zcode-cli/packages/cli/src/prompt-command.ts
31.33   903   664  208  110  apps/zcode-cli/packages/office-runtime/ui/viewers/PdfView.tsx
31.33   507   383  120  107  packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx
31.34   674   501  157  108  packages/ui/src/v4/V4WorkspaceChatArea.tsx
31.36   572   405  127  106  packages/ui/src/components/ui/pdf-viewer.tsx
31.36   625   456  143  109  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-session-query.ts
31.36   469   338  106  106  packages/ui/src/WhiteboardPane.tsx
31.38   463   341  107  106  packages/ui/src/git-graph/GitGraphPane.tsx
31.43   620   455  143  108  packages/ui/src/store/pluginManagementStore.ts
31.53   498   352  111  107  packages/ui/src/lib/assistantPreviewCards.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.27 median=31.35 newComments=1287
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（`needLines=1223`）；`zc-verify` 的 `added=1287`
与两组子批合计（637 + 650）一致。首轮有 3 处 `suspicious`（中文句以 `type` / `catch` 开头），
已就地改写为中文表述，行数不变，重跑后归零。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/WhiteboardPane.tsx` | 白板画布与笔画草稿 | INV-01~15；指针捕获与草稿生命周期；DPR 与坐标换算；全量重绘与尺寸重置；workspace 分仓 key；命名双向草稿；撤销栈提交时序 | 106 |
| `ui/src/git-graph/GitGraphPane.tsx` | Git 提交图泳道渲染 | INV-01~20；泳道配色表同序同长；列宽模板单一来源；`graphColumnWidth` 与 viewBox 同源；布局缓存按 commits 引用；触底加载 96px 阈值三道早退；重复上报幂等 | 106 |
| `ui/src/lib/assistantPreviewCards.ts` | 助手预览卡片构建 | INV-01~20；localhost/file 白名单安全校验；远控抑制时机；改动列表同名歧义；路径归一化去重；卡片 ID 与去重键口径；候选上限截断顺序 | 107 |
| `ui/src/lib/askUserQuestion.ts` | 提问卡片解析与归一 | INV-01~16；题目与选项归一；自定义输入启发式；答案解析多级回退；单题/多题结构兼容；id 兜底下标 | 105 |
| `ui/src/lib/taskChangeSummary.ts` | 任务变更摘要聚合 | INV-01~18；摘要 null 语义；首末快照聚合与增删口径；写入次数累加；轮次索引取大；plan mode 幽灵文件跳过；patch 顺序与空补丁；Windows 大小写降级 | 106 |
| `ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx` | 文件树行视图 | INV-01~18；deleted 虚拟行提前返回；单击与双击语义；`remoteTarget`/`workspaceIdentity` 透传；目录加载中隐藏 Git 圆点；拖拽双 MIME 成对同步；WSL 复用编辑器通道 | 107 |
| `ui/src/components/ui/pdf-viewer.tsx` | 通用 PDF 预览组件 | INV-01~14；worker 顶层绑定；256KiB range 分段与 `length` 语义；cMap 资源；ArrayBuffer 复制防 detached；双倍率缩放；旧渲染回调按倍率丢弃；非 passive 滚轮 | 106 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-session-query.ts` | 子代理会话查询协议 | INV-01~20；工具名白名单；agentId/childSessionId 取值优先级；spawn/stop 按 parentToolCallId 浅合并；活动分支过滤；running 判定顺序；游标编解码失败降级 | 109 |
| `ui/src/store/pluginManagementStore.ts` | 插件管理 store | INV-01~16；四元上下文清场；error 归属；诊断式失败契约；describe 缓存身份与并发锁；scoped store 生命周期 | 108 |
| `ui/src/v4/V4WorkspaceChatArea.tsx` | V4 工作区聊天区 | INV-01~19；布局三源切换；primary 会话置空；群组提升事务；关闭顺序；拖动占比走 CSS 变量；叶子挂载与 focus 守卫 | 108 |
| `apps/zcode-cli/packages/cli/src/prompt-command.ts` | CLI prompt 命令 | INV-01~20；slash 命令按可解析性分流；事件单一写者；closeApp 幂等与分步超时回收；stream-json 终止符；多回合 response 取尾；abort 迟到实例释放 | 109 |
| `apps/zcode-cli/packages/office-runtime/ui/viewers/PdfView.tsx` | Office PDF 查看器 | INV-01~18；slots/sizes 下标不变量；generation 淘汰旧渲染；worker 与文档回收；文字层 CJK 归一；Range 重挂；三层高亮；1-based 页码越界抛错；外链安全过滤 | 110 |

合计 **1,287**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 预览卡片的 URL 白名单是安全边界，不是格式校验

`assistantPreviewCards.ts` 只允许 `localhost` 与 `file` 协议的本地预览地址通过。
放宽成「看起来像 URL 就放行」后，模型输出里的外部地址会被直接嵌进预览 iframe，
表现是卡片在无提示的情况下向第三方发起请求，并携带本地会话上下文。

### 2. PDF range 请求传的是长度不是结束偏移

两个 PDF 组件都把 `end - begin` 传给 `requestRange`。误传 `end` 会让请求长度翻倍并越过文件末尾，
症状不是立刻报错，而是反复重试或长时间停在加载骨架——排查时最容易归因到网络。

### 3. 排版与渲染倍率必须分离

`pdf-viewer.tsx` 区分 `displayScale`（布局）与 `renderScale`（位图），旧渲染回调按倍率丢弃。
合并成一个倍率后，缩放过程中的中间帧会以错误倍率落盘，出现文字层与位图错位、越放大越模糊。

### 4. 变更摘要的 null 与空数组语义不同

`taskChangeSummary.ts` 里 `null` 表示「没有快照信息」，空数组表示「确认无改动」。
把 `null` 折成 `[]` 会让从未采集过快照的任务显示「无改动」，用户据此判断任务没动过文件。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 预览 URL 白名单放宽 | 卡片向外部地址发请求，泄露本地会话上下文 |
| PDF range 传 end 而非长度 | 反复重试或长期停在加载骨架 |
| 布局倍率与渲染倍率合一 | 缩放时文字层与位图错位 |
| 旧渲染回调不按倍率丢弃 | 快速缩放后画面回跳 |
| 摘要 null 折成空数组 | 未采集快照的任务显示「无改动」 |
| 游标解码失败直接抛错 | 子代理会话列表整页打不开 |
| 插件 describe 缓存不校验身份 | 切换工作区后显示上一个工作区的插件信息 |
| 拖拽只设一个 MIME | 跨窗口拖拽被目标端判为无效数据 |
| 文件树 deleted 行不早退 | 点击已删除条目触发打开不存在文件 |
| 泳道配色表与列数不同步 | 新增泳道后颜色错位，图例与线条不符 |

## 顺延

B39 复算清单为 19 文件，本批取 12 个（含 B38 全部 7 个顺延），其余 7 个顺延到 B40（缺口各 101 行）：
`apps/zcode-cli/packages/telemetry/src/bootstrap.ts`、
`packages/provider/src/resolver.ts`、
`packages/server/src/source-server/transportAdapter.ts`、
`packages/shared/src/zcodeEndpoint.ts`、
`packages/ui/src/app-shell/SidePaneTabTrigger.tsx`、
`packages/ui/src/gen-ui/adapters/page.ts`、
`packages/ui/src/hooks/useRemoteConnectionForm.ts`。

> 说明：每文件独立 spec（≤150 行），5 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 3 处 `suspicious` 已就地改写修正。
