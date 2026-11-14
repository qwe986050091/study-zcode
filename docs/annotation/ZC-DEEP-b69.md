# ZC-DEEP-b69

> 批次：B69（12 文件，按 31.4% 口径计算目标 762 行，实际 +762，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b69\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=727）。

## 校验

```
node zc-verify.mjs ZC-deep-b69
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=762

node check-batch.mjs ZC-deep-b69 ZC-deep-b69-files.txt
TOTAL added=762 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   268   202    63   63  packages/ui/src/components/cloud-content-dialog/CloudDialogMediaHero.tsx
31.19   286   202    63   63  packages/ui/src/v4/conversationFindIndex.ts
31.22   288   205    64   62  packages/shared/src/subagent-profile-parser.ts
31.30   528   393   123   65  packages/ui/src/app-shell/WorkflowRunSidePaneSections.tsx
31.30   322   230    72   64  packages/web/src/share/conversationSharePreviewClient.ts
31.33   351   249    78   64  packages/ui/src/lib/zcodeUiError.ts
31.37   281   204    64   63  packages/ui/src/ToolCallBlocks/renderers/send-message.tsx
31.38   392   290    91   64  apps/zcode-cli/packages/adapters/src/browser/page-command.ts
31.49   340   235    74   64  packages/ui/src/v4/highspeed/HighSpeedDiffusionCanvas.tsx
31.50   356   254    80   63  apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-sources.ts
31.50   281   200    63   63  packages/desktop/src/main/aboutWindow.ts
31.53   288   203    64   64  packages/ui/src/ToolCallBlocks/renderers/skill.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.19 median=31.35 newComments=762
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/components/cloud-content-dialog/CloudDialogMediaHero.tsx` | 云内容弹窗媒体 Hero | INV-01~18；图片/视频/Lottie 三分支持续保持容器尺寸稳定；类型判别只看 kind 不做嗅探；加载失败降级为占位而非塌陷；Lottie 播放器只在可见时初始化；卸载必须停播并释放 | 63 |
| `ui/lib/zcodeUiError.ts` | 错误归一化 | INV-01~18；任意输入都收敛成单一 ZCodeUiError；业务码与追踪号只在存在时透出；文案取值优先级固定；未知形状不得抛出；归因字段不参与展示判定 | 64 |
| `ui/ToolCallBlocks/renderers/send-message.tsx` | send_message 详情面板 | INV-01~18；只做展示投影不写状态；多来源快照合并顺序固定；缺失字段降级为空而不是 undefined；状态标签只由结果判定 | 63 |
| `ui/ToolCallBlocks/renderers/skill.tsx` | 技能调用渲染器 | INV-01~18；技能名与参数分别归一；输入缺失时退回工具名；详情文本只从输出提取；空内容不渲染空面板 | 64 |
| `ui/v4/conversationFindIndex.ts` | 会话全文搜索索引 | INV-01~18；查询先归一化再比较；命中按全局顺序而非分片顺序；稳定 key 与片段双路回找必须一致；空查询返回空集而非全量 | 63 |
| `ui/v4/highspeed/HighSpeedDiffusionCanvas.tsx` | 扩散进度马赛克画布 | INV-01~18；1400ms 是唯一进度基准；0.8 与 0.84 两个阈值各自只发一次；像素尺寸由进度派生；卸载后不得再发阶段事件 | 64 |
| `web/src/share/conversationSharePreviewClient.ts` | 分享预览 HTTP 客户端 | INV-01~18；路由与分享码校验先于请求；错误按状态码分类；诊断上报不阻断主流程；行级降级保留可用内容；不缓存失败结果 | 64 |
| `adapters/browser/page-command.ts` | 浏览器命令翻译 | INV-01~18；命令到 Playwright 的映射穷举且默认拒绝；返回值统一去掉 elapsedMs；定位失败与执行失败分属不同错误；超时由调用方传入不自行兜底 | 64 |
| `core/tool/handlers/bash-read-file-sources.ts` | Bash 读文件静态提取 | INV-01~18；只做静态映射不执行命令；行区间解析失败时退化为整文件；重定向与管道不跨界推断；结果供 readFileState 回填 | 63 |
| `desktop/src/main/aboutWindow.ts` | 关于对话框 HTML | INV-01~18；六项信息一次拼装；样式/图标/关闭脚本全部内联；外部资源零依赖；转义必须覆盖全部插值；关闭走 preload 通道 | 63 |
| `shared/src/subagent-profile-parser.ts` | 子代理档案解析 | INV-01~18；只收 Markdown 文本不读文件；YAML 细节交给下游；解析失败产出诊断而非抛错；名称与描述缺失时保留原文；返回联合类型可判别 | 62 |
| `ui/app-shell/WorkflowRunSidePaneSections.tsx` | 运行侧栏两个展示分区 | INV-01~18；两个分区都是纯展示不取数；状态头只读传入的 run 投影；终态结果区仅在终态渲染；空终态不占位 | 65 |

合计 **762**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. Hero 加载失败必须降级为占位

`CloudDialogMediaHero.tsx` 在三种媒体各自失败时保留容器尺寸并渲染占位。
改成直接塌陷会让弹窗高度在加载前后跳变，用户误以为内容已切换。

### 2. 查询必须先归一化再比较

`conversationFindIndex.ts` 对查询做大小写与空白归一后才进入匹配。
跳过归一化会让中文全角空格或大小写差异直接查不到，命中数凭空归零。

### 3. 阶段阈值只发一次

`HighSpeedDiffusionCanvas.tsx` 用两个布尔守卫保证 0.8 / 0.84 各触发一次。
改成按帧比较会让同一阶段在抖动帧里重复上报，动画与埋点被放大数倍。

### 4. 关闭脚本不得引用外部资源

`aboutWindow.ts` 把样式、图标、脚本全部内联。
一旦引入外链，离线或受限网络下关于窗口会白屏，且 CSP 直接拦截。

### 5. 解析失败产出诊断而非抛错

`subagent-profile-parser.ts` 把格式问题收敛成诊断对象。
改为抛错会让一个坏档案导致整批子代理目录加载失败。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| Hero 失败直接塌陷 | 弹窗高度跳变，内容疑似切换 |
| 错误归一化漏判未知形状 | 未捕获异常打断整块渲染 |
| 查询不归一化 | 大小写/全角差异导致零命中 |
| 命中按分片顺序拼接 | 搜索结果顺序与阅读顺序不一致 |
| 阶段阈值按帧比较 | 同一阶段重复上报 |
| 分享客户端缓存失败 | 一次抖动后长期显示错误页 |
| Playwright 映射缺默认拒绝 | 未知命令被静默当成空操作 |
| Bash 行区间解析失败即丢弃 | readFileState 漏回填，重复读文件 |
| 关于窗口引入外链 | 离线白屏，CSP 拦截 |
| 分区越权取数 | 侧栏出现第二份运行事实 |

## 顺延

B69 复算清单共 20 个候选，本批取 12 个，其余顺延到 B70，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.53%，`suspicious=0`；
> 本批三波均一次插入通过，无补插。
