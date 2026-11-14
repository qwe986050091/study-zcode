# ZC-DEEP-b50

> 批次：B50（12 文件，复算缺口 980 行；按当前工作树复算，优先同类/同目录：`ui/src` 9 个（含 `components/ai-elements` 2 个、`feedback`、`v4`、`lib`、`remote-connection`、`settings/saved-workflows`、`coding-plan-quota-reset`）、`apps/zcode-cli` 2 个、`ui/src/settingsCodePreview.tsx`）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b50\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b50
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1033

node check-batch.mjs ZC-deep-b50 ZC-deep-b50-files.txt
TOTAL added=1033 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   438   288    90   84  packages/ui/src/components/ai-elements/commit.tsx
31.29   387   278    87   85  packages/ui/src/lib/pptxElementReference.ts
31.31   429   297    93   84  packages/ui/src/v4/conversationTurnNavigatorHelpers.ts
31.36   392   287    90   84  packages/ui/src/feedback/feedbackTimeline.tsx
31.37  1247   915   287   94  apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts
31.40   392   293    92   86  packages/ui/src/remote-connection/EditConnectionProfileDialog.tsx
31.40   453   328   103   85  packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.tsx
31.42   440   331   104   86  apps/zcode-cli/packages/tui/src/app-view.tsx
31.43   410   280    88   86  packages/ui/src/components/ai-elements/environment-variables.tsx
31.48   414   305    96   86  packages/ui/src/settings/saved-workflows/useSavedWorkflowGlobalGroup.ts
31.50   366   273    86   86  packages/ui/src/settingsCodePreview.tsx
31.55   459   336   106   87  packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.25 median=31.40 newComments=1033
PASS: all 12 file(s) >= 30% for mode=code
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/settingsCodePreview.tsx` | 设置页代码预览 | INV-01~19；浅/深两套主题取值成对出现；`zai-*` 与 `system` 的生效侧徽标只读；行号与换行开关透传给预览器；字号上下界与硬编码 12/20 的漂移风险；draft 与提交时序、NaN 走失败分支；Partial 更新避免旧闭包覆盖新值 | 86 |
| `ui/components/ai-elements/environment-variables.tsx` | 环境变量列表与展示 | INV-01~20；敏感值默认遮蔽、显隐只存布尔不落盘；受控与内部状态双写顺序固定；遮蔽态禁止选中复制；三种复制格式的出口转义；剪贴板缺失与写失败两条失败路径；重置定时器句柄覆盖与卸载清理；错误对象不得携带明文 | 86 |
| `ui/lib/pptxElementReference.ts` | PPTX 元素引用编解码 | INV-01~20；编码与解码严格对称；非法引用返回 null 而非抛错；slide 与 shape 编号边界；空白与大小写归一；引用字符串格式稳定；去重键顺序无关；提示词拼装与解析互逆 | 85 |
| `ui/remote-connection/EditConnectionProfileDialog.tsx` | 连接配置编辑弹窗 | INV-01~20；编辑态从 props 初始化一次、打开时重置；提交中整表单禁用；URL 与端口在提交前校验；密码字段不回显；脏检查与放弃确认；Esc 与遮罩关闭同级；错误只保留最近一条；保存成功才关闭 | 86 |
| `ui/components/ai-elements/commit.tsx` | 提交信息卡片 | INV-01~18；hash 只作文本不自动成链；author/time 必填、Invalid Date 会抛错；`count <= 0` 不渲染计数；文件状态双表一一对应且区分明暗色；整行点击只切展开不做路由跳转；路径截断而消息不截断；asChild 保持键盘可达 | 84 |
| `ui/feedback/feedbackTimeline.tsx` | 反馈事件时间线 | INV-01~20；事件按时间升序、同毫秒用稳定次序；`comment_id` 去重并兼容旧数据；id 前缀保证 key 唯一；事件类型到图标与颜色映射单点化；空时间线占位；长文本折行；相对时间与单步耗时退化路径；附件 href 与图片判定 | 84 |
| `ui/v4/conversationTurnNavigatorHelpers.ts` | 轮次导航纯函数 | INV-01~20；纯函数、不改入参；空数组与单元素边界；索引越界返回 null 不抛错；id 到索引映射与数组同源；返回值不可变；排序稳定；去重保留首次出现 | 84 |
| `ui/settings/saved-workflows/useSavedWorkflowGlobalGroup.ts` | 全局工作流分组 hook | INV-01~20；返回值引用稳定；loading 与 error 互斥；请求代际递增、旧响应丢弃；空分组与未分组语义区分；本地与全局合并优先级固定；effect 依赖完整；卸载后不再 setState；重试幂等 | 86 |
| `apps/zcode-cli/packages/tui/src/app-view.tsx` | TUI 主视图 | INV-01~18；终端 resize 触发重排且保留焦点；面板间焦点转移不丢失；快捷键优先级固定；审批层压在普通面板之上；只读模式回调置空；覆盖层顺序稳定；状态行互斥；订阅在卸载时停订 | 86 |
| `ui/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.tsx` | 配额重置弹窗 | INV-01~19；不可逆操作只走单一入口并有全局单飞锁；提交中所有行禁用；两级延时与收起时序；重开清理旧定时器；展示集合纯派生；失败保留弹窗可重试；单时钟 `now` 与 interval 生命周期；进度条 0/100 钳制 | 85 |
| `ui/browser-use/ResponsiveBrowserViewport.tsx` | 响应式浏览器视口 | INV-01~19；`visualScale` 纯派生；视口尺寸提交顺序固定；rAF 合流避免一帧多次 setState；resize 结束按逆序释放；指针捕获抢占与失败回退；坐标除以 `rendererScale`；容器 0 尺寸不渲染；ResizeObserver 断开与 blur 兜底 | 87 |
| `core/runtime/methods/subagent.ts` | 子代理执行方法 | INV-01~19；父子会话 id 绑定；事件转发顺序固定且只镜像一次；子代理结果只回父一次；取消级联与收尾顺序；资源释放与孤儿清理；递归深度与并发上限截断；权限只收紧不放宽；resume 与落库闸门；token 与成本归属 | 94 |

合计 **1,033**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 子代理结果只回父一次

`subagent.ts` 在子 runtime 的终态回调里投递结果，并在投递前把一次性标记置位。
若标记缺失，子代理的取消与正常结束会各投递一次，父会话看到重复结论，工作项面板出现重复行。

### 2. 请求代际必须单调递增

`useSavedWorkflowGlobalGroup.ts` 每次刷新自增 `refreshSeq`，回填前比对当前代。
少这一比，快速切换分组时旧分组的列表会覆盖新分组，用户看到的是上一个分组的条目。

### 3. 遮蔽态不可选中复制

`environment-variables.tsx` 对遮蔽值加 `select-none`，避免用户无意复制到占位字符后粘贴。
去掉后用户会把 `••••` 当成真实密钥贴进配置，鉴权失败且难以定位。

### 4. 引用编解码必须互逆

`pptxElementReference.ts` 的编码与解析共享同一份字段定义与转义规则。
任何一侧单独改字段名或转义，都会让已插入提示词的引用在下一次解析时全部失效。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 子代理结果投递无一次性标记 | 父会话收到重复结论，工作项重复渲染 |
| 全局分组刷新不回填代际 | 切换分组后显示上一个分组的内容 |
| 环境变量遮蔽值可选中 | 用户把占位符当密钥粘贴，鉴权失败 |
| PPTX 引用只改一侧编解码 | 已插入提示词的引用集体失效 |
| 连接弹窗提交中未禁表单 | 重复保存产生两条同名配置 |
| 提交卡片把 hash 自动成链 | 点击整行跳出应用，打断对话 |
| 时间线用下标做 key | 新事件插入后旧节点的展开状态错位 |
| 导航 helper 越界抛错 | 空会话下按上下键直接白屏 |
| TUI resize 后不恢复焦点 | 用户输入落入错误面板 |
| 配额重置没有单飞锁 | 连点触发多次不可逆核销 |
| 视口 rAF 未合流 | 拖拽时每帧多次 setState，主线程掉帧 |
| ResizeObserver 未断开 | 弹窗反复开关后内存与回调持续累积 |

## 顺延

B50 复算清单共 20 个候选，本批按同类同目录取 12 个，其余 8 个顺延到 B51，开工前用更新后的工作树重新测量后确定：

- `apps/zcode-cli/packages/i18n/src/types.ts`（89）
- `packages/stream-animate/src/server/deepseekRunner.ts`（88）
- `apps/zcode-cli/packages/bootstrap/src/plugins.ts`（86）
- `packages/e2e-report/src/viewer/App.tsx`（86）
- `packages/desktop/src/main/localTtftExporter.ts`（85）
- `apps/zcode-cli/packages/node-repl-host/src/server.ts`（84）
- `apps/zcode-cli/packages/adapters/src/mcp/index.ts`（83）
- `packages/zcode-server-cli/src/server-core/http.ts`（83）

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.25%~31.55%。
