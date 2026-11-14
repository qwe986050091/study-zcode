# ZC-DEEP-b9

> 批次：B9。基线快照：`d:\code\_annot_baseline\ZC-deep-b9\orig`（执行时拆为 b9a / b9b 两个子批并行，合并校验见下）。

## 校验

```
node zc-verify.mjs ZC-deep-b9a
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=964

node zc-verify.mjs ZC-deep-b9b
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=991

node zc-verify.mjs ZC-deep-b9
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1955

deep-density --only 四文件
30.24  2355  1693  512  479  packages/ui/src/PreviewPane.tsx
30.32  2713  2025  614  485  packages/ui/src/v4/ConversationStatusPanel.tsx
30.73  2520  1868  574  475  packages/ui/src/settings/AutomationsSection.tsx
33.82  2448  1697  574  516  packages/server/src/remote/remoteAssetCache.ts
SUMMARY files=4 coreBelow30=0 needLines=0 min=30.24 median=30.52 newComments=1955
PASS: all 4 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/v4/ConversationStatusPanel.tsx` | 会话状态面板：胶囊摘要与展开面板共用一套投影模型 | INV-1~28；model 只能由 props 派生（唯一真相源）；mini/panel 共用同一 model 与 canRender 闸门；分区靠卸载而非 CSS 隐藏；StatusSection 开合受控/非受控二选一；秒表 effect 依赖收敛为布尔避免嵌套更新；已结束 run 目录入口独立于 hasContent 开门；空态返回 null 而不留空壳；Stop 与「打开详情」必须同级避免嵌套 button；行序稳定；回调 props 容错 undefined；展示开关不得改数据语义；startedAt 缺失不伪造 elapsed；已结束计数只由宿主 journal 口径传入；胶囊摘要严格互斥优先级链；分隔线由 separated 逐级或运算；滚动容器必须在 CollapsibleContent 内；StatusSectionKind 限高表漏配必须编译失败；key 必须是领域实体 id；派生列表必须 useMemo；展开动作与胶囊内容对齐；可访问名与可见标题同源；历史入口必须带 parentSessionId；全行共用同一个 now；胶囊点击只改展示不写状态；停止可见性与可停性分离；data-* 不得参与业务判断；列表只给 max-height；新增分区需同步四处 | 485 |
| `packages/ui/src/PreviewPane.tsx` | 预览面板：文本/代码/图片/媒体/PDF/PPTX/Office 多链路与评论 | INV-1~20；rawSource 只归一化一次；各派生源互斥、fileSource 兜底；异步 effect 需 disposed 守卫 + generation 校验；objectUrl 必须 revoke；previewId 必须 release（含竞态分支）；truncated 分块禁止拼接；PDF 大小文件走全量/range 且分块与服务端对齐；PPTX 二次 stat + 完整性断言；PPTX 等 watch ready 再读；错误文案必须脱敏；codeComments 无 bucket 返回同一 EMPTY 常量；滚动位置只在 false→true 恢复一次；面包屑只在内容变化时滚到最右；header portal 只渲染一次；视图偏好随 source 重置；只读预览不提供换行开关；提交评论前复查已移除；远程能力过滤结果不写回偏好；拖拽引用校验 workspaceIdentity；派生数据依赖列全 | 479 |
| `packages/ui/src/settings/AutomationsSection.tsx` | 自动化设置：列表/新建/编辑/闲时任务的视图路由与写操作 | INV-1~24；view 是五态唯一路由真相；列表只来自 store 不保留可写副本；编辑页持有进入时快照需手动同步；写失败必须可见 toast；创建上限 UI 拦截 + store 兜底；tab 切换原子重置筛选；idle tab 依赖 offPeakVisible；远端工作区禁建闲时任务；一次性导航参数必须消费；列表未就绪导航停在 pending；missing 也要消费并提示；offpeak- 前缀不进 cron 解析；定时器必须 cleanup；loadedWorkspaceKey 是加载唯一判据；切 workspace 先置空；灰度关闭只收窄读值；删除编辑中的任务回列表；busy/saving 按 operationId 前后缀精确匹配；空态与列表态提示条二选一；模板可见性双条件；创建准入 fail-closed；计划锁定模板走升级漏斗；卡片主点击进详情、会话跳转只做次级动作 | 475 |
| `packages/server/src/remote/remoteAssetCache.ts` | 远端资产缓存：release 目录物化、manifest 校验、内容寻址与并发去重 | INV-1~21；release 目录层级固定不扁平化；命中需 ready + requiredPaths 全在；staging 写 + rename 原子替换；同 releaseDir 物化串行锁；组件目录名按 sha256 或剥离 +hash 的版本；server-bundle/glm 内容寻址；manifest schemaVersion 与 appVersion/platformArch 严格匹配；mount 由白名单推导而非信任 manifest；下载先比对 sha256 再解压；目录非空才写 ready；禁符号链接；manifest 相对路径归一化 + 前缀校验；manifest 请求带超时；失败不入 single-flight 表；refresh 表复用同一次 Promise；锁 key 覆盖全部判据；等待锁后按本次 requiredPaths 复检；旧目录 backup 再删、失败回滚；ready 兼容历史文件名；staging 必须 finally 清理；forceRefresh 绕过全部命中并重校验 | 516 |

合计 **1955**，与 `added` 一致。

## 关键不变量（抽取）

- 状态面板：分区是否挂载只能由 canRender* 决定，CSS 隐藏会让分区里的秒表继续跑、面板永不收敛。
- 预览：objectUrl 与 previewId 是两类不同生命周期的资源，必须分别在 cleanup 与竞态分支释放，否则 Host 句柄单调泄漏。
- 预览：PPTX 必须等 watch ready 且二次 stat 通过完整性断言，否则会把写入中的旧前缀当成完整 zip。
- 自动化：编辑页拿的是进入时快照，动作成功后不手动同步就会与列表分叉。
- 远端缓存：目录只能 staging → rename，任何原位写入都会让读取方看到半成品；失败/负结果不得留在 single-flight 表里。

## 进度

本批前：4 文件全部 below30（min 1.95%、median 4.36%、needLines=1868）。
本批后：4 文件全部 ≥30%（min 30.24%、median 30.52%、needLines=0）。
