# ZC-DEEP-b26

> 批次：B26（计划 11 文件 / 缺口 1,997 行，本批取缺口前 7 个）。
> 覆盖四条链路：媒体预览与侧栏项目菜单、Root 级工作区动作与分组视图纯函数、
> WSL 远端后端与代码预览投影、zcode-server CLI 生命周期。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b26\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b26
SUMMARY files=7 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1136

deep-density --baseline ZC-deep-b26/orig --ext .ts,.tsx --threshold 30 --mode code
31.45  754  550  173  165  packages/ui/src/components/ai-elements/image-preview-dialog.tsx
31.45  794  601  189  164  packages/ui/src/project-sidebar/ProjectComposerMenu.tsx
31.47  873  645  203  165  packages/ui/src/root/useRootWorkspaceActions.ts
31.45  746  531  167  162  packages/ui/src/project-sidebar/grouped/view.ts
31.49  832  578  182  162  packages/server/src/remote/wsl-backend.ts
31.52  760  514  162  158  packages/ui/src/lib/codeViewer.ts
31.43  851  630  198  160  packages/zcode-server-cli/src/cli.ts
SUMMARY files=7 coreBelow30=0 needLines=0 min=31.43 median=31.47 newComments=1136
PASS: all 7 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
`// INV-` 计数：4 个文件 18 条、3 个文件 20 条（均在 18~20 口径内）。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/components/ai-elements/image-preview-dialog.tsx` | 全屏媒体 gallery：缩放/拖拽/捏合、键盘切换与下载 | INV-01~18；activeIndex 是唯一选中项，换项同时重置缩放与位移；previewOffset 恒在 `clampImagePreviewOffset` 对称边界内；previewScale 恒在 0.5~3；单次下载驻留内存不超过 `MAX_DOWNLOAD_BYTES`；降级顺序固定 saveFile → 有界 fetch → 原生下载；`file_too_large` 永不进入原生回退；canceled 原样返回且不写错误日志；日志 source 不含 userinfo/query/fragment；`data:`/`blob:` 不进 URL 解析；扩展名必须与 `blob.type` 相容；下载基名非空且剥离路径与控制字符；objectURL 必 revoke；pointer capture 抬手与重置时释放；pointer map 与 pinchStartRef 同步增减；切项/关闭必须 pause 旧 video；键盘监听在清理中移除；initialIndex 只在 open 或长度变化时归一化；下载失败不改可见性与 activeIndex | 165 |
| `packages/ui/src/project-sidebar/ProjectComposerMenu.tsx` | workspace chip 菜单：选项目、脱离项目、新建项目、远程连接 | INV-01~18；chatKey 由 workspaceKey/activeTaskId/projectId/draftVersion 四元组决定；isCurrent 同时校验 mounted、chat 引用、operation 序号与 store 四元组；operation 每次打开自增、取消也自增；pending 与 `setSubmissionPending` 同步更新；连接成功不等于可提交（目录确认前 pending 保持 true）；canFinish 只在 isCurrent 且成员仍在目录中为真；readDirectory 结果二次校验 isCurrent；validatedHost 只由通过的 canFinish 写入；`onVisibilityChange` 只改门禁；cancelSelection 清空设备与 pending 并回归焦点；accepted=false 走 cancelSelection；returnFocus 是焦点恢复唯一触发器；workspaceKey 取 identity 去空白否则回 path；`createProjectTask` 只在无 activeTaskId 时读 draftTaskGroupId；`canUseRemoteWorkspace` 三条件；`canDetachProject` 必须无 hostId；打开远程弹窗不阻止菜单默认关闭；currentProject 同时匹配 projectId 与 hostId | 164 |
| `packages/ui/src/root/useRootWorkspaceActions.ts` | Root 级 workspace 动作编排：新建任务、选项目、打开文件夹、登出、设置返回 | INV-01~18；新任务落点 identity 缺省归一化为 null；显式 targetWorkspace 时不再询问焦点；navigationSequence 每次自增、旧序号立即失效；isCurrent 同时校验序号、originTab 与两个版本号；requestOptions 在第一次 await 前捕获；grouped 视图 taskGroupId 只从已提交结构或草稿 owner 读取；hasExplicitProject 与 newTaskTarget 互斥；workbench 焦点继承项目必须能反解 hostId；远程解析不出 projectId 抛 `project.remote-project-required`；Web 远程只能走 `openMobileProjectDraft`；pendingDraft 只在无 projectId 且 hostId 为 local 时创建；prepareSession 必须收到 draftId 与 reuseDraft；远程分支必须同时有 workspaceIdentity 与 opener；addTab 只在本地分支；`startDraftInWorkspace` 必须在目录准备成功后；其内先 `deactivateActiveGroup` 再 startDraft；remoteProjectOpener 只在 layout effect 更新；handleLogout 顺序固定 | 165 |
| `packages/ui/src/project-sidebar/grouped/view.ts` | 分组视图纯函数：克隆、查找、插入、移除、拖拽重排、菜单移动 | INV-01~18；所有移动写时复制并返回新容器引用；任务身份只由 taskKey 决定；`removeTaskFromView` 同时返回新视图与被移除任务；移除成功后重新定位插入点；组内插入用 findIndex、找不到回退末尾；`beforeTaskKey` 为 null 表示追加到组尾；顶层与组内两层都参与查找与替换；group 节点在 tasks 改写前克隆；隐藏集合为空时返回原引用；过滤只删任务不删空 group；折叠集合收敛只保留仍存在的 groupId；空分组列表全展开判定为 false；拖动组时组内 task 归一化为所属 group；active 与 over 相同直接返回 view；菜单移动先比较当前组与目标组；移出分组先按原组定位后继节点；置顶时已在首位直接返回；草稿落点未命中任务回退顶层 | 162 |
| `packages/server/src/remote/wsl-backend.ts` | WSL 作为 IRemoteBackend：探测、身份解析、远端路径、命令执行、文件读写、代理网关 | INV-01~20；所有 wsl.exe 子进程必须经 `trackOwnedChild` 登记；buildWslArgs 顺序恒为 `-d`、`-u`、`--exec`、argv；`--exec` 不得删除；identity 只跑一次 `bash -lc`；`resolvedInfoPromise` 必须在任何 await 前赋值；HOME 解析为空必须抛错；显式 distro 匹配失败必须抛错；UTF-16 判定先于 UTF-8 解码；规范化去掉所有 CR；远端 argv 一律 `quotePosixShellArg`；UNC 候选顺序 `wsl.localhost` 在前；UNC 回退失败不得直接抛错；命令执行前两次 `assertNotDisposed`；disposed 同步置位；disposeInFlight 复用；宽限期后只 kill Map 中仍存在的 child；删除登记先于 resolveClosed；onClose 只触发一次且 exit/close 都接入；有 onProgress 或 signal 必须走 `uploadViaExec`；上传成功以 onClose 退出码为准 | 162 |
| `packages/ui/src/lib/codeViewer.ts` | 把所有可展示来源归一成 `CodeViewerSource` 的纯函数投影层 | INV-01~20；预览优先级恒为结构化 diff → 显式 patch → before/after → 文本 → 图片 → 文件；路径先解码 URI 转义再判绝对；相对路径必须有 workspacePath；原文件预览必须透传远程身份；读取工具取 output、写入取 input；`buildUnifiedDiff` 失败回落文本；扩展名优先于 shebang、shebang 优先于 diff 嗅探；未知扩展名回落 log；媒体类型缺失返回 null；图片后缀表的值必须是完整 IANA 类型；diff 目标优先新路径；头解析 `diff --git`/`+++` 先行、`---` 兜底；`/dev/null` 永不作为目标；有引号的路径不按制表符切分；显式 path 优先于 patch 头；工具标题为空才回落路径末段；字段候选顺序即优先级；纯空白视为缺失；`looksLikeDiff` 必须多行模式；`type` 是判别字段 | 158 |
| `packages/zcode-server-cli/src/cli.ts` | zcode-server 命令行解析与生命周期命令分派 | INV-01~20；update 与 uninstall 共用同一把 DataRootLock；生命周期命令在任何 IO 前把 serverRoot 收敛为 canonical；version 在 layout 与锁之前返回；json 标志解析前读取且只读一次；proxy-stdio 在 switch 之前处理；migrate retry 的 `--path` 必须绝对；只有公开错误码才能写 code；`--server-root` 最多一次且从 argv 移除；daemon 注册必须排除 supervisor 子进程；启动前用 500ms 短超时读一次 control status；fallback 模式下即使 ready 也必须继续替换；有 runningTaskCount 绝不替换实例；fallback 入口必须用 `process.argv[1]`；后台子进程必须 detached/ignore/unref/disconnect；ready 判定比较 updatedAt 与启动基线；crash-loop-stopped 立即抛错且先 stop Supervisor；`APPLY_UPDATE_TIMEOUT_MS` 取自 contracts；状态 invalid/unreadable 拒绝 stop；卸载先校验归属再注销服务再取锁；`uninstallEntries` 是唯一删除白名单 | 160 |

合计 **1,136**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 「三级降级」必须有不可跨越的短路点

`image-preview-dialog.tsx` 的下载降级是 saveFile → 有界 fetch → 原生下载，但 `file_too_large` **永不进入**原生回退：
一旦统一回退，50MB 上限就被静默绕过，renderer 内存会被超大图拖垮。
同一文件的另外两条资源约束：单次下载驻留字节数受 `MAX_DOWNLOAD_BYTES` 限制（content-length 预检 + 累计计数双重）；
objectURL 创建后必定 revoke（长会话内存上涨只有靠这条守住）。

### 2. 聊天身份是四元组，不是单个 id

`ProjectComposerMenu.tsx` 的 `chatKey` = workspaceKey + activeTaskId + projectId + draftVersion。
只要少一维，换聊天后旧返回意图仍会通过 `isCurrent`，表现为「迟到回调把旧草稿重新挂成当前连接」。
配套的两条异步约束：operation 每次打开自增（取消也自增）；`readDirectory` 的结果必须在 await 之后二次校验 `isCurrent`。
`pending` 也有一条硬规则：**连接成功不等于可以提交**，目录未确认前必须保持 true，否则草稿会发到错误工作区。

### 3. 「写时复制 + taskKey 唯一身份」是拖拽正确性的全部基础

`grouped/view.ts` 十八条 INV 几乎都在防两类静默错位：
- 身份：只认 `taskKey`，不比对象引用（否则同一任务出现两份或匹配不到）；
- 下标：移除成功后必须重新定位插入点（用移除前的下标会让同组向下移动偏一格）。

`removeTaskFromView` 必须同时返回新视图与被移除任务——只返回视图时调用方拿不到任务，移动后任务凭空消失。
隐藏集合为空时返回原引用、过滤只删任务不删空 group，这两条是渲染稳定性与折叠状态正确性的前提。

### 4. 子进程所有权与 dispose 收口

`wsl-backend.ts` 把「所有 wsl.exe 子进程必须经 `trackOwnedChild` 登记」放在 INV-01：
漏登记等于 dispose 收不了口，遗留孤儿进程与锁。
三条容易误改的细节：`--exec` 不得删除（删掉后局部变量被外层 shell 提前展开成空串，退出码仍为 0，误判远端能力）；
`resolvedInfoPromise` 必须在任何 await 之前赋值（否则并发调用各自探测，distro/user/HOME 跨进程不一致）；
dispose 宽限期后只 kill Map 中仍存在的 child（否则误杀其他会话或整个 distro 的进程）。
上传成功也必须以 onClose 的退出码为准，不能先 resolve。

### 5. 纯函数投影层的「顺序即契约」

`codeViewer.ts` 与 `grouped/view.ts` 都是纯函数，但纯不代表可以自由重排：
预览优先级、路径解析顺序、diff 头扫描顺序、字段候选顺序都是契约，重排不会有类型错误，只会让预览退化成另一类内容。
最典型的是 `looksLikeDiff` 必须用多行模式——少了 `m` 标志，多行 patch 判不出来，全部退化为纯文本。

### 6. 一次性 CLI 的状态必须落在文件或锁上

`cli.ts` 的一条总纲：CLI 是一次性进程，所有可变状态必须落在文件或锁上。
由此派生出的顺序约束：update 与 uninstall 共用同一把 DataRootLock（否则删除正在写入的 release）；
version 必须在 layout 与锁之前返回（半装环境也不碰文件）；
`uninstallEntries` 是唯一删除白名单，`install.json` 绝不在其中（删掉后 App 会把同一设备拆成新设备）。
后台子进程必须 detached + stdio ignore + unref + disconnect，否则 CLI 事件循环被 IPC 通道拖住、daemon 命令不退出。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| `file_too_large` 进入原生下载回退 | 50MB 保护被静默绕过，renderer 内存被打满 |
| 下载不累计 receivedBytes | 无 content-length 的响应把内存打满 |
| objectURL 不 revoke | 长会话内存持续上涨 |
| 日志打印完整 source | 签名 token 落入持久化日志 |
| 换项不重置 transform | 上一张的缩放/位移残留到下一张 |
| chatKey 少一维 | 换聊天后旧返回意图仍通过 isCurrent |
| operation 取消时不增 | 上一轮完成回调覆盖新一轮状态 |
| 连接成功即解除 pending | 草稿发到未确认的工作区 |
| await 后不重跑 isCurrent | 用户切走后任务仍落到旧 tab |
| Web 远程走本地 addTab | 远程任务在本地开出空 tab，草稿双写 |
| 移除后用旧下标插入 | 同组向下移动偏一格 |
| 分组节点未先克隆 | 上游视图被污染，列表不重渲染 |
| 隐藏集合为空返回新对象 | 每次渲染整表重渲染 |
| wsl 子进程不登记 | dispose 收不了口，遗留孤儿进程与锁 |
| 删除 `--exec` | 参数被外层 shell 展开，退出码 0 但远端没执行 |
| distro 匹配失败静默回退 | 部署落到错误发行版 |
| 输出不去 CR | 路径与 distro 名永不相等 |
| 先 UTF-8 再判 UTF-16 | 中文输出乱码且不抛错 |
| 上传在命令完成前 resolve | 上层以为文件已就位 |
| diff 头优先取旧路径 | 删除文件打开不存在的路径 |
| `looksLikeDiff` 缺 m 标志 | 多行 patch 全部退化为纯文本 |
| uninstall 先取锁再校验归属 | 任意绝对目录被递归删除 |
| `install.json` 进入删除白名单 | App 把同一设备拆成新设备 |
| 后台子进程不 unref | daemon 命令不退出 |

## 顺延

本批从 B26 计划清单中取缺口前 7 个，以下文件顺延到下一批：

- `packages/ui/src/components/ai-elements/` 与 `packages/ui/src/project-sidebar/` 的剩余条目由
  `zc-next-batches.mjs` 在 B27 开工前复算。

> 说明：本批开工前对 7 个目标文件逐一做了基线校验（`newComments=0`），确认无半插入残留。
> 两组各出现过一次 anchor 未整行匹配（`function xxx(` 与完整签名不一致），插入器整批拒写，
> 校准后重试成功，未产生半插入状态。
