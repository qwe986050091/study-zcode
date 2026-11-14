# ZC-DEEP-b88

> 批次：B88（6 文件，按 31.4% 口径计算目标 318 行，实际 +319，含 1 行补厚）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b88\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b88
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=319

node check-batch.mjs ZC-deep-b88 ZC-deep-b88-files.txt
TOTAL added=319 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.15   247   183   57   53  packages/ui/src/lib/remoteConnectionPresentationErrors.ts
31.18   236   170   53   53  packages/ui/src/ModelTrajectorySearch.ts
31.28   336   227   71   53  packages/ui/src/components/ai-elements/persona.tsx
31.41   251   191   60   53  packages/ui/src/lib/composerPlanGroups.ts
31.44   280   194   61   53  packages/ui/src/lib/keyboardShortcuts.ts
31.89   252   185   59   54  packages/ui/src/resource-manager/resourceUsageParts.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.15 median=31.35 newComments=319
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/lib/composerPlanGroups.ts` | 输入框计划分组合成 | INV-01~18；团队身份不整组隐藏；连接键五元组；去重与缺目录保留 | 53 |
| `ui/src/lib/keyboardShortcuts.ts` | 跨平台快捷键标签与匹配 | INV-01~18；主修饰键平台隔离；键名归一与代码回退；三种组合互斥 | 53 |
| `ui/src/lib/remoteConnectionPresentationErrors.ts` | 远程连接错误展示分类 | INV-01~18；错误码映射完整；非公开码回落；环境变体后缀白名单 | 53 |
| `ui/src/ModelTrajectorySearch.ts` | 轨迹搜索索引与原始区间回填 | INV-01~18；空白折叠；字符扩展偏移；匹配键唯一；揭示上下文 | 53 |
| `ui/src/resource-manager/resourceUsageParts.tsx` | 资源用量指标卡与分组 | INV-01~18；双层条顺序；未采样占位；列模板共用；展开空态 | 54 |
| `ui/src/components/ai-elements/persona.tsx` | Rive 角色动画封装 | INV-01~18；严格模式延迟一帧；回调引用稳定；主题订阅清理；状态机输入 | 53 |

合计 **319**，与 `zc-verify` 的 `added` 一致。
`resourceUsageParts.tsx` 首次插入 52 行，补插 2 行；`keyboardShortcuts.ts` 首次 47 行，补插 6 行。

## 关键不变量（抽取）

### 1. 团队可用性不能用来整组隐藏

`composerPlanGroups.ts` 只跳过明确不可用的团队项目，保留 Provider 行本身。
按 Provider 的可用性整组过滤会让当前团队不可用时，同 ID 下的其它团队入口一起消失。

### 2. 快捷键的显示与命中必须共用同一平台判定

`keyboardShortcuts.ts` 的标签格式化与主修饰键匹配都调用同一平台判定。
两处各自判断会出现「提示写着 ⌘、实际只认 Ctrl」这类不一致。

### 3. 远程错误的分类与标题必须同源

`remoteConnectionPresentationErrors.ts` 用同一次公开码判断推导分类与标题。
分开判断会出现「分类是认证失败、标题却回落未知」的组合。

### 4. 搜索高亮的偏移必须回填原始文本

`ModelTrajectorySearch.ts` 在归一化文本上查找，再按逐字符映射回填原始区间。
直接拿归一化下标切原文，遇到空白折叠或大小写扩展就会高亮错位。

### 5. 未采样值不能显示为零

`resourceUsageParts.tsx` 用统一占位符表示采集失败，并把提示挂在整格上。
显示零会让用户以为进程真的不占资源。

### 6. Rive 初始化必须延后一帧

`persona.tsx` 在帧回调里才把就绪打开，卸载时取消并复位。
严格模式首帧创建的 WebGL2 上下文会被丢弃，重复挂载几次就会耗尽上下文配额。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 按 Provider 可用性整组过滤 | 其他团队入口消失 |
| 连接键缺项目维度 | 同家族不同项目选中态互相覆盖 |
| 主修饰键混用 Ctrl 与命令键 | macOS 编辑快捷键被劫持 |
| 键名不转小写 | 大写锁定下快捷键失效 |
| 分类与标题分别判断 | 分类命中、标题为空 |
| 非公开码直接查表 | 内部码渲染成空白 |
| 归一化下标切原文 | 高亮错位 |
| 匹配键不含命中序号 | 同字段多处匹配互相覆盖 |
| 未采样显示零 | 资源占用被低估 |
| 双层条顺序颠倒 | 应用占用被系统占用遮住 |
| 就绪不延迟一帧 | WebGL 上下文泄漏 |
| 回调不放进引用 | 每次渲染重建 Rive 实例 |
| 主题监听不清理 | 卸载后仍写状态 |
| 变体名不校验 | 静默白屏 |
| 行键用下标 | 重采样后行状态错位 |

## 断点报告（续跑基线）

- 最后完成批次：**B88**（6 文件 / +319 行 / 全绿）；`added=319`、硬校验全 0。
- 累计（core+apps）：**800 文件 / 103,446 行**。
- 半插入残留：无（两处补插已核到行，最终与目标一致）。
- 剩余缺口：按基线推导 **2,424 个 coreBelow30 / 38,144 行**，完成度 **73.1%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.15%~31.89%，`suspicious=0`。
