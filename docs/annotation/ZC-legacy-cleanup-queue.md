# ZC legacy-cleanup 队列（B130 遗留 109 处 / 142 行）

> 来源：`zc-gate.mjs --scan ZC-fix-b130\_files.txt`（留档 `_annot_baseline/b130-gate-raw.txt`）。
> 归属判定：逐行与 `git show HEAD:<rel>` 比对，HEAD 中不存在该行文本即 OWN，存在即 UPSTREAM（禁止改）。
> 结论：**142 行全部 OWN，UPSTREAM = 0**。

## 1. 账目对齐

| 项 | 数量 |
| --- | ---: |
| gate 命中记录 | 109（W/L 99 条 + POEM 10 组） |
| W/L 去重后唯一行 | 92（7 处同一行被 W、L 各记一次） |
| POEM 展开行 | 50（10 组 × 5 行） |
| **队列总行数** | **142** |
| OWN / UPSTREAM | 142 / 0 |

## 2. 逐行判定

判据按「这行有没有让读者少犯一次错」，不看有没有“因为/因此”这类谓词。
拿不准时选「保留-已充分」——漏判的代价是一行没改，误判的代价是把完整句子改坏。

| 判定 | 行数 |
| --- | ---: |
| 合并（poem / 折行 / 重复 JSDoc） | 64 |
| 补锚点 | 2 |
| 保留-已充分 | 72 |
| 保留-规范条款 | 4 |
| **合计** | **142** |

补锚点只有 2 行：`edit.ts:30`（职责列举无后果）与 `desktop/index.ts:2063`（三档高度纯列举）。
其余 72 行已带标识符或后果，按「已充分」只登记不改；4 行规范条款（模块职责/状态所有权/文件职责）确认原样保留。

| 文件 | 行数 | 合并 | 补锚点 | 保留-已充分 | 保留-规范条款 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/desktop/src/main/index.ts` | 52 | 11 | 1 | 39 | 1 |
| `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts` | 36 | 2 | 1 | 33 | 0 |
| `packages/ui/src/lib/chatErrorBannerTelemetry.ts` | 21 | 20 | 0 | 0 | 1 |
| `packages/ui/src/lib/taskNotificationOrchestrator.ts` | 21 | 20 | 0 | 0 | 1 |
| `packages/ui/src/ModelTrajectoryExpandedContent.tsx` | 12 | 11 | 0 | 0 | 1 |
| **合计** | **142** | **64** | **2** | **72** | **4** |

## 3. 逐文件清单

> 每行都带判定词，后续复核判定本身即可。

### packages/desktop/src/main/index.ts

共 52 行。

| 行号 | 判据 | 类型 | 判定 | 原句 |
| --- | --- | --- | --- | --- |
| 1 | W | 规范条款 | 保留-规范条款 | ── 文件职责 ── |
| 2 | F | 折行续句（合并 2–3） | 合并 | Electron 主进程入口：负责应用级单例、协议/权限注册、窗口与 Host 进程生命周期、 |
| 3 | L | 折行续句 | 合并 | 自动更新、托盘/菜单、遥测与退出屏障。它是整个桌面端的“编排层”，不承载业务逻辑； |
| 9 | L | 单行 W/L | 保留-已充分 | 2. 同步注册 IPC（dialog、ttft、browser 相关）与单例管理器； |
| 399 | W | 单行 W/L | 保留-已充分 | 语言与关闭驻留都是“启动期可变、运行期被设置同步”的模块级状态。 |
| 414 | W | 单行 W/L | 保留-已充分 | 首次探测完成前按“不可用”处理，这是安全默认：宁可弹确认也不隐藏到不存在的托盘。 |
| 424 | F | 折行续句（合并 423–425） | 合并 | 因此可以在设置变更、启动 bootstrap、设置页即时同步等多个入口重复调用。 |
| 428 | W | 单行 W/L | 保留-已充分 | 纯设置驱动：不再参考闲时任务数量，避免“任务结束却仍阻止休眠”的陈旧状态。 |
| 449 | W | 单行 W/L | 保留-已充分 | 提示文案的语言在调用时读取，不在构造时快照。 |
| 484 | F | 折行续句（合并 484–485） | 合并 | 创建/关闭/可见性/视口变化都只投递给 owner 窗口，禁止全窗口广播， |
| 569 | F | 折行续句（合并 568–569） | 合并 | 因为标签可能刚被别的路径关闭。 |
| 624 | W | 单行 W/L | 保留-已充分 | 不记录命令正文：其中可能包含用户输入或凭据，属于敏感数据。 |
| 713 | F | 折行续句（合并 713–714） | 合并 | 缩放与窗口尺寸是内存态 + 设置持久化的组合：这里只放内存值， |
| 729 | F | 折行续句（合并 728–729） | 合并 | 因此在这里同步实例化。 |
| 753 | W | 单行 W/L | 保留-已充分 | 预暖序号只用于日志关联：并发准备多个窗口时，能从日志区分是哪一次采集。 |
| 755 | W | 单行 W/L | 保留-已充分 | 序号只增不减，便于按时间排序。 |
| 817 | F | 折行续句（合并 817–818） | 合并 | 首窗复用模块加载时启动的预暖结果；后续窗口各自新建， |
| 845 | W | 单行 W/L | 保留-已充分 | 用整数累加而不是集合，是因为托盘只关心数量；窗口维度用于关窗时精确回退。 |
| 861 | F | 折行续句（合并 859–861） | 合并 | 它不参与是否允许退出的判定，只影响提示文案，因此允许短暂为 0。 |
| 897 | F | 折行续句（合并 896–897） | 合并 | 因此选哪个窗口不影响正确性，只影响资源归属。 |
| 913 | L | 单行 W/L | 保留-已充分 | 更新状态窗口是单例；高度按状态三档收敛，宽度固定，macOS 红绿灯位置单独常量化。 |
| 1044 | L | 单行 W/L | 保留-已充分 | 菜单重建在失焦时不执行，只有聚焦才做，减少无谓的全量构建。 |
| 1125 | W | 单行 W/L | 保留-已充分 | 它不参与远端遥测，因此可以在离线环境独立工作。 |
| 1311 | W | 单行 W/L | 保留-已充分 | 置真后仍保留既有窗口：用户至少能看到升级提示与退出入口。 |
| 1345 | W | 单行 W/L | 保留-已充分 | 它同时负责把一次性启动请求消费掉，避免重复打开或重复确认。 |
| 1351 | W | 单行 W/L | 保留-已充分 | 启动工作区请求是一次性的：取走即清空并标记已消费，避免重连/激活时重复打开。 |
| 1396 | F | 折行续句（合并 1395–1396） | 合并 | 任何路径都不应再弹出退出确认。 |
| 1425 | W | 单行 W/L | 保留-已充分 | 每个字段独立判类型，避免一个字段的坏值阻断其它字段。 |
| 1444 | W | 单行 W/L | 保留-已充分 | 快捷键变更需要重建菜单并广播设置快照：其它窗口的键盘映射与设置页都要跟随。 |
| 1484 | L | 单行 W/L | 保留-已充分 | update 请求晚于普通退出时，只记录预算不可延长，避免退出时间被无限推迟。 |
| 1785 | W | 单行 W/L | 保留-已充分 | 清理后重新探测可写性，作为安装器能否覆盖文件的最后证据。 |
| 1786 | W | 单行 W/L | 保留-已充分 | 仍存活的锁进程只告警：此时继续安装比中止更符合用户预期（至少能尝试替换）。 |
| 1819 | W | 单行 W/L | 保留-已充分 | 没有锁进程时只做可写探测：这是“更新后文件缺失”排查的关键证据。 |
| 1849 | L | 单行 W/L | 保留-已充分 | 确认框的语言直接读当前 locale，不引入渲染层 i18n，避免主进程加载前端资源。 |
| 1889 | W | 单行 W/L | 保留-已充分 | 优先挂在触发退出的窗口上；窗口已销毁时退回聚焦窗口或首个应用窗口。 |
| 1896 | L | 单行 W/L | 保留-已充分 | 桌面命令的统一入口：把 main 的能力（设置、缩放、端点切换、重启）注入命令处理器。 |
| 1909 | W | 单行 W/L | 保留-已充分 | 缩放变化先夹取再重建菜单：菜单里的缩放项要显示当前值。 |
| 1991 | W | 单行 W/L | 保留-已充分 | 重建菜单是异步的（需要读设置与端点），但托盘菜单同步更新。 |
| 1992 | W | 单行 W/L | 保留-已充分 | 两次快速重建可能乱序，最终以最后一次读到的设置为准。 |
| 2013 | W | 单行 W/L | 保留-已充分 | 缩放级别按聚焦窗口读取；没有聚焦窗口时按 0 处理，菜单显示默认值。 |
| 2023 | L | 单行 W/L | 保留-已充分 | 该函数是所有窗口枚举的唯一入口，关闭确认、菜单、语言广播都基于它。 |
| 2031 | W | 单行 W/L | 保留-已充分 | 主窗口集合再排除更新状态窗口：后者是附属窗口，不算“主界面”。 |
| 2036 | W | 单行 W/L | 保留-已充分 | 下载中/已下载时禁止关闭更新窗口：此时它承担安装进度反馈。 |
| 2063 | W | 单行 W/L | 补锚点 | 三档高度：下载中 > 已下载（去掉进度条）> 普通状态。 |
| 2109 | W | 单行 W/L | 保留-已充分 | 更新窗口单例：已存在时只恢复/聚焦并重新同步状态，不重复创建监听器。 |
| 2134 | W | 单行 W/L | 保留-已充分 | 关闭锁定只约束“下载中/已下载”，普通状态允许用户关闭。 |
| 2201 | W | 单行 W/L | 保留-已充分 | 短暂置顶 250ms 是为了压过其它窗口的抢焦点。 |
| 2276 | W | 单行 W/L | 保留-已充分 | 每窗口取一份环境准备：首窗复用进程启动时的预暖，后续窗口各自采集。 |
| 2580 | W | 单行 W/L | 保留-已充分 | 缩放与窗口尺寸只做夹取/快照，真正应用在窗口创建时。 |
| 2612 | W | 单行 W/L | 保留-已充分 | 开发态使用独立身份，避免与已安装版本互相干扰。 |
| 2704 | W | 单行 W/L | 保留-已充分 | 清理最近文档：主进程不维护自己的最近列表，避免与系统菜单重复。 |
| 2936 | L | 单行 W/L | 保留-已充分 | 两个 port 分别交给 Host 与 renderer，main 只做配对，不解读消息。 |

### apps/zcode-cli/packages/core/src/tool/handlers/edit.ts

共 36 行。

| 行号 | 判据 | 类型 | 判定 | 原句 |
| --- | --- | --- | --- | --- |
| 30 | L | 单行 W/L | 补锚点 | 职责：read-before-edit 前置校验、换行与引号风格归一、唯一性判定、写回后刷新读缓存 |
| 40 | L | 单行 W/L | 保留-已充分 | INV-08 引号风格对齐发生在宽松匹配之后、写回之前，只调整替换文本、不回改原文其余部分；守住位置：preserveQuoteStyle 调用；改错故障：匹配成功但文件混入异种引号，lint 直接失败 |
| 129 | W | 单行 W/L | 保留-已充分 | 文案自带前后空格与句号，拼接处不必再补标点，两条模板都能得到完整句子 |
| 161 | L | 单行 W/L | 保留-已充分 | abortSignal 只透传给适配层，本函数不做轮询取消：长匹配是纯 CPU 同步计算，中途无法安全打断 |
| 224 | L | 单行 W/L | 保留-已充分 | 新文件没有读盘与匹配过程，三项耗时和尝试次数都填 0，遥测里不虚构不存在的 IO 成本 |
| 273 | L | 单行 W/L | 保留-已充分 | [失败路径] 漏掉 oldString 的归一化时，模型传入的换行在 CRLF 文件里永远匹配不上，表现为莫名的 OLD_STRING_NOT_FOUND |
| 299 | L | 单行 W/L | 保留-已充分 | 空 old_string 表示清空语义：patch 以空原文为基准，新内容直接落盘，不做额外拼接 |
| 330 | L | 单行 W/L | 保留-已充分 | findEditMatch 是同步 CPU 密集调用，超大 old_string 下耗时线性增长，patchMatchMs 用于暴露这项成本 |
| 347 | L | 单行 W/L | 保留-已充分 | ambiguous 来自宽松匹配阶段的多候选，与后面的 matchCount 不是同一口径，但对外映射到同一错误码 |
| 360 | W | 单行 W/L | 保留-已充分 | [权衡] 只重算计数而不重跑匹配，用一次线性扫描换掉一次可能昂贵的宽松匹配 |
| 481 | W | 单行 W/L | 保留-已充分 | 按不重叠方式推进扫描位置，避免在连续重复片段上得到重叠命中而虚增计数 |
| 513 | W | 单行 W/L | 保留-已充分 | 断言只做编译期收口，运行期字段全部来自上面的显式映射 |
| 526 | W | 单行 W/L | 保留-已充分 | 透传取消信号：用户已取消时不必再让适配层排队等这次元数据查询 |
| 564 | L | 单行 W/L | 保留-已充分 | 目录、文件名、主干一次派生好：后面筛选与比较都复用，避免重复调用 dirname/basename |
| 582 | W | 单行 W/L | 保留-已充分 | 同主干优先：扩展名写错远比文件名打错常见，先按主干对齐能命中大多数情况 |
| 593 | F | 折行续句（合并 593–594） | 合并 | 只保留相邻两行滚动数组，空间为短边长度；候选文件名通常很短，不需要更复杂的优化 |
| 596 | W | 单行 W/L | 保留-已充分 | 上一行初始化为 0..n：表示空串到右串各前缀的编辑距离 |
| 601 | W | 单行 W/L | 保留-已充分 | 外层遍历左串，每轮算出一整行后整行压回上一行 |
| 603 | W | 单行 W/L | 保留-已充分 | 首列表示左串前缀整体删除，值等于已处理的字符数 |
| 606 | W | 单行 W/L | 保留-已充分 | 字符相同不需操作，不同则至少一次替换 |
| 608 | L | 单行 W/L | 保留-已充分 | 删除、插入、替换三种来源取最小值，得到该前缀的最优编辑距离 |
| 621 | W | 单行 W/L | 保留-已充分 | 取右下角结果；理论上必有值，?? 0 只为满足无索引检查的编译约束 |
| 635 | L | 单行 W/L | 保留-已充分 | 没有 readFileState 直接放行，是为了兼容不使用该机制的调用方，例如上下文精简过的子代理 |
| 677 | L | 单行 W/L | 保留-已充分 | size 任何变化都判 stale，包括变小；截断之后内容必然不同，不存在变小但等价的合法场景 |
| 690 | W | 单行 W/L | 保留-已充分 | 只有严格大于才算变化：相等表示没动，变小通常是时钟回拨或快照恢复而非真实修改 |
| 706 | W | 单行 W/L | 保留-已充分 | 两边都有版本号且不同才判变化；任一缺失时不做判断，避免无依据地拦截 |
| 774 | L | 单行 W/L | 保留-已充分 | memory 源标记对普通文件是 no-op，因此可以无条件套用，不必在这里判断目录归属 |
| 817 | L | 单行 W/L | 保留-已充分 | [权衡] patch 基于旧内容与新内容全量比对，大文件下是线性成本，但省掉了维护增量 hunk 状态 |
| 834 | W | 单行 W/L | 保留-已充分 | 工具层不臆造用户修改标记：审批阶段的改动由上层在回调里覆盖这个字段 |
| 869 | W | 单行 W/L | 保留-已充分 | 没有状态表就什么都不做：不走该机制的调用方不该被强塞一份缓存 |
| 871 | L | 单行 W/L | 保留-已充分 | 写成完整视图：offset 与 limit 置空、isPartialView 为 false，下一次 Edit 才能直接复用 |
| 920 | W | 单行 W/L | 保留-已充分 | 非空替换走直接字面替换，不需要处理换行吞噬 |
| 956 | W | 单行 W/L | 保留-已充分 | 计数为 0 说明候选来自宽松匹配而非字面命中，次数在这里没有意义，退回通用文案 |
| 965 | D | 重复 JSDoc（合并 960–965） | 合并 | 逐字符扫描没有用正则，避免为大文件创建匹配数组 |
| 967 | L | 单行 W/L | 保留-已充分 | 两个计数器只服务比值判据，从 0 起即可，不需要记录总行数 |
| 972 | W | 单行 W/L | 保留-已充分 | 非换行字符直接跳过，减少后面的分支判断 |

### packages/ui/src/lib/chatErrorBannerTelemetry.ts

共 21 行。

| 行号 | 判据 | 类型 | 判定 | 原句 |
| --- | --- | --- | --- | --- |
| 21 | W | 规范条款 | 保留-规范条款 | 状态所有权：无状态，平台能力与错误对象由调用方注入。 |
| 45–49 | POEM | poem 堆叠 | 合并 | 空值直接返回空。 ｜ 敏感模式整体替换。 ｜ 其余走截断。 ｜ 不修改原错误对象。 ｜ 只用于上报副本。 |
| 75–79 | POEM | poem 堆叠 | 合并 | 内部验证码优先留空。 ｜ 非业务码返回空。 ｜ 有界面动作才返回。 ｜ 返回动作与业务码。 ｜ 供聚合维度使用。 |
| 133–137 | POEM | poem 堆叠 | 合并 | 各片段先归一。 ｜ 缺失给固定兜底。 ｜ 指纹拼接结构化字段。 ｜ 只保留短哈希。 ｜ 六段用冒号连接。 |
| 174–178 | POEM | poem 堆叠 | 合并 | 展示文案先截断。 ｜ 底层错误走脱敏。 ｜ 详情只报存在性。 ｜ 提供者与模型统一归一。 ｜ 来源与阶段来自归因。 |

### packages/ui/src/lib/taskNotificationOrchestrator.ts

共 21 行。

| 行号 | 判据 | 类型 | 判定 | 原句 |
| --- | --- | --- | --- | --- |
| 21 | W | 规范条款 | 保留-规范条款 | 状态所有权：本模块不持有状态，前值与已见集合由调用方注入。 |
| 35–39 | POEM | poem 堆叠 | 合并 | 只有三个阶段算终态。 ｜ 完成与中断都归为完成。 ｜ 错误阶段归为失败。 ｜ 其余阶段返回空值。 ｜ 调用方据此跳过通知。 |
| 56–60 | POEM | poem 堆叠 | 合并 | 标题先去首尾空白。 ｜ 空标题退回备用文案。 ｜ 有标题时套用标题模板。 ｜ 两处文案共用同一次格式化。 ｜ 不拼接未经裁剪的原始标题。 |
| 101–105 | POEM | poem 堆叠 | 合并 | 前一版会话按标识查表。 ｜ 找不到前值直接跳过。 ｜ 前值已是终态则不重复通知。 ｜ 载荷在循环内即时生成。 ｜ 返回顺序与输入会话顺序一致。 |
| 212–216 | POEM | poem 堆叠 | 合并 | 先过滤掉已见请求。 ｜ 空载荷在扁平映射里被剔除。 ｜ 权限与提问共用同一分发器。 ｜ 工作流复核在此被静默丢弃。 ｜ 不修改调用方传入的集合。 |

### packages/ui/src/ModelTrajectoryExpandedContent.tsx

共 12 行。

| 行号 | 判据 | 类型 | 判定 | 原句 |
| --- | --- | --- | --- | --- |
| 20 | W | 规范条款 | 保留-规范条款 | 模块职责：轨迹消息展开态的正文渲染，含溢出测量与展开切换。 |
| 39 | F | 折行续句（合并 38–39） | 合并 | 只用于格式化文案，不参与数据推导。 |
| 43–47 | POEM | poem 堆叠 | 合并 | 展开内容同时承担工具载荷与普通消息两种形态。 ｜ 有工具结果时优先展示工具载荷，忽略普通分段。 ｜ 载荷文本与分段文本都会去首尾空白，避免空行堆积。 ｜ 错误载荷整段改色，视觉上与成功输出区分。 ｜ 折叠高度固定，展开状态由溢出测量驱动。 |
| 83–87 | POEM | poem 堆叠 | 合并 | 已展开时不再测量，避免展开后仍被判为溢出。 ｜ 元素未挂载时直接返回，首帧不抛错。 ｜ 两像素容差吸收亚像素误差，避免假溢出。 ｜ 收起后可立即重新判定，无需等待下一帧。 ｜ 测量只读高度，不产生状态以外的副作用。 |

## 4. 分批与写入线

硬规则：**同一文件同一时间只允许一条写入线**。desktop 先做关键文件补深（约 60 行），完成后再做 LC-1/LC-2，
避免父语句与块内子语句解释同一事实，导致 DUP 与密度虚高。`edit.ts` 的补深已在 B130 完成，LC-3 直接开工。

| 顺序 | 批次 | 文件 | 写入线 | 审查行 | 需改写 | 状态 |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 1 | DP-desktop | desktop/index.ts | desktop（补深，先行） | — | 实做 30 行新增 | 已完成（newHits=0） |
| 2 | LC-1 | `index.ts` | desktop（DP 已交棒） | 26 | 12 | 已完成（water 54→42） |
| 3 | LC-2 | `index.ts` | desktop（接 LC-1） | 26 | 2 | 已完成（water 42→40） |
| 4 | LC-3 | `edit.ts` | edit.ts（B130 已补深） | 21 | 2 | 已完成（36→33） |
| 5 | LC-4 | `edit.ts` + `chatErrorBannerTelemetry.ts` | edit.ts → chatErrorBanner | 26 | 2（edit.ts 已并入 LC-3） | 已完成（21→11） |
| 6 | LC-5 | `chatErrorBannerTelemetry.ts` + `taskNotificationOrchestrator.ts` | chatErrorBanner → taskNotification | 21 | 20 | 已完成（→1 / →1） |
| 7 | LC-6 | `taskNotificationOrchestrator.ts` + `ModelTrajectoryExpandedContent.tsx` | taskNotification → ModelTrajectory | 22 | 21 | 已完成（→1 / →1） |

## 5. 改写规则与门禁

1. **改写不是删除**：先保留原信息，再合并成连贯段落；合并后仍要回答“守的是什么、写错会怎样”。
2. **同一事实有多条时，先看哪条在 `git show HEAD:<rel>` 里**：在 HEAD 中的是上游注释，必须逐字保留；
   不在 HEAD 的才是待处置对象。判成 OWN 只能说明“这条可以动”，不能说明“这一组里该动哪条”。
   典型事故：`870`/`875`/`896` 看似重复，实为上游原句 + 我们后来补的第二条，首轮改写删错了那一条。
3. 与上游 JSDoc 重复的自建行合并进一行，不重复陈述 JSDoc 已有内容。
4. 补锚点只补真实标识符与后果，不新增第二行，不靠形容词凑长度。
5. 每批跑 `zc-verify.mjs --rewrite <batch>`：`codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`、`literalCommentDeletion=0`、`nonCommentAdded=0`、`syntaxErrorFiles=0`。
6. 改写后重跑 `zc-gate --scan`，确认 `legacyHits` 下降且 `newHits=0`。
7. `Edit` 整段替换前确认 `old_string` 不含上游注释行（B129 误删过一次）。

## 6. 执行记录

### LC-3（edit.ts，2026-11-09）

| 位置 | 判定 | 改法 |
| --- | --- | --- |
| 30 | 补锚点 | 补 `normalizeLineEndings` / `findEditMatch`，并写明“不刷新读缓存会让下一次 Edit 判 stale” |
| 593–594 | 合并 | 两行并为一段：滚动数组 + 不做阈值提前退出的理由与代价，补 `levenshteinDistance` |
| 964–965 | 合并 | 两行并一行：保留 `input.read?.lineEndings` 兜底事实与“不用正则/split”的内存理由，JSDoc 已有的平局规则不再复述 |

```
SUMMARY files=1 rewrittenSegments=3 deletedOwnCommentLines=5 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
gate: addedCommentLines=246 waterLines=33 waterRate=13.41%（本文件命中从 36 降至 33，newHits=0）
```

本批未改动的 19 行按判定保留（其中 `edit.ts:40/273/330/347` 等已带标识符与后果）。

> 行号偏移：LC-3 在 964–965 处净减 1 行，**965 之后的 edit.ts 行号整体上移 1**（原 967 → 966，原 972 → 971）。
> 后续 LC-4 以 `zc-gate --scan` 的实时行号为准，本表其余行号未变动。

### DP-desktop（desktop/index.ts 补深，2026-11-09）

补深结论：该文件块级注释在 B130 后已接近饱和，逐语句未覆盖单元多数是 import 说明符与对象字面量字段。
本批只补**块注释未覆盖、且写错会出故障**的位置，实做 30 行，不做“凑 60 行”的复述。

| 位置 | 补了什么 |
| --- | --- |
| 更新窗口 `webPreferences` | 三项权限开关各自挡住什么（`require`/`process`/嵌套 `webview`），以及 preload 共用入口所以不能依赖默认值 |
| 更新窗口标题栏 / `min/max` | 三平台标题栏差异、Linux 走 `contentSize`；`minHeight=READY`..`maxHeight=PROGRESS` 必须容纳 COMPACT |
| `UPDATE_STATUS_WINDOW_READY_HEIGHT` | 54 是与 renderer 进度条布局耦合的收窄量，由 PROGRESS 派生而非写死 |
| `spawnHostProcess` 依赖块 | 内置 provider 路径为何由 main 解析、CUA 转发与 source 清除、5 个 agent 上报点、媒体预览授权唯一写入口、沙箱 fail-closed、`requestId` 不入注册表 |
| `disposeHostProcess` | `window-closed` 用全局退出预算，其余沿用调用方 `forceKillDelayMs` |
| `registerStabilityMainWindow` | 登记进 `mainWindowIds` 决定遥测里 main/other，closed 自动移除 |
| `applyAppIcon` | 只在 macOS 生效（`app.dock.setIcon`），且必须在 ready 后 |
| 遥测注册段 | 四条通道逐条 configure（缺一条维度整段缺失）；`dataRootKind` 先归一；三个谓词决定采样场景 |
| `initialDesktopZoomLevel` / `resolveBrowserViewOwner` | 同步快照的原因；反查 owner 只走 guest 索引，main 不存第二份 tab 映射 |

```
# zc-verify --rewrite ZC-dp-desktop
rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0
upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

# zc-gate-new ZC-dp-desktop（orig → 当前，只判本批新增行）
files=1 newCommentLines=30 newHits=0
deep-quality: coverage 26.3 → 26.8，branch 34.2 → 34.2（新增注释 30 行；剩余未覆盖单元以 import/字段为主）
```

> **口径提示（2026-11-09）**：上面的 `coverage 26.3 → 26.8` 与 `branch 34.2 → 34.2` 是 **v2 旧口径，已被取代**。
> v3 修掉了两处漏计（字段尾逗号、`isContinuation` 把「上一行以逗号结尾」的下一行一律当续行），分母变大，
> 同一份代码的 coverage 必然低于本行。此处保留原记录仅作历史留痕，**不得再与 v3 数字比较或相减**。
> 244 文件的新旧对照见 §64.3，口径定义见 `DEEP-SPEC.md` §4.4。

**DP 期间发现、原判给 LC-1 的重复注释**（非 gate 命中，故不在原表）。**归属逐行复核后修正**：
`870`、`875`、`896` 三行在 `git show HEAD` 中存在（UPSTREAM），不能删；重复来自我们后来加的第二条。
LC-1 的做法因此改为「保留上游原句、删我们那条」，而不是「两条任挑一条」。

| 位置 | 归属 | LC-1 实际改法 |
| --- | --- | --- |
| 870–871 | 870 UPSTREAM / 871 OWN | 恢复 870 原句，删 871 |
| 866+870（cron 转发） | 866 UPSTREAM / 870 处函数内一句 OWN | 保留上游 866，删函数内重复句 |
| 896+895 | 896 UPSTREAM / 895 OWN | 保留 896，删 895，保留 897 的后果句 |
| 1192–1197 | 两对均 OWN（HEAD 无） | 各留信息更全的一条，删另一条 |

### LC-1（desktop/index.ts 1–1351 段，2026-11-09）

改写 12 段（原计划 10 + DP 新发现 2），删除自建注释 27 行，净减 12 行；上游注释 0 删除。
gate 命中 54 → 42（`waterRate 7.86% → 7.68%`）。

| 位置 | 改法 |
| --- | --- |
| 文件头 2–4 | 断在 `main 装配` / `main 不承载业务逻辑`，补 `而` 消除折行列举 |
| keep-awake 收敛 | 4 行说两遍幂等 → 2 行：两种动作 + 多入口必须幂等 |
| BrowserGuestManager 创建/关闭回调 | 2 折 1，后果改为 `否则…跨窗口 attach 或重复关闭` |
| Guest 挂起/恢复/驻留 | 2 折 1，补 `因为标签可能刚被别的路径关闭` |
| 缩放/尺寸内存态 | 2 行改为两整句，补 `currentDesktopZoomLevel` 锚点 |
| 广播/任务实时总线 | 2 折 1，补 `必须在 Host 创建前可用` |
| 预暖结果交付 | 4 行（含与 814 重复的一句）→ 2 行：take 语义 + promise 不共享的原因 |
| 运行中任务数 | 3 行 → 2 行：用途 + 不参与退出判定 + 允许短暂为 0 |
| 本地派发选 Host | 删我们重复的 895，上游 896 原样保留 |
| cron 句柄 / 转发 | 恢复上游 870、866 原句，删我们重复的两句 |
| 远控管理器存储注入 | 删短版重复两行，保留带后果的版本 |

```
# zc-verify --rewrite ZC-lc1
rewrittenSegments=12 deletedOwnCommentLines=27 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0
upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

# zc-gate --scan ZC-lc1/_files.txt
files=1 addedCommentLines=547 waterLines=42 waterRate=7.68%
```

经验：`gen-legacy-queue` 的 OWN 判定只覆盖当时 gate 命中的行；**DP 期间自行发现的“重复”必须重新比对 HEAD**。
本批就有 3 行（870/875/896）实为 UPSTREAM，首轮改写被 `upstreamCommentDeleted` 拦下后改为「留上游、删自建」。

> 行号偏移：DP 在 918 之后多处插入，desktop 行号与第 3 节旧表不再一一对应；LC-1/LC-2 一律以 `zc-gate --scan` 实时行号为准。

### LC-2（desktop 退出确认 + 三档高度）

- 退出确认折行（`forceQuit` 置真后不再回退）2 行 → 1 行，补 `任何路径都不应再弹出退出确认` 的后果。
- 三档高度由「纯列举」改为可核对的三行：`download-progress` → `PROGRESS_HEIGHT`、`update-downloaded` → `READY_HEIGHT`、
  其余 → `COMPACT_HEIGHT`，并明确指出实际顺序是 `PROGRESS > COMPACT > READY`（旧句写的“下载中 > 已下载 > 普通”数值上不成立）。
- 首版写成两行折行句，被 gate 判 `L`（行尾逗号 + 多分隔符），随后改为三行整句，命中归零。

```
# zc-verify --rewrite ZC-lc2
rewrittenSegments=2 deletedOwnCommentLines=3 codeTokenDiff=0 upstreamCommentDeleted=0 nonCommentAdded=0 syntaxErrorFiles=0
# 文件级 water：42 → 40
```

### LC-4 / LC-5 / LC-6（ui 三文件 poem 清理）

判定依据：每个 5 行 poem 块的每条事实，在该函数体内都已有逐分支注释或文件头 INV 表覆盖，
因此按「合并」处理为删除 poem + 保留原有解释，不再新写同义父语句（避免重复解释）。

| 批次 | 文件 | 段 | 删自建行 | water |
| --- | --- | ---: | ---: | --- |
| LC-4 | `chatErrorBannerTelemetry.ts`（21–79） | 2 | 10 | 21 → 11 |
| LC-5 | `chatErrorBannerTelemetry.ts`（133–178） | 2 | 10 | 11 → 1 |
| LC-5 | `taskNotificationOrchestrator.ts`（21–60） | 2 | 10 | 21 → 11 |
| LC-6 | `taskNotificationOrchestrator.ts`（101–216） | 2 | 10 | 11 → 1 |
| LC-6 | `ModelTrajectoryExpandedContent.tsx`（20–87） | 3 | 14 | 12 → 1 |

`ModelTrajectory` 的 14 行 = 1 行折行合并（38–39）+ 两处 poem 各 5 行 + 随之孤立的 3 行 `//` 分隔线；
`measureOverflow` 的 poem 替换为 2 行，保留「已展开/未挂载直接返回」与「依赖 `showAll` 收起后立即重判」两条实际分支。

```
# zc-verify --rewrite（各批；工具按 HEAD 累计统计，LC-5 的数含 LC-4 已删行）
LC-4: rewrittenSegments=2  deletedOwnCommentLines=10 codeTokenDiff=0 upstreamCommentDeleted=0
LC-5: rewrittenSegments=6  deletedOwnCommentLines=30（本批实际 20，另 10 行来自 LC-4）
LC-6: rewrittenSegments=5  deletedOwnCommentLines=24 codeTokenDiff=0 upstreamCommentDeleted=0
syntaxErrorFiles=0 / nonCommentAdded=0 / starSlash=0（三批相同）
```

## 7. 收口账目（2026-11-09）

| 文件 | 起始命中（队列账面） | 现存命中 | 现存构成 |
| --- | ---: | ---: | --- |
| `desktop/src/main/index.ts` | 52 | **40** | 保留-已充分 39 + 规范条款 1 |
| `edit.ts` | 36 | **32** | 保留-已充分 32 |
| `chatErrorBannerTelemetry.ts` | 21 | **1** | 规范条款 1 |
| `taskNotificationOrchestrator.ts` | 21 | **1** | 规范条款 1 |
| `ModelTrajectoryExpandedContent.tsx` | 12 | **1** | 规范条款 1 |
| **合计** | **142** | **75** | **保留-已充分 71 + 规范条款 4** |

- 76 与第 2 节逐行判定中的「保留」数完全一致；**队列外新增命中 = 0**。
- 数值/常量核对（第 8 节）改写 `edit.ts:224` 后，该行不再被 gate 命中，故 `edit.ts` 33 → 32、合计 76 → 75。
- 全部批次 `upstreamCommentDeleted=0`、`codeTokenDiff=0`、`syntaxErrorFiles=0`。
- `waterLines` 会按行去重（同一行同时命中 `W` 与 `L` 只计一次），队列按记录统计，
  因此中途扫描的绝对数可能与 142−已删 相差 1～2；**收口以 75 = 71 + 4 为准**。

## 8. 数值 / 顺序 / 常量关系核对（2026-11-09）

> 触发：LC-2 发现 `三档高度：下载中 > 已下载 > 普通状态` 与实际常量不符。
> 范围：仅第 3 节的 5 个文件，不外扩；只核对注释里的**数值、顺序、常量关系**，不改变代码。

### 8.1 单独登记：LC-2 的三档高度错句

| 项 | 内容 |
| --- | --- |
| 原句 | `三档高度：下载中 > 已下载（去掉进度条）> 普通状态。` |
| 实际常量 | `PROGRESS_HEIGHT = 224`、`COMPACT_HEIGHT = 205`、`READY_HEIGHT = PROGRESS - 54 = 170` |
| 真实顺序 | `PROGRESS(224) > COMPACT(205) > READY(170)`；已下载态最低，不是居中 |
| 性质 | 注释写了**事实性错误**，比缺注释严重：按原句去改布局会直接排错 |
| 处置 | LC-2 已改为三行可核对版本，并明确写出 `PROGRESS > COMPACT > READY`（见 6 节 LC-2 记录） |

### 8.2 本批查出并修正的错句

| 位置 | 原句问题 | 代码事实 | 改法 |
| --- | --- | --- | --- |
| `edit.ts:224` | 「三项耗时和尝试次数都填 0」：perf 的三个耗时是 `readMs/writeMs/matchMs`，其中 `writeMs` 是真实测量，不是 0 | 新文件分支只把 `fsReadMs`、`patchMatchMs`、`matchAttempts` 置 0；`fsWriteMs` 在写盘后结算 | 改为「fsReadMs、patchMatchMs、matchAttempts 都填 0…写盘耗时仍由 writeEditResult 真实测量」 |
| `edit.ts:593` | 「空间为短边长度」：滚动数组按 `right.length + 1` 分配，right 更长时不是短边 | `Array.from({ length: right.length + 1 }, …)` 两行同长，没有交换左右串 | 改为「空间为 `right.length + 1`」 |
| `taskNotificationOrchestrator.ts:109` | 「在前值不是终态时也跳过」：与分支相反；前值非终态恰恰是**应该通知**的跨终态场景 | `if (previousStatus === status) continue;` 只跳过前值/当前同为 completed 或同为 failed；当前非终态在更上方 `if (!status) continue` 已跳过 | 改为「前值与当前同为 completed 或同为 failed 时跳过；当前不是终态的情况已在上方跳过」 |
| `desktop/index.ts:920` | 「环境变量覆盖 > 启动参数 > 设置文件」：没有“启动参数”这一层，且非 production 下设置项优先于环境变量链 | `resolveZCodeEndpointOrigin`：production 只看 `envBaseOrigin`；非 production 先取 `overrideOrigin`（设置项）再取 `envBaseOrigin` | 改为「非 production 下设置项 > 环境变量链（process.env 覆盖 > 本地 env 快照）；production 忽略设置项」；同时删掉下一行的重复句 |
| `autoUpdater.ts:2369`（LC-7） | 「仍被这个 15 分钟的句柄保活」：把轮询间隔写死成 15 分钟 | `ensureAutoUpdatePollInterval`：`hasVisibleUpdateTarget(menuState)` 为真时用 `AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS`（2 分钟），否则 `AUTO_UPDATE_POLL_INTERVAL_MS`（15 分钟）；下载中还会 `clearInterval` | 改为「AUTO_UPDATE_POLL_INTERVAL_MS（无目标 15 分钟）/ AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS（可见目标 2 分钟）」；LC-7 已落地 |
| `desktopStabilityTelemetry.ts:466`（LC-8） | 「五级 fallback」后列了 6 项：OOM、sqlite、errno、Error 构造、关键字、首行 | `errorLine` 是 6 段 `??` 链：`oomLine` → `sqliteLine` → `errnoLine` → Error 构造 → 关键字 → `usefulLines[0]` | 改为「六级 fallback…最终由 errorLine 的 `??` 链决定」；同批把 `29` 行的 5s/30s 改成两个常量名 |

### 8.3 核对后确认无误的数值/顺序断言

| 文件 | 断言 | 代码依据 |
| --- | --- | --- |
| `edit.ts` | 1GB 上限、写入文案两处同步 | `MAX_EDIT_FILE_SIZE_BYTES = 1024*1024*1024`，`FILE_TOO_LARGE` 文案同值 |
| `edit.ts` | 超时固定 30s 且不可覆盖 | `timeoutMs: 30000`、`defaultMs/maxMs: 30000` |
| `edit.ts` | 编辑距离阈值 3 | `levenshteinDistance(name, targetName) <= 3` |
| `edit.ts` | 读缓存键 offset 1 + limit 空 | `createReadFileStateKey(filePath, 1, undefined)`，与 `read-file-state-metadata` 的 `offset ?? 1` 同构 |
| `edit.ts` | 滚动数组初值 0..n、取右下角 | `previous` 初值 `0..right.length`，返回 `previous[right.length]` |
| `edit.ts` | mtime 整数毫秒且严格前进；size 任何变化 | `normalizeReadFileStateMtimeMs` 归一后 `>` 比较；`sizeBytes !==` 分支 |
| `chatErrorBannerTelemetry.ts` | 500 字符截断 | `CHAT_ERROR_BANNER_MESSAGE_LIMIT = 500` |
| `chatErrorBannerTelemetry.ts` | 3007 属内部自动恢复、不显示按钮 | `resolveRequestVerificationBusinessCode` 命中即返回 `null`；`providerBusinessError` 中 3007 映射到验证恢复动作 |
| `chatErrorBannerTelemetry.ts` | 128 字符键片段、FNV-1a 32 位、补足 8 位、六段固定顺序 | `slice(0, 128)`、`0x811c9dc5`/`0x01000193`、`padStart(8, "0")`、数组 6 项按 task/code/trace/action/providerCode/hash 顺序 `join(":")` |
| `chatErrorBannerTelemetry.ts` | `\u001f` 作指纹分隔符 | `[…].join("\u001f")` |
| `taskNotificationOrchestrator.ts` | 终态只认三个阶段 | `completedSuccess` / `completedInterrupted` → completed，`error` → failed，其余 `null` |
| `taskNotificationOrchestrator.ts` | 返回顺序与输入一致、不改入参 | `for…of sessions` + `push`；`flatMap` 保持顺序 |
| `ModelTrajectoryExpandedContent.tsx` | 2px 容差、遮罩 72px、`max-h-64` | `scrollHeight > clientHeight + 2`、`calc(100% - 72px)`、`max-h-64` 与裁剪同开同关 |
| `desktop/index.ts` | 54 为 PROGRESS 派生收窄量 | `READY = PROGRESS_HEIGHT - 54`（224 → 170） |
| `desktop/index.ts` | 窗口宽 512、三档高度 205/224 | `UPDATE_STATUS_WINDOW_WIDTH/COMPACT_HEIGHT/PROGRESS_HEIGHT` |
| `desktop/index.ts` | Linux 512px 图标 | `icon_512x512.png` / `512x512.png` |
| `desktop/index.ts` | 退出预算 4.5s/9s、7.5s 强杀、cron 1.5s、telemetry flush 2s、首 Host 裁决 ≤2s | `WINDOWS_NORMAL_SHUTDOWN_POLICY{4_000,4_500}`、`STRICT_SHUTDOWN_POLICY{7_500,9_000}`、`DISPOSE_FORCE_KILL_MS=1_500`、`flushPendingReports({timeoutMs:2_000})`、`DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS=2_000` |
| `desktop/index.ts` | 资源样本 5 分钟窗口、main 内存约 60s 一次、renderer heap 60s | `desktopResourceTelemetry` 生产窗口 300s、每 6 个 10s tick 读一次 main、renderer 60s 上报 |
| `desktop/index.ts` | 短暂置顶 250ms | `setAlwaysOnTop(true…); setTimeout(…, 250)` |
| `desktop/index.ts` | 启动打开工作区：命令行路径优先于 deep link | `startupOpenWorkspaceArgPath ? null : extract…DeepLink` |
| `desktop/index.ts` | workspaceKey 优先级 identity > key > path > sessionId | `workspaceIdentity?.trim() || workspaceKey || workspacePath || sessionId` |
| `desktop/index.ts` | 环境合并：本地 env 在前、process.env 在后 | `{...hostProcessLocalEnv, ...process.env}` |

未改项：`desktop/index.ts:2084` 的「240px」是描述“早期复用页内 Dialog 高度”的历史表述，
当前实际高度以 `COMPACT_HEIGHT=205` 为准，不能据此推断现值；保留原文并在此登记。

### 8.4 批次校验

```
# zc-verify --rewrite ZC-num-audit（orig = 本批改动前快照）
files=3 rewrittenSegments=5 deletedOwnCommentLines=5 codeTokenDiff=0 headTokenDrift=0
codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
starSlash=0 syntaxErrorFiles=0

# zc-gate --scan ZC-all-files.txt（5 文件）
files=5 waterLines=75（76 → 75；仅 edit.ts:224 因改写脱离命中，其余保留集不变）
```

## 9. 低覆盖关键文件补深（2026-11-09，ZC-deep-b140）

> **口径提示（2026-11-09）**：下表 coverage 数字全部是 **v2 旧口径，已被取代**（分母未计字段尾逗号，
> 且 `isContinuation` 把「上一行以逗号结尾」的下一行一律当续行，导致分母偏小、coverage 偏高）。
> 保留是为了追溯当时的判断依据，**不得与 v3 数字并列比较**。v3 全量对照见 §64.3。

| 文件 | 定位 | 补前 coverage（v2，旧） | 补后 coverage（v2，旧） | 新增注释行 | 说明 |
| --- | --- | ---: | ---: | ---: | --- |
| `packages/provider/src/registry-service.ts` | Provider 注册表单例：三层配置解析、代际合并、热刷新 | 5.2%（comments 68） | **13.9%（comments 90）** | 22（379 → 401 行） | 补了快照代际、查询转发、监听异常传播、循环续跑与等待者结算 |
| `packages/provider-node/src/personal-provider-config-repository.ts` | 个人 Provider 配置文件仓库：读写、轮询、损坏恢复 | 9.7%（comments 55） | **18.1%（comments 74）** | 19（312 → 331 行） | 补了构造校验、轮询只读边界、写世代、恢复回调与 ENOENT 语义 |

- 用户给出的 1.94% / 7.85% 与本次实测起点（5.2% / 9.7%）不同量级，按现值记录，不追溯旧口径。
- 2026-11-09 补充：本表 5.2% / 13.9% / 9.7% / 18.1% 均为 v2 口径；v3 重算后这批文件的 coverage 会整体下移，
  以 §64.3 与 `deep-quality.mjs --metric-version v3` 的重跑结果为准。
- 补深均落在未覆盖的分支/方法入口，未改代码、未删上游注释；`substance` 维持 82.2% / 78.4%，
  `filler=0`、`weak=0`。

```
# zc-verify --rewrite ZC-deep-b140（orig = HEAD；126 行含此前已补的 45/40 行，本批净增 22/19）
files=2 addedCommentLines=126 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0
upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

# zc-gate --scan ZC-deep-b140/_files.txt
files=2 badFiles=0 waterLines=0 waterRate=0.00%
```

工具教训：`deep-quality.mjs --uncovered <path>` 的 `<path>` 是**输出文件**，不是筛选条件；
直接传源文件路径会把源文件覆盖成未覆盖清单。本节执行中曾误触一次，恢复后 `git diff` 为纯注释新增
（+45 行、0 删除）。恢复后补跑两条硬验证：

```
node _annot_baseline\check-code-tokens.mjs d:\code\ZCode ZC-deep-b140\_files.txt ZC-deep-b140\orig
  → codeTokenDiff=0
node _annot_baseline\validate-ts.mjs d:\code\ZCode ZC-deep-b140\_files.txt ZC-deep-b140\orig
  → syntaxFailed=0
```

**流程违规**：本次是凭上下文重打恢复的，不是从快照复制。正确做法见 README §4.1：
一律 `Copy-Item <batch>\orig\<rel> <repo>\<rel>`，重打只允许作为无快照时的最后手段，且必须补跑上述两条门禁。

## 10. 数值 / 顺序 / 常量核对扩展到 provider 两包（2026-11-09）

- 范围：`packages/provider/src/**` + `packages/provider-node/src/**`，共 22 个文件；
  只取「注释里出现数字、阈值、层级顺序、优先级链」的位置，逐条回读代码常量。
- 结果：**新增事实性错误 0 处**。此前 5 文件轮已修 4 处（§8.2），本轮复核确认无复发。
- 重点复核并确认正确的链路：

| 位置 | 断言 | 代码依据 |
| --- | --- | --- |
| `config-service.ts` | 复合 revision 按 `[builtin, personal]` 序列化；新 Provider 永远追加末尾 | `JSON.stringify([zcodeBuiltin.revision, personal.revision])`、`appendCurrentProviderOrder` |
| `config-service.ts` | 冲突 id 从 2 开始递增、不设上限 | `nextPersonalProviderId` 的 `for (let suffix = 2; ; suffix += 1)` |
| `config-service.ts` | 叠加顺序模板在前、Personal 在后 | `template.config.overlay(input.initialConfig)` 与 `zcodeBuiltin.providers.overlay(personal)` |
| `config-service.ts` | 先拒绝 Built-in、再拒绝不存在；继承模型保护优先于存在性 | `renamePersonalModel` 先在 `builtinModelIds` 命中时抛错再判 `personalModelIds`；`deletePersonalModel` 同理 |
| `resolver.ts` | 家族最前、内置居中、个人最后；缺省顺序按内置序兜底 | `resolveOwnedOrder` 的 family/builtin/personal 三段与 `ordered` 兜底 |
| `model-config.ts` | 规则顺序即优先级；`getExact` 前向叠加、`getExactRule` 反向取最后一条 | `for (const rule of #rules)` 与倒序 `for` 循环 |
| `model-config.ts` | `toJSON` 固定输出 model、model-api、provider-site、template、provider-model | 对象字面量的属性声明顺序 |
| `provider-config.ts` | 字段合并：`undefined` 保留、`null` 清空、type 不同整体取 next | `overlayValue` 与 `overlay` 分支 |
| `provider-config.ts` | 重排先去重已存在 id、再追加剩余 id | `reorderPersonalProviders` 走 `normalizeProviderOrder`；追加走 `appendCurrentProviderOrder` |
| `zcode-builtin-download.ts` | 20s 总预算覆盖两次请求；正文字节上限 10,000,000 | `setTimeout(..., 20_000)` 包住 client-config + CDN；`bytes > 10_000_000` |
| `zcode-builtin-remote-synchronizer.ts` | 1 小时既是成功刷新默认间隔，也是失败退避上限 | `HOUR_MS` 同时用于 `refreshIntervalMs` 与 `maxDelayMs` |
| `provider-config-runtime.ts` | 恢复检查固定 60s，仅在远端同步器/端点源/监听器存在时创建定时器 | `setInterval(..., 60_000)` 与 `start()` 内的三选一前置判断；实际刷新由下载 TTL 决定 |
| `legacy-reasoning-level-renames.ts` | 列表顺序不参与匹配 | `renames.find` 按模型名精确匹配，条目键唯一 |
| `account-provider-resolution.ts` | 连接结果顺序不参与语义 | `indexConnections` 先按 providerId 建 Map，重复/非法指向当场抛错 |

## 11. LC 相邻文件队列（desktop/main，待开工）

扫描命令：`node zc-gate.mjs --scan ZC-lc-adjacent.txt`（`ZC-lc-adjacent.txt` = desktop/main 全部 `.ts`）。

总量：**104 文件 / 1210 命中 / 1159 唯一行**。注意这是 gate 命中，不等于都要改；
按旧规则仍需逐行判定（合并 / 补锚点 / 保留-已充分 / 保留-规范条款），实际改写量预计 3～4 成。

与 `index.ts` 直接相邻、优先排队的文件：

| 顺序 | 批次 | 文件 | gate 唯一行 | 关系 | 状态 |
| ---: | --- | --- | ---: | --- | --- |
| 1 | LC-7 | `autoUpdater.ts` | 55 | 更新状态窗口与退出屏障的协作方 | 已完成（55 → 39，见 §12.6） |
| 2 | LC-8 | `desktopStabilityTelemetry.ts` | 39 | 稳定性遥测装配 | 已完成（39→10） |
| 3 | LC-9 | `browserView/browserGuestManager.ts` | 33 | guest 生命周期与 index 的 owner 映射 | 已完成（33→2） |
| 4 | LC-10 | `webRemoteControlManager.ts` | 32 | 远程控制存储注入 | 已完成（32→4） |
| 5 | LC-11 | `exportLogs.ts` | 31 | 日志导出与数据目录 | 已完成（31→0，见 §16.7） |
| 6 | LC-12 | `desktopDeepLinkUrl.ts` | 25 | 启动深链与工作区打开 | 已完成（25→7，见 §17.7） |
| 7 | LC-13 | `desktopZCodeDataSizeTelemetry.ts` | 24 | 数据体积采样 | 已完成（24→1，见 §18.7） |
| 8 | LC-14 | `networkTelemetryAggregator.ts` | 23 | 网络遥测聚合 | 已完成（23→6，见 §19.7） |
| 9 | LC-15 | `desktopRemoteSessions.ts` | 22 | 远程会话 | 已完成（22→2，见 §20.8） |
| 10 | LC-16 | `windowsInstallResourceLocks.ts` | 19 | 升级前资源锁清理 | 已完成（19→1，见 §21.6） |
| 11 | LC-16 | `about.ts` | 20 | 关于窗口与快照 | 已完成（20→1，INV-01 原文保留，见 §21.4） |
| 12 | LC-16 | `chromeInstallationCandidates.ts` | 20 | Chrome 安装候选 | 已完成（20→3，见 §21.6） |
| 13 | LC-17 | `desktopMainIpcRemote.ts` | 18 | 远程 IPC | 已完成（18→0，见 §22） |
| 14 | LC-17 | `taskRealtimeBus.ts` | 18 | 任务实时总线 | 已完成（18→0，见 §22） |
| 15 | LC-17 | `desktopRuntimeEnv.ts` | 17 | 运行时环境 | 已完成（17→0，见 §22） |
| 16 | LC-18 | `desktopCrashCapture.ts` | 14 | 崩溃取证与 dump 清理 | 已完成（14→0，见 §23） |
| 17 | LC-18 | `forceUpdatePrompt.ts` | 16 | 强制更新提示窗口 | 已完成（16→0，见 §23） |
| 18 | LC-18 | `resourceManagerWindow.ts` | 15 | 资源管理器窗口 | 已完成（15→0，见 §23） |
| 19 | LC-19 | `embeddedBrowserPermissionUiBridge.ts` | 15 | 内置浏览器权限弹窗桥 | 已完成（15→0，见 §24） |
| 20 | LC-19 | `fileApplications.ts` | 13 | 外部应用注册表 | 已完成（13→0，见 §24） |
| 21 | LC-19 | `desktopResourceTelemetry.ts` | 12 | 进程资源遥测 | 已完成（12→0，见 §24） |
| 22 | LC-20 | `windowsCuaOperationIndicator.ts` | 13 | Windows CUA 操作浮层 | 已完成（13→0，见 §25） |
| 23 | LC-20 | `chromeCookieManager.ts` | 13 | Chrome Cookie 导入 | 已完成（13→0，见 §25） |
| 24 | LC-20 | `desktopCommandHandlers.ts` | 13 | 桌面命令分发 | 已完成（13→0，见 §25） |
| 25 | LC-21 | `browserCommandPageHandlers.ts` | 12 | 浏览器命令页面侧处理器 | 已完成（12→0，见 §26） |
| 26 | LC-21 | `browserTabRecoveryStore.ts` | 13 | 标签恢复存储 | 已完成（13→0，见 §26） |
| 27 | LC-21 | `crashDumpAnnotations.ts` | 15 | 崩溃转储注解解析 | 已完成（15→0，见 §26） |
| 28 | LC-22 | `desktopLinuxDeepLinkRegistration.ts` | 17 | Linux 深链注册 | 已完成（17→0，见 §27） |
| 29 | LC-22 | `desktopRemoteUsageArmsTelemetry.ts` | 14 | 远控 ARMS 遥测 | 已完成（14→0，见 §27） |
| 30 | LC-22 | `windowsChromeAppBoundKey.ts` | 15 | Windows App-Bound 密钥 | 已完成（15→0，见 §27） |
| 31 | LC-23 | `browserCommandInput.ts` | 18 | 浏览器输入事件 | 已完成（18→0，见 §28） |
| 32 | LC-23 | `editors.ts` | 17 | 编辑器与文件应用探测 | 已完成（17→0，见 §28） |
| 33 | LC-23 | `desktopHostProcess.ts` | 13 | Local Host 进程管理 | 已完成（13→0，见 §28） |
| 34 | prefix | 5 文件（见 §29.1） | 309 | `// //` 双前缀规范化 | 已完成（309→0，见 §29） |
| 35 | LC-24 | `browserCommandInteractionHandlers.ts` | 11 | 浏览器交互命令 | 已完成（11→0，见 §30） |
| 36 | LC-24 | `browserScreenshotCapture.ts` | 10 | 截图尺寸校正 | 已完成（10→0，见 §30） |
| 37 | LC-24 | `browserVirtualClipboard.ts` | 9 | 虚拟剪贴板粘贴 | 已完成（9→0，见 §30） |
| 38 | LC-25 | `electronBrowserWebmRecorder.ts` | 10 | WebM 录制器 | 已完成（10→0，见 §31） |
| 39 | LC-25 | `browserPlaywrightLocatorExecutor.ts` | 9 | Playwright locator 执行 | 已完成（9→0，见 §31） |
| 40 | LC-25 | `browserPlaywrightExecutor.ts` | 8 | Playwright 动作分发 | 已完成（8→0，见 §31） |
| 41 | LC-26 | `desktopTray.ts` | 12 | 托盘与角标 | 已完成（12→0，见 §32） |
| 42 | LC-26 | `desktopApplicationMenu.ts` | 10 | 应用菜单 | 已完成（10→0，见 §32） |
| 43 | LC-26 | `desktopWindowLifecycle.ts` | 10 | 窗口生命周期 | 已完成（10→0，见 §32） |
| 44 | LC-27 | `browserDataManager.ts` | 11 | 浏览器数据导入 | 已完成（11→0，见 §33） |
| 45 | LC-27 | `desktopSaveFile.ts` | 10 | 保存文件 IPC | 已完成（10→0，见 §33） |
| 46 | LC-27 | `chromeLocalStorageManager.ts` | 10 | Chrome 本地存储导入 | 已完成（10→0，见 §33） |
| 47 | LC-28 | `pluginSandbox/registry.ts` | 21 | 插件沙箱注册表 | 已完成（21→0，含 POEM 合并，见 §34） |
| 48 | LC-28 | `pluginSandbox/guestPolicy.ts` | 13 | 插件 guest 策略 | 已完成（13→0，含 POEM 合并，见 §34） |
| 49 | LC-28 | `mcpUserDirectory/index.ts` | 11 | 用户级 MCP 目录 | 已完成（11→0，见 §34） |
| 50 | LC-29 | `desktopFinderOpenFolderWorkflow.ts` | 10 | Finder 服务安装 | 已完成（10→0，见 §36） |
| 51 | LC-29 | `desktopStabilityTelemetry.ts` | 10 | 稳定性遥测装配（残余） | 已完成（10→0，见 §36） |
| 52 | LC-29 | `forceUpdateGuard.ts` | 9 | 强制更新判定 | 已完成（9→0，见 §36） |
| 53 | LC-30 | `localTtftExporter.ts` | 10 | 本地 TTFT 导出 | 已完成（10→0，见 §37） |
| 54 | LC-30 | `manifestUpdateProvider.ts` | 8 | 更新清单 Provider | 已完成（8→0，见 §37） |
| 55 | LC-30 | `appARMSBootstrap.ts` | 9 | ARMS RUM 引导 | 已完成（9→0，见 §37） |
| 56 | LC-31 | `desktopMainIpcPlatform.ts` | 9 | 桌面平台 IPC 装配 | 已完成（9→0，见 §38） |
| 57 | LC-31 | `rendererActionTraceBroker.ts` | 9 | 动作 trace broker | 已完成（9→0，见 §38） |
| 58 | LC-32 | `localTtftSpans.ts` | 24 | 本地 TTFT 跨度 | 已完成（24→0，含 POEM 合并，见 §39） |
| 59 | LC-33 | `startupWorkspace.ts` | 9 | 启动工作区恢复 | 已完成（9→0，见 §40） |
| 60 | LC-33 | `chromeProfileDiscovery.ts` | 8 | Chrome Profile 发现 | 已完成（8→0，见 §40） |
| 61 | LC-33 | `web-remote-relay/webRemoteControlTransport.ts` | 8 | 远控传输层 | 已完成（8→0，见 §40） |
| 62 | LC-34 | `desktopWindowsOpenFolderContextMenu.ts` | 7 | Windows 资源管理器菜单 | 已完成（7→0，见 §41） |
| 63 | LC-34 | `chromeExecutableDiscovery.ts` | 7 | Chrome 可执行文件发现 | 已完成（7→0，见 §41） |
| 64 | LC-34 | `openInEditor.ts` | 8 | 编辑器打开链路（残余） | 已完成（8→0，见 §41） |
| 65 | LC-35 | `desktopContextPromptRollout.ts` | 20 | 上下文提示 rollout | 已完成（20→0，含 4 组 POEM 合并，见 §42） |
| 66 | LC-35 | `browserView/browserPlaywrightDomSnapshot.ts` | 7 | Playwright DOM 快照 | 已完成（7→0，见 §42） |
| 67 | LC-35 | `desktopOAuthDeepLink.ts` | 7 | OAuth 深链分发 | 已完成（7→0，见 §42） |
| 68 | LC-36 | `desktopWindowChrome.ts` | 7 | 桌面窗口 chrome 装配 | 已完成（7→0，见 §45） |
| 69 | LC-36 | `applicationIcons.ts` | 7 | 应用图标发现 | 已完成（7→0，见 §45） |
| 70 | LC-36 | `desktopDeepLinkUrl.ts` | 7 | 深链 URL 判定 | 已完成（7→0，见 §45） |
| 71 | LC-37 | `aboutWindow.ts` | 6 | 关于对话框 HTML | 已完成（6→0，见 §46） |
| 72 | LC-37 | `desktopBrowserViewIpc.ts` | 6 | 内嵌浏览器 IPC | 已完成（6→0，见 §46） |
| 73 | LC-37 | `networkTelemetryAggregator.ts` | 6 | 网络遥测聚合 | 已完成（6→0，见 §46） |
| 74 | LC-38 | `unreadBadge.ts` | 22 | 未读角标渲染 | 已完成（22→0，含 5 组 POEM 合并，见 §47） |
| 75 | LC-38 | `windowsAumidIcon.ts` | 5 | Windows AUMID 图标 | 已完成（5→0，见 §47） |
| 76 | LC-39 | `zcodeDataSizeScanner.ts` | 21 | 数据体积扫描 | 已完成（21→0，含 4 组 POEM/B 合并，见 §48） |
| 77 | LC-40 | `desktopArmsCustomEvent.ts` | 19 | ARMS 自定义事件环 | 已完成（19→0，含 4 组 POEM 合并，见 §49） |
| 78 | LC-40 | `desktopCuaPermissionIpc.ts` | 19 | CUA 权限 IPC | 已完成（19→0，含 4 组 POEM 合并，见 §49） |
| 79 | LC-40 | `processResourceMcpTelemetrySource.ts` | 19 | MCP 资源遥测源 | 已完成（19→0，含 4 组 POEM 合并，见 §49） |
| 80 | LC-41 | `desktopNetworkPolicy.ts` | 18 | Chromium 网络策略 | 已完成（18→0，含 4 组 POEM 合并，见 §50） |
| 81 | LC-41 | `rendererActionTraceIpc.ts` | 18 | 渲染进程动作追踪 IPC | 已完成（18→0，含 4 组 POEM 合并，见 §50） |
| 82 | LC-42 | `embeddedBrowserJavaScriptDialog.ts` | 16 | 内嵌浏览器原生弹窗 | 已完成（16→0，含 3 组 POEM 合并与 3 行 W 改写，见 §51） |
| 83 | LC-42 | `embeddedBrowserPermissionPolicy.ts` | 14 | 内嵌浏览器权限策略 | 已完成（14→0，含 4 组 POEM 合并，见 §51） |
| 84 | LC-43 | `localMediaPreviewProtocol.ts` | 14 | 本地媒体预览协议 | 已完成（14→0，含 3 组 POEM 合并与 2 行 W 改写，见 §52） |
| 85 | LC-43 | `desktopMainIpcHelpers.ts` | 13 | 主进程打开路径公共实现 | 已完成（13→0，含 4 组 POEM 合并与 1 行 W 改写，见 §52） |
| 86 | LC-44 | `pluginSandbox/permissionGate.ts` | 13 | 插件沙箱权限闸门 | 已完成（13→0，含 3 组 POEM 合并与 2 行 W 改写，见 §53） |
| 87 | LC-44 | `appTelemetryRuntime.ts` | 12 | 应用启动/日活遥测运行时 | 已完成（12→0，含 3 组 POEM 合并与 2 行 W 改写，见 §53） |
| 88 | LC-45 | `desktopNotifications.ts` | 12 | 主进程任务通知 | 已完成（12→0，含 3 组 POEM 合并与 2 行 W 改写，见 §54） |
| 89 | LC-45 | `databaseStartupTelemetry.ts` | 11 | 数据库启动遥测 | 已完成（11→0，含 1 组 B、2 组 POEM 合并与 3 行 W 改写，见 §54） |
| 90 | LC-46 | `desktopCronScheduler.ts` | 11 | Cron 调度子进程句柄 | 已完成（11→0，含 2 组 POEM 合并与 4 行 W 改写，见 §55） |
| 91 | LC-46 | `desktopMcpTelemetry.ts` | 11 | MCP 遥测映射上报 | 已完成（11→0，含 3 组 POEM 合并与 1 行 W 改写，见 §55） |
| 92 | LC-47 | `desktopWebRemoteControlIpc.ts` | 11 | Web 远程控制 IPC | 已完成（11→0，含 2 组 POEM 合并与 4 行 W/L 改写，见 §56） |
| 93 | LC-47 | `resourceManagerNetwork.ts` | 11 | 资源管理器网络采集 | 已完成（11→0，含 3 组 POEM 合并与 1 行 W 改写，见 §56） |
| 94 | LC-48 | `browserView/browserCommandExecutor.ts` | 5 | 浏览器命令分派 | 已完成（5→0，5 行 W 补真实标识符，见 §57） |
| 95 | LC-48 | `browserView/browserTabResidencyCoordinator.ts` | 5 | tab 驻留协调器 | 已完成（5→0，5 行 L 补谓词，见 §57） |
| 96 | LC-48 | `mcpUserDirectory/claude.ts` | 5 | Claude MCP 适配层 | 已完成（5→0，2 行 W/L 补标识符与谓词，见 §57） |
| 97 | LC-48 | `pluginSandbox/protocol.ts` | 5 | 插件沙箱协议 | 已完成（5→0，2 行 L、3 行 W 补谓词与标识符，见 §57） |
| 98 | LC-49 | `cuaAccessibilitySettings.ts` | 4 | CUA 辅助功能设置引导 | 已完成（4→0，补谓词与真实函数/表名，见 §58） |
| 99 | LC-49 | `databaseStartupRelay.ts` | 4 | 数据库启动中继 | 已完成（4→0，补 `windowBindings`/`senderId` 与谓词，见 §58） |
| 100 | LC-49 | `chromeInstallationCandidates.ts` | 3 | Chrome 安装候选推导 | 已完成（3→0，补函数/路径名与 `所以`，见 §58） |
| 101 | LC-49 | `pluginSandbox/session.ts` | 3 | 沙箱会话权限处理器 | 已完成（3→0，补 `callback`/`isCurrent`/`setPermissionCheckHandler`，见 §58） |
| 102 | LC-49 | `desktopNetworkTelemetry.ts` | 2 | 网络遥测运行面 | 已完成（2→0，补 `globalContext`/`reportTimer`，见 §58） |
| 103 | LC-49 | `desktopRemoteSessions.ts` | 2 | 远端会话生命周期 | 已完成（2→0，补 `connectFinalized`/`connected`，合并标记说明，见 §58） |
| 104 | LC-49 | `browserView/browserGuestManager.ts` | 2 | 浏览器 guest 管理 | 已完成（2→0，补 `所以`，见 §58） |
| 105 | LC-49 | `windowsInstallResourceLocks.ts` | 1 | Windows 安装资源锁 | 已完成（1→0，补 `INV` 与 `必须`，见 §58） |
| 106 | LC-49 | `browserView/browserVirtualClipboardPageScript.ts` | 1 | 虚拟剪贴板页面脚本 | 已完成（1→0，补 `VIRTUAL_PASTE_PAGE_FUNCTION`；本文件曾整文件 LF，已 `--fix` 恢复，见 §58） |
| 107 | LC-49 | `mcpUserDirectory/legacy.ts` | 1 | Legacy MCP 迁移 | 已完成（1→0，补 `candidates`/`只`，见 §58） |
| 108 | LC-50 | `browserView/browserScreenshotSurfaceContracts.ts` | 13 | 截图表面共享契约 | 已完成（13→0，含 3 组 POEM 合并与 2 行 W 改写，见 §59） |
| 109 | LC-51 | `index.ts` | 40 | Electron 主进程入口 | 已完成（40→0；另合并 13 行重复的自有注释，见 §60） |
| 110 | LC-52 | `autoUpdater.ts` | 39 | 自动更新状态机 | 已完成（39→0，INV 续句与 W/L 原地改写，见 §61） |
| 111 | LC-53 | 6 个文件 | 21 | 截图/沙箱/远控/关于/遥测 | 已完成（21→0；另删 3 行与上游重复的复述，见 §62） |

#### 11.1 `addedCommentLines` 差额分解（10849 → 10773 → 10758 → 10743 → 10730 → 10714 → 10700 → 10656 → 10629 → 10609 → 10592 → 10577 → 10564 → 10552 → 10540 → 10539 → 10531 → 10515）

| 步骤 | 增减 | 原因 |
| --- | ---: | --- |
| LC-25 结束时（旧口径） | 10849 | 5 行模板内 `//` 仍按注释计入 |
| 尺子修正 | −76 | 244 文件回扫：字符串/模板字符串内的自有 `//` 行共 76 行，不再计入注释度量（分布见 §35.1） |
| LC-25 复检 | 0 | 3 行模板外注释改写（不增减）；2 行模板内确认非注释，已含在 −76 |
| LC-26 / LC-27 | 0 | 只改写、不增删行 |
| LC-28 | −15 | POEM 合并：19+3 行并成 6+1 行，净删 15 行自有注释 |
| LC-29 | 0 | 只改写、不增删行（三文件 added 保持 400） |
| LC-30 | 0 | 只改写、不增删行（三文件 added 保持 179） |
| LC-31 | 0 | 只改写、不增删行（两文件 added 保持 191） |
| LC-32 | −15 | POEM 合并：3+3+4+4+6 行并成 5 行，净删 15 行自有注释 |
| LC-33 | 0 | 只改写、不增删行（三文件 added 保持 184） |
| LC-34 | 0 | 只改写、不增删行（三文件 added 保持 210） |
| LC-35 | −13 | POEM 合并：4+5+4+4 行并成 4 行，净删 13 行自有注释 |
| LC-36 | 0 | 只改写、不增删行（三文件 added 保持 249） |
| LC-37 | 0 | 只改写、不增删行（三文件 added 保持 223） |
| LC-38 | −16 | POEM 合并：3+3+4+3+3 行并成 5 行，净删 16 行自有注释 |
| LC-39 | −14 | POEM/B 合并：5+5+4+4 行并成 4 行，净删 14 行自有注释 |
| LC-40 | −44 | POEM 合并：5+3+5+5、5+5+5+4、5+5+5+4 共 13 组并成 13 行，净删 44 行自有注释 |
| LC-41 | −27 | POEM 合并：5+5+4+4、5+5+4+3 共 8 组并成 8 行，净删 27 行自有注释 |
| LC-42 | −20 | POEM 合并：4+3+6、3+4+4+3 共 7 组并成 7 行，净删 20 行自有注释（含 3 行 W 改写不增减） |
| LC-43 | −17 | POEM 合并：5+3+4、3+3+3+3 共 7 组并成 7 行，净删 17 行自有注释（含 3 行 W 改写不增减） |
| LC-44 | −15 | POEM 合并：4+4+3、4+3+3 共 6 组并成 6 行，净删 15 行自有注释（含 4 行 W 改写不增减） |
| LC-45 | −13 | POEM/B 合并：3+3+4、3+3+3 共 6 组并成 6 行，净删 13 行自有注释（含 5 行 W 改写不增减） |
| LC-46 | −12 | POEM 合并：3+4、4+3+3 共 5 组并成 5 行，净删 12 行自有注释（含 5 行 W 改写不增减） |
| LC-47 | −12 | POEM 合并：3+4、4+3+3 共 5 组并成 5 行，净删 12 行自有注释（含 5 行 W/L 改写不增减） |
| LC-48 | 0 | 20 行全部为单行 W/L 原地改写，不增减行数 |
| LC-49 | −1 | 23 行中仅 1 组标记说明 2→1 合并，其余为原地改写 |
| LC-50 | −8 | POEM 合并：4+4+3 共 3 组并成 3 行，净删 8 行自有注释 |
| LC-51 | −13 | 40 行原地改写（不增减）；另删 13 行重复的自有注释：10 行逐字重复（`:375/:376/:402/:560/:1335/:1774/:2270/:2271/:2510/:3144`）+ 3 行前缀重复（`:1082/:1634/:3095`） |
| LC-52 | 0 | 39 行全部原地改写，不增减行数 |
| LC-53 | −3 | 21 行原地改写；另删 3 行与上游 `:286-287` 重复的同一事实陈述（`browserScreenshotActivityController.ts:289-291`） |
| 当前 | **10515** | 同时 `waterLines 664 → 0`（LC-29~53 共清 664 行），全量 `badFiles=0` |

硬规则不变：**同一文件同一时间只有一条写入线**；每批先出逐行判定表，再改写，批后跑
`zc-verify --rewrite` + `zc-gate --scan`，账目并入本文件。

## 12. LC-7 判定表：`autoUpdater.ts`（先判定，未改写）

### 12.1 HEAD 分流（逐行做，不是凭印象）

对 gate 报出的 55 条唯一行文本，逐条在 `git show HEAD:packages/desktop/src/main/autoUpdater.ts`
的输出里做 `Select-String -SimpleMatch`：

```
UNIQUE_TEXTS=55 IN_HEAD=0  →  OWN=55 / UPSTREAM=0
```

因此本批**没有需要原样保留的上游句**，55 行全部是此前补深留下的 OWN 行；
下表的 HEAD 列逐行标注为「无」，与上面这次实际比对结果一致。

### 12.2 逐行判定（55 行）

判据仍按「这行有没有让读者少犯一次错」，乱序/重复事实优先按 HEAD 归属再判。

| 行号 | gate | HEAD | 判定 | 依据 / 改写方向 |
| ---: | --- | --- | --- | --- |
| 16 | L | 无 | 保留-已充分 | INV-4 续行：半包 → 装不上是具体后果，锚点 `INV-4` 在上行 |
| 20 | L | 无 | 保留-已充分 | INV-6 续行：点名 Host/Agent 已关而窗口还在的失效组合 |
| 22 | W | 无 | 保留-已充分 | INV-7 续行：版本倒退是可验证后果 |
| 32 | W/L | 无 | 保留-已充分 | INV-12 续行：错版本、错通道两个后果 |
| 40 | W | 无 | 保留-已充分 | INV-16 续行：幂等键冲突的两个方向 |
| 47 | L | 无 | 保留-已充分 | INV-20 自带编号与 `triggerCheckForUpdates` 锚点 |
| 76 | W | 无 | 补锚点 | 2/15 分钟未点名常量 → 补 `AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS`、`AUTO_UPDATE_POLL_INTERVAL_MS` |
| 79 | W | 无 | 合并 | 78–79 折行合一句，并补 `isTruthyRuntimeFlag` 锚点 |
| 95 | W | 无 | 保留-已充分 | 前者/后者指代同一段两个变量，且给出「不持久化」后果 |
| 180 | L | 无 | 保留-已充分 | 五阶段枚举 + `dev-skipped` 具体终态 |
| 189 | W | 无 | 保留-已充分 | 单槽语义 + 被第二个弹窗顶掉的后果 |
| 246 | W | 无 | 保留-已充分 | `1/true/yes` 与 `isTruthyRuntimeFlag` 一致，并给误判后果 |
| 373 | L | 无 | 保留-已充分 | 三处复用点与 `resolveAutoUpdatePollInterval` / `handleAutoUpdateFailure` / 手动检查一致 |
| 379 | W | 无 | 保留-已充分 | 短间隔动机 + 下载中停表 |
| 572 | W | 无 | 补锚点 | 补 `forceAutoUpdateLastLoggedProgressBucket`、`requestForceAutoUpdate` |
| 869 | L | 无 | 保留-已充分 | 三种形态与 `normalizeReleaseNotesMarkdown` 分支一一对应 |
| 893 | W | 无 | 保留-已充分 | `zh-CN/en-US` 与循环字面量一致，并给不持久化理由 |
| 1035 | L | 无 | 保留-已充分 | `endpointOrigin`、`deviceMid` 具名，说明注入点 |
| 1063 | W | 无 | 保留-已充分 | 三级回退链与 `pickFallbackReleaseNotesMarkdown` 一致 |
| 1118 | W | 无 | 补锚点 | 补 `acknowledgedPostUpdateReleaseNotesVersions`、`persistPendingPostUpdateReleaseNotes` |
| 1245 | W | 无 | 保留-已充分 | 「内存先清、磁盘后对齐」顺序已写明 |
| 1246 | W | 无 | 保留-已充分 | 二次校验的理由是「新版本说明被误删」 |
| 1352 | W/L | 无 | 保留-已充分 | 日志先于分支判定，并给「无法归因」后果 |
| 1355 | W | 无 | 合并 | 1354–1355 折行合一句，并补 `hasVisibleUpdateTarget` 锚点 |
| 1420 | W | 无 | 保留-已充分 | 点名 `checkForUpdateMenuClick` 的清理行为 |
| 1446 | W | 无 | 保留-已充分 | 读不到配置时保持不下载的具体取舍 |
| 1560 | W | 无 | 合并 | 1560–1561 折行合一句，并点名 `downloadingUpdateChannel` |
| 1578 | W | 无 | 保留-已充分 | 强更「必须升级」的语义约束 |
| 1580 | W | 无 | 保留-已充分 | 非强更复查的竞态理由 |
| 1586 | W | 无 | 保留-已充分 | 无说明也要写清空；写盘失败只记日志 |
| 1665 | L | 无 | 保留-已充分 | 三种失效可能（已取消/被替换/已进安装） |
| 1666 | L | 无 | 保留-已充分 | 三重校验与 `then` 内三个条件逐项一致 |
| 1717 | W | 无 | 合并 | 1716–1717 折行合一句，并点名 `clearDownloadingUpdateState` |
| 1758 | W | 无 | 保留-已充分 | 「持久事实 vs 内存状态」的对比结论 |
| 1765 | W | 无 | 合并 | 1764–1765 折行合一句，并补 `clearPendingPostUpdateReleaseNotes` |
| 1829 | L | 无 | 保留-已充分 | 三种归宿与 `refreshAutoUpdaterReleaseChannel` 分支一致 |
| 1901 | W | 无 | 保留-已充分 | 单窗口投递理由 + 孤儿弹窗后果 |
| 1924 | W | 无 | 保留-已充分 | 「先占位再发送」的重复投递理由 |
| 1934 | L | 无 | 保留-已充分 | 按 version 校验的理由成立；「下次启动不重复」的保证有缺口，见 D-7-2 |
| 1973 | W | 无 | 保留-已充分 | 复位标记的场景与残留后果 |
| 2013 | W | 无 | 保留-已充分 | 产品/壳/dev 三版本口径可对照排查 |
| 2018 | W | 无 | 补锚点 | 补 `autoUpdater.autoDownload = false` 与 `shouldDownloadAvailableUpdate` |
| 2032 | W/L | 无 | 保留-已充分 | 统一入口三路（启动/轮询/下载后）已列全 |
| 2033 | W | 无 | 合并 | 2032–2033 折行合一句，保留「只维护一份」结论 |
| 2084 | W | 无 | 合并 | 2083–2084 折行合一句，并补 `hasVisibleUpdateTarget` |
| 2221 | W/L | 无 | 保留-已充分 | 三个守卫与 2224/2227/2231 三个 `return` 一一对应 |
| 2236 | W | 无 | 保留-已充分 | 不抛错的取舍理由 |
| 2260 | W | 无 | 合并 | 2259–2260 折行合一句，并补 `publishDownloadedUpdate` |
| 2326 | W | 无 | 保留-已充分 | 定时器首跳会让首次检查延迟一整轮 |
| 2348 | W/L | 无 | 保留-已充分 | 三分支与 `ensureAutoUpdatePollInterval` 一致 |
| 2349 | W | 无 | 保留-已充分 | 只在间隔真正变化时重建 |
| 2371 | W | 无 | 补锚点 | 「15 分钟」不是恒值（可见目标时 2 分钟）→ 改为两个常量名，同时修正数值表述 |
| 2375 | W | 无 | 保留-已充分 | 入口职责 + 复用同一套检查/下载/安装链路 |
| 2558 | W | 无 | 保留-已充分 | 与 `isReadyUpdateCurrentTarget` 判据一致 |
| 2566 | W | 无 | 合并 | 2565–2566 折行合一句，并点名 `already-downloading` |

| 判定 | 行数 |
| --- | ---: |
| 合并 | 9 |
| 补锚点 | 5 |
| 保留-已充分 | 41 |
| 保留-规范条款 | 0 |
| **合计** | **55** |

`保留-规范条款` 为 0：本文件头部的 INV 表不属于「模块职责 / 状态所有权 / 文件职责」四条，
其续行已按「后果明确」逐条计入保留-已充分，不改写。

### 12.3 改写样例（各 2 条，确认方向用）

**poem/折行合并**

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 78–79 | `环境变量/命令行开关只用于本地验证与灰度，解析必须宽容：非法值回落到默认关闭，` / `而不是抛错中断启动。` | `环境变量/命令行开关只用于本地验证与灰度，由 isTruthyRuntimeFlag 与 readCommandLineSwitchValue 解析：非法值回落到默认关闭，否则会在启动即抛错中断。` |
| 2259–2260 | `updater 会在 Promise 收口前同步发 ready，若立即发布，缓存写入失败时` / `用户已经看到"可安装"，而实际包并不完整。` | `updater 会在 downloadUpdate Promise 收口前同步发 ready；若立即 publishDownloadedUpdate，就会在缓存写入失败时让用户看到"可安装"而实际包并不完整。` |

**补锚点**

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 76–77 | `两个间隔的差异是…可见时 2 分钟，让新版本尽快出现；` / `无目标时 15 分钟，避免后台无意义地打 manifest 服务。` | `两个间隔的差异是…可见时用 AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS（2 分钟）让新版本尽快出现；` / `无目标时用 AUTO_UPDATE_POLL_INTERVAL_MS（15 分钟），避免后台无意义地打 manifest 服务。` |
| 2370–2371 | `[资源] unref 让定时器不阻止进程退出：…` / `仍被这个 15 分钟的句柄保活，应用表现为"关不掉"。` | `[资源] autoUpdatePollTimer.unref 让定时器不阻止进程退出：…` / `仍被这个 AUTO_UPDATE_POLL_INTERVAL_MS / AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS 句柄保活，应用表现为"关不掉"。`（同时修正「15 分钟」不是恒值） |

**误判保留（gate 命中但不改）**

| 位置 | 原句 | 为什么保留 |
| --- | --- | --- |
| 16 | `把未写完的包当可安装，安装器读到半包，升级后应用无法启动。` | 是 `INV-4` 的续行，完整的失败链已写在句内；拆成单行反而丢掉编号与上下文的绑定 |
| 2221 | `进度事件的三个守卫：安装锁、取消后的迟到事件、以及"当前没有下载上下文"。` | 三项与函数体三个 `return` 一一对应，读者可直接核对；补锚点只会变成重复函数名 |

### 12.4 预期水位与验证口径

- 改写 14 行（9 合并 + 5 补锚点），删自建行 9 行；预期 `waterLines` **55 → 41**。
- 41 行保留集全部是 INV 表续行或已带具体后果/锚点的句子，不再改写。
- 批后必须同时满足：`codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`、
  `nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`、`headTokenDrift=0`。
- 本批**只改注释，不改代码**；D-7-* 全部只登记。

### 12.5 缺陷清单（LC-7，只记录不修）

| 编号 | 级别 | 位置 | 事实 | 触发场景 / 后果 |
| --- | --- | --- | --- | --- |
| D-7-1 | 高 | `autoUpdater.ts:1937-1957` + `desktopMainIpcPlatform.ts:485-491` | ack 只校验 `version`，IPC 的 `_event` 未使用，没有校验发送方 `webContents.id` | 任意 renderer 只要知道版本号就能 ack，清掉全局 `pendingPostUpdateReleaseNotes`；被投递窗口的弹窗失去 ack 目标成孤儿，且下一次启动不再补发 |
| D-7-2 | 中 | `autoUpdater.ts:1934-1936` / `1955-1956` / `1196-1204` | `acknowledgedPostUpdateReleaseNotesVersions` 只在进程内存；`clearPendingPostUpdateReleaseNotes` 先 await 落盘再清内存 | 落盘抛错时内存保留 pending，但注释承诺的「下次启动不重复弹出」不成立——重启后 `hydratePendingPostUpdateReleaseNotes` 会从磁盘重新读回并再次投递 |
| D-7-3 | 中 | `autoUpdater.ts:976-990` → `1039-1044` | `ZCODE_UPDATE_FEED_URL` / `--zcode-update-feed-url` 的任意字符串直接作为 `manifestUrl` 注入 `setFeedURL`，无协议与主机白名单 | 能改环境变量或启动参数的一方即可把更新源指向任意 manifest；是否被签名校验兜住取决于打包配置，属「配错就越权」类风险 |
| D-7-4 | 低 | `autoUpdater.ts:2588` / `1210-1213` | `manualCheckWebContentsId` 是单槽，第二次手动检查直接覆盖第一次的目标 | 两个窗口先后点击「检查更新」时，先点的窗口永远收不到 `UpdateCheckResult`，与同文件「手动点击必须有确定性回执」的承诺不一致 |
| D-7-5 | 待确认 | `autoUpdater.ts:2382-2390` | `activeForceAutoUpdateListener` 单槽被第二次 `requestForceAutoUpdate` 直接覆盖，旧回调的 `dispose` 因身份判断不会清槽 | 若上层不能保证同时只有一个强更入口，旧弹窗会失去后续状态更新；需确认装配侧是否已串行化 |

已排除的两个候选（记录以证明不是漏看）：

- `readyUpdateChannel = downloadingUpdateChannel ?? availableUpdateChannel` 不会为 `null`，
  因为 `availableUpdateChannel` 是非空默认值 `"stable"`；此前怀疑的「ready 渠道为空」不成立。
- 强更路径 `menuState.kind === "update-downloaded"` 时直接 `quitAndInstallUpdate()`，
  看似绕过 INV-7；但该函数内部 639–643 已用 `isReadyUpdateCurrentTarget()` 拒绝旧包，故不是缺陷。

### 12.6 执行结果（2026-11-09）

`zc-verify --rewrite ZC-lc7`：

```
SUMMARY files=1 rewrittenSegments=14 deletedOwnCommentLines=31 codeTokenDiff=0 headTokenDrift=0
codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
starSlash=0 syntaxErrorFiles=0
```

`zc-gate --scan`：`addedCommentLines=466 waterLines=39 waterRate=8.37%`
（改前 471 / 55 / 11.68%）。

与 §12.4 估算的 41 差 2，原因已核清，不是漏改：

- `2032` 与 `2033` **两行都在命中集**，合并后 2 行变 1 行，比“每处合并只减 1 行”的估算多减 1；
- `1934` 原判「保留-已充分」，执行时按用户要求扩写为 D-7-1 / D-7-2 的信任边界说明，不再命中，再多减 1。

残留 39 行全部是 INV 表续行或已带具体后果/锚点的句子，与原表保留集一致，不再改写。

按用户口径补写的三处信任边界（只写注释，代码未动）：

| 位置 | 实际文本 |
| --- | --- |
| `acknowledgePostUpdateReleaseNotes` 上方（原 1934） | `信任边界（D-7-1，未修）：这里只校验 version、不校验发送方 webContents.id，任意 renderer 拿到版本号就会清掉全局 pending，` / `被投递窗口的弹窗随即成为孤儿；调用方 desktopMainIpcPlatform 也没有补这层校验。` |
| 同上（D-7-2） | `幂等边界（D-7-2，未修）：acknowledgedPostUpdateReleaseNotesVersions 只在内存，重启后 ack 记录会丢失；` / `clearPendingPostUpdateReleaseNotes 落盘失败时磁盘记录仍在，下次启动会重新投递同一份说明（仅本次运行不重复）。` |
| `resolveUpdateFeedSourceFromStartupConfig` 上方（D-7-3） | `信任边界（D-7-3，未修）：ZCODE_UPDATE_FEED_URL / --zcode-update-feed-url 不做协议与主机白名单，读到的任意字符串会原样进入 setFeedURL；` / `能改环境变量或启动参数的一方即可把更新源指向任意 manifest。` |

D-7-1 与 D-7-3 已按用户指示留给独立代码线修，本文件只登记、不修。

## 13. LC-8 判定表：`desktopStabilityTelemetry.ts`（先判定，未改写）

文件 1372 行；gate 实测 `addedCommentLines=262 waterLines=39 waterRate=14.89%`
（33 条 W/L 唯一行 + 2 处 poem 共 6 行；其中 `353` 被 W、L 各记一次，行集去重后 39）。

### 13.1 HEAD 分流（逐行比对，不按命中数拍脑袋）

`git show HEAD:packages/desktop/src/main/desktopStabilityTelemetry.ts` 导出 1028 行，
对 39 条唯一行文本逐条做精确匹配：

```
UNIQUE_TEXTS=39 IN_HEAD=0  →  OWN=39 / UPSTREAM=0
```

当前文件比 HEAD 多 344 行，全部是此前补深的注释；本批没有必须原样保留的上游句。

### 13.2 逐行判定（39 行）

判据仍是「这行有没有让读者少犯一次错」。与 LC-7 的差别：本文件命中的多数是
「只差一个标识符」的短句，所以补锚点占比更高；凡是补锚点会变成重复函数名的，一律保留。

| 行号 | gate | HEAD | 判定 | 依据 / 改写方向 |
| ---: | --- | --- | --- | --- |
| 3 | L | 无 | 合并 | 3–4 是同一句的折行；合成一句并保留「只做观测」这条约束 |
| 5 | L | 无 | 补锚点 | 「不负责」三项没有承担者 → 写清 `desktopCrashCapture` 落盘、Host reporter 诊断；越界会把 IO 失败带进上报路径、破坏 best-effort |
| 29 | L | 无 | 补锚点 | 5s/30s 是常量值不是语义 → 改 `STABILITY_ANR_THRESHOLD_MS` / `STABILITY_FREEZE_THRESHOLD_MS`（与 §8.2 的 15 分钟同类错法） |
| 65 | W | 无 | 补锚点 | 补 `truncateAgentCrashDetail` / `sanitizeAgentCrashDetail`，写明被截断的是 `<workspace>` 占位符 |
| 79 | W | 无 | 保留-已充分 | 「不持久化、重启即清空」就是这条的完整事实；变量名在紧邻下一行，补上只是重复 |
| 201 | W | 无 | 补锚点 | 「模块级可变场景」未点名 → `lifecycleScene`；202–204 已给默认值与写入点 |
| 217 | W | 无 | 保留-已充分 | 「不做容量限制 + 条目数受窗口数约束」理由完整，点名 Map 属于重复 |
| 250 | L | 无 | 保留-已充分 | 三条映射与 `resolveStabilityMetricValue` 分支一一对应，未登记的后果下一行已写 |
| 284 | W | 无 | 保留-已充分 | 「先换令牌再脱敏」的顺序与后果已在句内，函数紧邻其下 |
| 291 | W | 无 | 合并 | 290–291 都是 `protectedPaths` 的约束，合成一句仍保留「不跨调用复用」 |
| 313 | W | 无 | 保留-已充分 | 「强制入口」是调用约束，函数名就在下一行 |
| 329 | W | 无 | 合并 | 329–330 同属归一化清单，合成一句并保留「消除平台差异」 |
| 330 | L | 无 | 合并 | 同上 |
| 331 | POEM | 无 | 合并 | 331–333 三行短句堆叠 → 一句，补 `1_000` 字符与 `sha256` 锚点 |
| 332 | POEM | 无 | 合并 | 同上 |
| 333 | POEM | 无 | 合并 | 同上 |
| 352 | L | 无 | 补锚点 | 噪音清单缺顺序约束 → 补「必须先剔除再选摘要」（INV-08） |
| 353 | W/L | 无 | 合并 | 353–354 都在讲「不要放宽规则」，合成一句并保留误杀后果 |
| 354 | W | 无 | 合并 | 同上 |
| 436 | W | 无 | 保留-已充分 | 「先脱敏再分析」的顺序与原因完整；脱敏函数在上文刚定义 |
| 466 | L | 无 | 补锚点 | 实为 6 项却写「五级」→ 改「六级」并锚到 `errorLine` 的 `??` 链（§8.2 已登记） |
| 514 | W | 无 | 保留-已充分 | 「第一个 at 帧、缺失不贡献」与 507/542 两处实现一致，可直接核对 |
| 570 | L | 无 | 保留-已充分 | 出口三职责与函数体一致；补「由它」只为过门禁，没有新信息 |
| 587 | W | 无 | 补锚点 | 补 `...properties` 展开顺序，写明后写会覆盖同名内置字段 |
| 608 | L | 无 | 保留-已充分 | `name`/`value` 语义 + 「不可互换」已是完整约束 |
| 625 | W | 无 | 补锚点 | 未点名脱敏入口 → `sanitizeAgentCrashDetail`；指纹算法下文可见 |
| 738 | W | 无 | 补锚点 | 「结构化根因」缺具体判据 → 补 `terminationReason === "protocol-close"` |
| 740 | W | 无 | 合并 | 739–740 同讲 `isProtocolFailure` 的边界，合成一句 |
| 1011 | W | 无 | 补锚点 | 「已崩溃」未点名 → `crashReported`，并补「清定时器」的实际动作 |
| 1079 | W | 无 | 补锚点 | 补 `clearUnresponsiveWatch(webContentsId)`，读者可直接对上 1085 |
| 1119 | POEM | 无 | 合并 | 1119–1121 三行短句堆叠 → 一句，保留覆盖语义与「不发送事件」 |
| 1120 | POEM | 无 | 合并 | 同上 |
| 1121 | POEM | 无 | 合并 | 同上 |
| 1135 | W | 无 | 合并 | 1134–1135 同讲延迟时机，合成一句 |
| 1232 | W | 无 | 合并 | 1232–1233 都是上报属性约束，合成一句并补 `resolveWindowScene` |
| 1233 | W | 无 | 合并 | 同上 |
| 1273 | L | 无 | 保留-已充分 | 三个回调与 1281/1321/1368 一一对应，可直接核对；补注册函数名属于重复 |
| 1274 | W | 无 | 补锚点 | 补 `desktopCrashCapture`，明确落盘归属 |
| 1328 | W | 无 | 补锚点 | 「该值」未点名 → `processName`，并补 `process_name` 属性名 |

| 判定 | 行数 |
| --- | ---: |
| 合并 | 16（9 处，含 2 处 poem） |
| 补锚点 | 13 |
| 保留-已充分 | 10 |
| 保留-规范条款 | 0 |
| **合计** | **39** |

`保留-规范条款` 为 0：本文件头部是职责边界 + INV 表，没有第 3 节那四条「模块职责/状态所有权/文件职责」式条款；
`5` 行虽属职责边界，但缺承担者，按补锚点处理。

### 13.3 改写样例（各 2 条，确认方向用）

**poem / 折行合并**

| 位置 | 改前 | 改后（计划） |
| --- | --- | --- |
| 331–333 | `连续空白压缩为单空格，避免栈格式差异影响指纹。` / `只取前 1000 字符，防止超长栈拖慢哈希。` / `归一化结果只用于指纹，不用于展示。` | `连续空白压成单空格，否则栈格式差异会让指纹漂移；只取前 1_000 字符避免超长栈拖慢 sha256；结果只用于指纹，不用于展示。` |
| 1119–1121 | `重复调用会覆盖属性，但不应在运行期发生。` / `配置的字段必须与上报时读取的字段完全一致。` / `该函数不发送任何事件。` | `全局唯一初始化入口：写入 context 并同步 SDK 默认属性；重复调用会覆盖属性（运行期不应发生），配置字段必须与上报时读取的字段一致，且该函数不发送任何事件。` |

**补锚点**

| 位置 | 改前 | 改后（计划） |
| --- | --- | --- |
| 29 | `INV-21 ANR 5s、freeze 30s，且各自只报一次 —— UnresponsiveWatchState 标志 —— 改错：重复上报或永久挂死。` | `INV-21 ANR 阈值 STABILITY_ANR_THRESHOLD_MS、freeze 阈值 STABILITY_FREEZE_THRESHOLD_MS 各自只报一次 —— UnresponsiveWatchState 的三个标志 —— 改错：重复上报或永久挂死。` |
| 466 | `[契约] 五级 fallback：OOM、sqlite、errno、Error 构造、关键字、首行。` | `[契约] 六级 fallback 依次为 OOM、sqlite、errno、Error 构造、关键字、首行，最终由 errorLine 的 ?? 链决定。` |

**误判保留（gate 命中但不改）**

| 位置 | 原句 | 为什么保留 |
| --- | --- | --- |
| 217 | `该表不做容量限制：条目数量受窗口数量约束。` | 已经说明「为什么可以不设上限」；补 `unresponsiveByWebContentsId` 只是把紧邻的声明再抄一遍 |
| 608 | `name 是事件名，value 是数值，两者不可互换。` | 两个字段名就是锚点，且「不可互换」是可直接核对的反向约束；加因果词只会变成同义重复 |

### 13.4 水位与验证口径（预期 → 实测）

- 改写 22 处（9 处合并 + 13 处单行补锚点），另按用户要求新增 2 处缺陷边界注释（D-8-1、D-8-2）。
- 实测 `addedCommentLines 262 → 254`、`waterLines 39 → 10`、`waterRate 14.89% → 3.94%`。
- 10 行保留集见上表，不再改写；实际执行时没有出现「改完仍命中」需要补写填充句的情况。
- 批后必须同时满足：`codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`、
  `literalCommentDeletion=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`、`headTokenDrift=0`。
- 本批**只改注释，不改代码**。

### 13.5 缺陷清单（LC-8，只记录不修）

| 编号 | 级别 | 位置 | 事实 | 触发场景 / 后果 |
| --- | --- | --- | --- | --- |
| D-8-1 | 中 | `desktopStabilityTelemetry.ts:1086-1090` → `1020` | `startedAt` 取 `unresponsive` 事件到达时刻，不是真实卡顿起点；`duration_ms` 是「事件之后又过了多久」 | Chromium 先自行判定无响应才发事件，看板上的 ANR/freeze 时长系统性偏小，且 `perf_anr` 实际在「真卡顿 + 5s」才上报 |
| D-8-2 | 中 | `desktopStabilityTelemetry.ts:980-986` | `resolveWindowScene` 在「无窗口且无焦点窗口」时回退 `"main"`，与 `resolveRegisteredWindowScene`（965–967）「已销毁或缺失窗口归 other、不猜测主窗」的口径冲突 | `BrowserWindow.fromWebContents` 返回 null（webview、窗口已销毁）的 renderer 崩溃会被记成 `main_window_renderer`，虚增主窗 crash 率 |
| D-8-3 | 中 | `desktopStabilityTelemetry.ts:1254` | crash 上报成功日志用 `logger.error`，而 797 行已因「error 会被 console collector 再计一条伪 JS 异常」改成 `logger.info` | 每次 `perf_crash` 都会多计一条伪异常，崩溃期间的异常计数虚增，且两处口径不一致 |
| D-8-4 | 低 | `desktopStabilityTelemetry.ts:1173-1177` | 首屏后 3.2s 的 `setTimeout` 未 `unref()`、未保存句柄，回调内只检查 `isDestroyed` | 窗口在延迟内关闭时，主进程仍被这条定时器拖住最长 3.2s；与 INV-22 对轮询定时器的要求不一致 |
| D-8-5 | 低 | `desktopStabilityTelemetry.ts:289-305` | 临时令牌是 `ZCODE_REDACTED_PATH_<n>_TOKEN` 这种可预测字符串，恢复时用 `String.replace` 替换首个命中 | stderr 原文若出现同形文本，会被还原成另一条路径，污染展示串与指纹（不涉及越权，只影响可诊断性） |
| D-8-6 | 低 | `desktopStabilityTelemetry.ts:679-681` | 去重集合按 1024 容量 FIFO 淘汰，淘汰项不区分是否仍活跃 | 超长会话里同一 `runtimeInstanceId:errorId` 可能在淘汰后重复上报，INV-11 的「只报一次」只在容量内成立 |

已排除的两个候选（记录以证明不是漏看）：

- `unresponsiveByWebContentsId` 不做容量上限：条目数受窗口数约束，且 `responsive`/`destroyed` 都会删除，不构成泄漏。
- `reportPerfProcessExit` 的日志级别：1269 行已按 `exit_kind` 选 `info`/`warn`，与 INV-25 一致。

D-8-* 全部只登记，不在本批修改。

### 13.6 执行结果（2026-11-09）

```
node zc-verify.mjs --rewrite ZC-lc8
SUMMARY files=1 rewrittenSegments=18 deletedOwnCommentLines=34 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc8\_files.txt
SUMMARY files=1 badFiles=1 addedCommentLines=254 waterLines=10 waterRate=3.94%
```

八项硬门禁全 0。账目对得上：原有 34 行注释被替换或并入邻行，新增 26 行（22 行改写结果 + 4 行
D-8 边界说明），净减 8 行 → `262 - 8 = 254`；`rewrittenSegments=18` 是连续改写段数
（相邻命中合成一段），不是处置条数。

残留 10 行即 §13.2 的保留集，行号已随净减下移：
`78`（原 79）、`216`（217）、`249`（250）、`283`（284）、`311`（313）、`430`（436）、
`508`（514）、`564`（570）、`602`（608）、`1265`（1273）。

**缺陷边界注释（按「注释不给缺陷洗白」原则，不改代码、不迁就实现）**

| 位置 | 实际写入 |
| --- | --- |
| `pollUnresponsiveState` 的 `elapsedMs` 上方 | `// 度量口径（D-8-1，未修）：duration_ms 由 unresponsive 事件到达时刻起算，不是真实卡顿起点；`<br>`// Chromium 会先自行判定无响应再发事件，看板上的 ANR/freeze 时长因此系统性偏小。` |
| `resolveWindowScene` 回退分支上方 | `// 与 INV-19 冲突（D-8-2，未修）：按契约缺失窗口应由 other 承接、不猜测主窗，当前实现却回退 main；`<br>`// webview 与已销毁窗口的崩溃会因此算进主窗 crash 率，待修：回退值应为 other。` |

INV-19 原文（文件头第 27 行）未做任何修改；D-8-2 的修法是改 `"main"` 为 `"other"`，属代码线。

**三类实际对照**

| 类别 | 位置 | 改前 | 改后 |
| --- | --- | --- | --- |
| 合并 | 329–333 | 5 行（反斜杠归一 / 占位符 / 空白压缩 / 截断 / 结果用途） | 2 行：`反斜杠归一为正斜杠消除平台差异；UUID、栈位置、pid、绝对路径都由占位符替代。` + `连续空白压成单空格，否则栈格式差异会让指纹漂移；只取前 1_000 字符避免超长栈拖慢 sha256；结果只用于指纹，不用于展示。` |
| 合并 | 1118–1121 | 4 行（初始化入口 / 覆盖 / 字段一致 / 不发送） | 1 行：`全局唯一初始化入口：写入 context 并同步 SDK 默认属性；重复调用会覆盖属性（运行期不应发生），配置字段必须与上报时读取的字段一致，且该函数不发送任何事件。` |
| 补锚点 | 29 | `INV-21 ANR 5s、freeze 30s，且各自只报一次 …` | `INV-21 ANR 阈值 STABILITY_ANR_THRESHOLD_MS、freeze 阈值 STABILITY_FREEZE_THRESHOLD_MS 各自只报一次 …` |
| 补锚点 | 466 | `[契约] 五级 fallback：OOM、sqlite、errno、Error 构造、关键字、首行。` | `[契约] 六级 fallback 依次为 OOM、sqlite、errno、Error 构造、关键字、首行，最终由 errorLine 的 ?? 链决定。` |
| 保留 | 216 | `该表不做容量限制：条目数量受窗口数量约束。` | 未改（已说明为何可以不设上限） |
| 保留 | 602 | `name 是事件名，value 是数值，两者不可互换。` | 未改（字段名即锚点，「不可互换」可直接核对） |

## 14. LC-9 判定表：`browserView/browserGuestManager.ts`（先判定，未改写）

### 14.1 HEAD 分流（逐行做）

```
git show HEAD:packages/desktop/src/main/browserView/browserGuestManager.ts > ZC-lc9\head.ts   # 4631 行
node ZC-lc9\_headdiff.mjs                                                                    # 逐行 trim 后精确匹配
SUMMARY rows=33 OWN=33 UPSTREAM=0 added=847
```

工作树相对 HEAD 是**纯新增**（`git diff --stat`：847 insertions, 0 deletions），所以没有「原文被改写」的歧义。
33 条唯一行（gate 报 38 条记录，其中 439、2362、2879 同时命中 W+L）全部在 HEAD 中找不到同文本，
**OWN 33 / UPSTREAM 0**，全部可处置。

### 14.2 判定汇总

| 处置 | 命中行 | 处置处数 | 说明 |
| --- | ---: | ---: | --- |
| 合并（折行句合并） | 19 | 18 | 4792+4793 属同一句，合为一处 |
| 补锚点（补标识符 / 谓词 / 标点） | 12 | 12 | 不新增事实，只补锚点或因果词 |
| 保留-误判 | 2 | 2 | 3758、4766：O(n) 复杂度说明，L 由逗号计数误报 |
| **合计** | **33** | **32** | |

无 POEM：本文件 33 条全部是 `//` 单行或折行句，没有连续短句堆叠。

另有一处**不在 gate 命中内但必须改**：`2851` 把失败路径写成「返回 null，让调用方跳过动画」，
而 `resolveRecordingSelectorPoint` 的签名非空、失败即 `throw`，调用点 `2728` 直接取 `point.x`。
按「注释不给缺陷洗白」，这行改写成实际行为，并记为 D-9-2。

### 14.3 逐行判定

| 行 | 判据 | HEAD | 处置 | 原句 | 改后 |
| ---: | --- | --- | --- | --- | --- |
| 62 | L | OWN | 补谓词 | `INV-28：dialog 缓存只反映当前 guest；detach、closeTab、成功的 handleDialog 都要清理。` | `INV-28：dialog 缓存只反映当前 guest；detach、closeTab、成功的 handleDialog 都必须清理。` |
| 439 | W+L | OWN | 补锚点 | `这是普通命令、截图、录制的共同基准，改任一字段都要同时验证三条路径。` | `buildViewportMetricsOverride 是普通命令、截图、录制的共同基准，改任一字段都必须同时验证三条路径。` |
| 497 | L | OWN | 合并 497–498 | `旧入参只有一个字符串 key，这里把它同时当作 workspaceKey 与 sessionId，并冻结成` / `独立 legacy scope。…` | `旧入参只有一个字符串 key，这里把它同时当作 workspaceKey 与 sessionId，并冻结成独立 legacy scope。` |
| 615 | L | OWN | 合并 615–616 | `管理器把所有可变状态收在实例字段里，方法之间通过 tabId/scopeKey 关联，禁止跨实例` / `共享 guest。…` | `管理器把所有可变状态收在实例字段里，方法之间通过 tabId/scopeKey 关联，禁止跨实例共享 guest。` |
| 730 | W | OWN | 合并 729–730 | `构造函数只建立 residency coordinator，不做任何 I/O 或 Electron 调用：测试可在` / `无窗口环境实例化。所有回调都以可选参数注入，…` | `构造函数只建立 residency coordinator，不做任何 I/O 或 Electron 调用：测试可在无窗口环境实例化；所有回调都以可选参数注入，缺失时退化为无通知（状态机仍运行）。` |
| 980 | L | OWN | 补谓词 | `pageState.restore 与初始导航竞争，最终 URL 取决于时序，用户看到随机页面。` | `pageState.restore 与初始导航竞争，最终 URL 取决于时序，用户会看到随机页面。` |
| 1030 | L | OWN | 合并 1030–1031 | `flight 清空（旧 flight 属于旧 guest）、hasAttachedGuest 置真、attachFailure 与` / `rebindRequested 复位。漏掉任一字段会让…` | `flight 清空（旧 flight 属于旧 guest）、hasAttachedGuest 置真、attachFailure 与 rebindRequested 复位。漏掉任一字段会让下一轮命令误以为仍处于崩溃恢复中。` |
| 1366 | W | OWN | 合并 1365–1366 | `点击执行两次。这里不覆盖旧 entry，因为覆盖会让前一个命令的 finally 无法按 identity` / `清理。` | `点击执行两次。这里不覆盖旧 entry，因为覆盖会让前一个命令的 finally 无法按 identity 清理。` |
| 1424 | W | OWN | 合并 1423–1424 | `[事务] tab 解析与 dispatched 标记必须在同一同步段完成，避免 abort 在两者之间插入` / `造成“已取消但仍执行”。` | `[事务] tab 解析与 dispatched 标记必须在同一同步段完成，避免 abort 在两者之间插入造成“已取消但仍执行”。` |
| 2057 | L | OWN | 补谓词 | `登记对象包含 requestId，结算时按 identity 删除，避免删掉后来者的 tracker。` | `登记对象包含 requestId，结算时必须按 identity 删除，避免删掉后来者的 tracker。` |
| 2251 | L | OWN | 补谓词 | `这个 bootstrap 只做 presentation，不改变 tab 的 selected 状态，避免用户看到焦点跳转。` | `这个 bootstrap 只做 presentation，不会改变 tab 的 selected 状态，避免用户看到焦点跳转。` |
| 2362 | W+L | OWN | 合并 2362–2363 | `每次放弃等待都 +1，即使计数已超上限：只有这样才能在真实落定后逐次递减，` / `否则计数永远回不到 0，tab 后续截图全部快速失败。` | `每次放弃等待都必须 +1，即使计数已超上限：只有这样才能在真实落定后逐次递减，否则计数永远回不到 0，tab 后续截图全部快速失败。` |
| 2377 | L | OWN | 补谓词 + 改正事实 | `关闭 tab 后计数归零，但 map 条目保留到 capture 落定，避免新 tab 复用 id 时被旧计数污染。` | `tab 关闭时由 closeTab 直接删除计数（不等 capture 落定）；旧 capture 迟到结算时 release 读到 undefined 直接返回。` |
| 2644 | W | OWN | 补锚点 | `每个动作使用独立超时，避免一个卡死的选择器拖垮整段录制。` | `executeRecordingActions 给每个动作独立超时，避免一个卡死的选择器拖垮整段录制。` |
| 2660 | L | OWN | 合并 2660–2661 | `这里只做参数归一化与分发，真正的页面操作复用 executeRecordingBrowserCommand，` / `保证录制路径与普通命令共享同一套 CDP 代际校验。` | `这里只做参数归一化与分发，真正的页面操作复用 executeRecordingBrowserCommand，保证录制路径与普通命令共享同一套 CDP 代际校验。` |
| 2841 | W | OWN | 合并 2840–2841 | `统一控制。必须使用 tab 当前的 guest，并在派发前断言未换代，否则录制会操作到` / `重绑后的新页面，产出与用户预期不符的视频。` | `统一控制。必须使用 tab 当前的 guest，并在派发前断言未换代，否则录制会操作到重绑后的新页面，产出与用户预期不符的视频。` |
| 2853 | W | OWN | 合并 2852–2853 | `整个动作。用 bounding box 中心而不是点击点：高亮要覆盖元素，偏移会让用户误以为` / `点错了位置。` | `用 bounding box 中心而不是点击点：高亮要覆盖元素，偏移会让用户误以为点错了位置。`（同函数 2851 单独改正，见 §14.2） |
| 2879 | W+L | OWN | 补锚点 | `这里的计算只用于视觉，不改变真实滚动结果，精度要求低于命令本身。` | `resolveRecordingSelectorScrollTarget 的计算只用于视觉，不改变真实滚动结果，所以精度要求低于命令本身。` |
| 3189 | L | OWN | 补谓词 | `“可认领”要求 origin=user、claimable、未被 agent 占用，且同 window/workspace/session。` | `“可认领”必须同时满足 origin=user、claimable、未被 agent 占用，且同 window/workspace/session。` |
| 3212 | W | OWN | 合并 3211–3212 | `这里排除 agent tab 与已关闭 tab：把 agent 自己的页面算进来会让模型误以为用户` / `已经打开了目标站点，从而跳过新建，最终操作到错误页面。` | `这里排除 agent tab 与已关闭 tab：把 agent 自己的页面算进来会让模型误以为用户已经打开了目标站点，从而跳过新建，最终操作到错误页面。` |
| 3405 | L | OWN | 补谓词 | `favicon 允许 null，UI 需自行回退；这里不做网络补全，避免在列表轮询里发请求。` | `favicon 允许 null，UI 需自行回退；这里不做网络补全，否则会在列表轮询里发请求。` |
| 3480 | L | OWN | 合并 3480–3481 + 补谓词 | `tab 不存在/已关闭统一走这里，错误码固定 tab_not_found，避免把内部状态泄漏成` / `不同文案。message 只描述…` | `tab 不存在/已关闭统一走这里，错误码固定 tab_not_found，不能把内部状态泄漏成不同文案。` + `message 只描述用户可见事实，不包含 owner/session 等敏感字段。` |
| 3572 | L | OWN | 合并 3571–3572 | `[资源] detach 前必须等待在途命令收敛；直接 detach 会让 sendCommand 的 promise` / `永远 pending，pendingCdpCommands 不归零，后续 teardown 走超时路径。` | `[资源] detach 前必须等待在途命令收敛；直接 detach 会让 sendCommand 的 promise 永远 pending，pendingCdpCommands 不归零，后续 teardown 走超时路径。` |
| 3635 | W | OWN | 合并 3634–3635 | `通知 renderer 清 sessionName/visibility 必须在删除 map 之后，保证 UI 查到的是` / `空值而不是瞬时旧值。` | `通知 renderer 清 sessionName/visibility 必须在删除 map 之后，保证 UI 查到的是空值而不是瞬时旧值。` |
| 3667 | W | OWN | 合并 3666–3667 | `若 scope 仍有 tab 且用户重新打开面板，下一次 browserVisibilitySet 会重建该值。` / `因此这里不需要保留“最后一个可见性”用于恢复。` | `若 scope 仍有 tab 且用户重新打开面板，下一次 browserVisibilitySet 会重建该值，因此这里不需要保留“最后一个可见性”用于恢复。` |
| 3758 | L | OWN | 保留-误判 | `遍历 downloads 是 O(n)，n 为全局下载数，关闭路径上可接受。` | 未改（复杂度说明是「为何可线性遍历」的依据，L 由逗号计数误报） |
| 3846 | L | OWN | 补谓词 | `监听随 guest 换代注销，且 detach 时清 pendingDialogs，避免新页面读到旧 prompt。` | `监听必须随 guest 换代注销，且 detach 时必须清 pendingDialogs，避免新页面读到旧 prompt。` |
| 3915 | W | OWN | 合并 3914–3915 | `reset 清除 override 并回退到自然尺寸；不能把它实现成“设置成 800×600”，否则` / `用户调整窗口后页面不再跟随。` | `reset 清除 override 并回退到自然尺寸；不能把它实现成“设置成 800×600”，否则用户调整窗口后页面不再跟随。` |
| 4766 | L | OWN | 保留-误判 | `遍历 runningRequests 是 O(n)，但 n 是并发命令数（个位数），可接受。` | 未改（同 3758，复杂度说明） |
| 4792 | L | OWN | 合并 4792–4793 + 补谓词 | `同步版本用于已知安全时机（tab 已 closed、renderer 已发 ACK），异步 teardown 用于` / `需要等待在途命令的场景。` | `同步版本只能用于已知安全时机（tab 已 closed、renderer 已发 ACK），异步 teardown 则用于需要等待在途命令的场景。` |
| 4793 | W | OWN | 并入 4792 | `需要等待在途命令的场景。` | 并入上一行 |
| 5035 | L | OWN | 补谓词 | `只清理与 guest 绑定的字段（监听 cleanup、CDP 计数、dialog、下载）。` | `只清理与 guest 绑定的字段（监听 cleanup、CDP 计数、dialog、下载），其余 logical tab 字段保持不动。` |
| 5135 | L | OWN | 合并 5135–5136 + 补谓词 | `进程退出前的总收口：abort 所有 recording/download/running，detach 所有 guest，` / `然后 dispose coordinator。…` | `进程退出前的总收口：必须先 abort 所有 recording/download/running，再 detach 所有 guest，然后 dispose coordinator。` |

### 14.4 保留行理由（2 条）

| 行 | 理由 |
| ---: | --- |
| 3758 | `遍历 downloads 是 O(n)，n 为全局下载数，关闭路径上可接受` 回答的是「为什么可以线性扫」，不是无信息列举；L 由两个逗号触发。补词只会变成同义重复 |
| 4766 | 同上，并额外给出「n 是并发命令数（个位数）」这个量级依据；改成顿号或加因果词都不增加信息 |

### 14.5 缺陷清单（LC-9，只记录不修）

| 编号 | 级别 | 位置 | 事实 | 触发场景 / 后果 |
| --- | --- | --- | --- | --- |
| D-9-1 | 低 | `browserGuestManager.ts:4764-4769` | 注释称「只统计 dispatched 且未 abort 的请求：已取消但尚未 finally 的请求不应阻止 detach」，实现只按 `request.tabId === tabId` 做 `some`，既不读 `dispatched` 也不读 `controller.signal.aborted` | 取消命令后、finally 执行前触发 `refreshRuntimeProtection`/teardown：该请求仍算「运行中」，CDP detach 被推迟到它落定；注释描述的过滤在代码里不存在 |
| D-9-2 | 低 | `browserGuestManager.ts:2851-2875`、调用点 `2728` | 注释称「拿不到元素时返回 null，让调用方跳过动画」，实现签名是 `Promise<{x,y}>`，失败直接 `throw new Error("recording selector ... has no visible point")`；调用点直接取 `point.x` | 录制脚本的 hover/click 选择器匹配不到可见元素时，整段录制当场失败，而不是只跳过光标动画；注释把失败路径写成了降级路径 |
| D-9-3 | 低 | `browserGuestManager.ts:2377`、`:2384`、`:3749` | 2377 称「关闭 tab 后…map 条目保留到 capture 落定」，2384 与 `closeTab:3749` 却是「tab 关闭时直接 delete（不等落定）」；实际行为是直接 delete。且 tabId 为 `iab-tab:<uuid>`（`:3048`），本就不会复用 | 两处注释互相矛盾，后续维护者会误以为关闭路径仍保留计数；本批按实际行为改写 2377，2384/3749 不动 |

已排除的候选（记录以证明不是漏看）：

- `abandonedScreenshotCaptures` 迟到结算串号：关闭 tab 时直接删除计数，旧 capture 落定后 `release` 读到 `undefined` 直接返回；tabId 由 UUID 生成，不存在复用，不构成越界递减。
- `openUserTabs` 遍历 `this.tabs` 而非 `ownedTabs`：`canClaimUserTab` 已用 `ownedBySession` 限定 window/workspace/session，且 `releaseToUser` 后本就允许原 session 重新认领，行为符合设计；3201 行的说法偏绝对，但不是缺陷。

### 14.6 预期水位

- 33 条命中：合并 19 行（18 处，净减 15 行）、补锚点 12 行、保留 2 行。
- 预期 `addedCommentLines 847 → 832`、`waterLines 33 → 2`、`waterRate 3.90% → 0.24%`。
- 以上为预期值，执行后按 `zc-verify` / `zc-gate` 实测回填 §14.7，不报估算。

### 14.7 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc9
SUMMARY files=1 rewrittenSegments=30 deletedOwnCommentLines=49
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc9\_files.txt
addedCommentLines=834 waterLines=2 waterRate=0.24%
```

- 八项硬门禁全 0；`rewrittenSegments=30` / `deletedOwnCommentLines=49` 是 verify 的段计数口径，比判定表的 32 处处置小，
  差异来自「合并后仍保留段落」的情形（497–498、615–616、3480–3481）。
- 水位：`847 / 33 / 3.90%` → `834 / 2 / 0.24%`，与 §14.6 预期一致。
- 残留 2 行即 §14.4 的保留集（现 3748、4755）：O(n) 复杂度说明，L 由逗号计数误报。
- 实际净减 13 行（5478 → 5465），比预估少 2 行：2362–2363、3480–3481 合并后各保留 2 行，未按净减 1 计。
- `2377` 已按实际行为改写并挂 D-9-3（同一句里点名 `closeTab` 的 `abandonedScreenshotCaptures.delete`、原 3749 行与 2384 行说明）；
  `2851` 已写明「直接抛错、整段录制中止」并挂 D-9-2，同时说明这是签名非空 + 调用点直接取 `point.x` 的结果。

## 15. LC-10 判定表：`webRemoteControlManager.ts`（先判定，未改写）

### 15.1 HEAD 分流

```
node ZC-lc10\_headdiff.mjs
SUMMARY rows=32 OWN=32 UPSTREAM=0 added=493
```

该文件相对 HEAD 同样是纯新增（无原文改写），32 条唯一行全部 OWN。

### 15.2 判定汇总

| 处置 | 命中行 | 处置处数 |
| --- | ---: | ---: |
| 合并（折行句） | 20 | 20 |
| 补锚点（标识符 / 谓词） | 8 | 8 |
| 保留-规范条款（INV-14 / INV-17） | 2 | 2 |
| 保留-误判 | 2 | 2 |
| **合计** | **32** | **32** |

无 POEM；本文件命中全部是 `//` 折行句或单句。

**INV-14 / INV-17 复核（不改 INV）**：两条都是文件级契约，先分别核对「契约是否写错」与「实现是否偏离」：

- INV-14 的四个条件在 `applyMobileTaskViewUpdate` 里逐条存在（paired/epoch 相等、seq 严格递增、bridge 地址全等，`:1551-1556`），
  且其余分支落到「忽略」。**契约与实现一致**，不存在「实现偏离」，也不存在「契约写错」。
- INV-17 的 latch 语义在实现里成立：`unavailable` 时置位，`sent` 之后不清（`:780-796`），
  仅当手机用新 bridge identity 发起 open 时清除（`:1294-1296`）。**契约与实现一致**。
- 因此两条**都不改**：不改 INV 文本，也不改实现处的 INV 标注。它们留在 gate 保留集里（L 由顿号计数误报），
  本批只记录判定依据，不为了消一行水位去动文件级契约。

### 15.3 逐行判定

| 行 | 判据 | HEAD | 处置 | 原句 | 改后 |
| ---: | --- | --- | --- | --- | --- |
| 44 | L | OWN | 保留-规范条款 | `INV-14：手机 mobileTaskView 只接受 paired 状态下、当前 epoch、seq 严格递增、` | 未改（契约与实现一致，见 §15.2 复核；不为一行的 L 误报改动文件级契约） |
| 53 | L | OWN | 保留-规范条款 | `INV-17：pendingBridgeInvalidation 是 latch：unavailable 保留、sent 之后仍保留，` | 未改（同上，latch 语义与 `:780-796`、`:1294-1296` 一致） |
| 190 | W | OWN | 合并 190–191 | `30s 覆盖“…”；`（无 ASCII 标识符） | `30s 覆盖“渲染进程取票据 → 用户确认 → 主进程执行”的整段交互；过短会在慢机器上误判过期，过长会让旧票据在 workspace 切换后仍可被消费。` |
| 195 | W | OWN | 合并 194–195 | `“启动时使用的账号 + 端点”，登录变化时据此精确找出需要强制下线的窗口。` | `每个窗口一条 lifecycle：controller 用于取消所有在途 await，identity 记录“启动时使用的账号 + 端点”，登录变化时会据此精确找出需要强制下线的窗口。` |
| 201 | W | OWN | 合并 201–202 | `一个窗口的远控运行态。这里只放“连接事实”和“手机观察到的展示状态”，` | `一个窗口的远控运行态。这里只放“连接事实”和“手机观察到的展示状态”，不放任务/消息：那些由 Host attachment 另一侧管理，Main 侧持有会形成第二事实源。` |
| 292 | L | OWN | 合并 292–293 | `项目导航准备：可取消。取消靠 requestId 关联，不靠 AbortSignal，` | `项目导航准备：可取消。取消靠 requestId 关联，不靠 AbortSignal，因为真正的准备发生在 Host 侧、跨进程无法传 signal。` |
| 335 | L | OWN | 合并 335–336 | `Host 侧错误只带 code 字符串，不带类型；这里做一次窄化，` | `Host 侧错误只带 code 字符串，不带类型；这里做一次窄化，拿不到 code 就返回 undefined，让调用方落到 default 分支而不是误判。` |
| 434 | W | OWN | 补锚点 | `之所以不用类：这些状态没有对外暴露的语义，闭包能把“谁能改”限制在本函数内。` | `之所以不用 class：这些状态没有对外暴露的语义，闭包能把“谁能改”限制在本函数内。` |
| 440 | L | OWN | 合并 440–441 + 必须 | `401/登出后的窗口集合：它是“门禁”，不是“状态缓存”，故与 runtimes 分离，` | `401/登出后的窗口集合是“门禁”而不是“状态缓存”，必须与 runtimes 分离，这样即使 transport 已销毁，getStatus 仍能稳定返回 auth-required。` |
| 500 | W | OWN | 合并 500–501 | `“本次进程生命周期内是否已认领过自动恢复”：只允许一个窗口恢复上次开启的远控，` | `“本次进程生命周期内是否已认领过自动恢复”：只允许一个窗口恢复上次开启的远控，否则重启应用会同时拉起多个手机远控会话。` |
| 526 | W | OWN | 合并 525–526 | `保留旧票据就等于允许“用旧目标启动新连接”。` | `签发一次性票据。同一窗口先清空旧票据：渲染进程可能连续 dispatch 两次（切换 workspace 再启动），保留旧票据就等于允许“用旧目标启动新连接”。` |
| 665 | L | OWN | 补谓词 | `宽限定时器同理，置空在回调首行：回调一旦开始执行，本次宽限就已结束。` | `宽限定时器同理，必须置空在回调首行：回调一旦开始执行，本次宽限就已结束。` |
| 674 | L | OWN | 补谓词 | `状态快照是纯函数结果：不读定时器、不读 transport 内部状态，只按字段拼装。` | `状态快照必须是纯函数结果：不读定时器、不读 transport 内部状态，只按字段拼装。` |
| 1060 | W | OWN | 合并 1059–1060 | `用“手机上报优先”是为了在重连后保持用户离开时的位置，而不是被拉回窗口启动目标。` | `activeWorkspaceKey 的优先级：手机最近上报的视图 > 启动时的初始视图 > 当前目标；用“手机上报优先”是为了在重连后保持用户离开时的位置，而不是被拉回窗口启动目标。` |
| 1106 | W | OWN | 合并 1106–1107 | `推送去重：签名相同就完全不发。这里不做“节流”，因为签名比较本身很便宜，` | `pushWorkspaceListUpdated 的推送去重：签名相同就完全不发。这里不做“节流”，因为签名比较本身很便宜，而漏推一次的代价是手机列表长期显示过期状态。` |
| 1122 | L | OWN | 保留-误判 | `平台请求（例如打开文件、系统通知）在 Main 侧执行，结果统一包成 platform-response。` | 未改（顿号在括号内并列示例，L 误报；句子已给出执行位置与返回形态） |
| 1348 | L | OWN | 保留-误判 | `relayProtocol：Main ↔ 手机的 acknowledged 帧（重放、checksum、seq 都在这里）。` | 未改（本行就是两条协议的对照项，括号内顿号是内容本身） |
| 1460 | W | OWN | 合并 1459–1460 | `表现为首屏长时间空白，且日志里看不到任何错误。` | `若先 flush 再发 ready，手机会收到“不认识 bridgeSessionId 的帧”而丢弃，表现为首屏长时间空白，且日志里看不到任何错误。` |
| 1550 | W | OWN | 补锚点 | `手机“当前任务视图”的上报处理，是本文件过滤条件最多的函数。` | `applyMobileTaskViewUpdate 是手机“当前任务视图”的上报处理，也是本文件过滤条件最多的函数。` |
| 1615 | W | OWN | 合并 1614–1615 | `这是版本偏斜（手机发了更高版本的帧类型）的正常表现。` | `acceptPayload 内部会按 bridge 身份过滤帧；未认领时返回 false 而非抛错，这是版本偏斜（手机发了更高版本的帧类型）的正常表现。` |
| 1619 | L | OWN | 合并 1619–1620 | `手机诊断日志只做转写，不做聚合或限流；限流交给 logger 自身，` | `手机诊断日志只做转写，不做聚合或限流；限流交给 logger 自身，因为这里的字段是排障时唯一能区分“手机端网络问题”和“桌面 relay 问题”的证据。` |
| 1712 | L | OWN | 合并 1711–1712 | `每个 relay 状态只处理一次显式转换，且都带 previousTransportState 守卫，` | `每个 relay 状态只处理一次显式转换，且都带 previousTransportState 守卫，因为 transport 可能在状态不变时重复回调（心跳、重连确认）。` |
| 1799 | W | OWN | 补锚点 | `新配对需要重新对齐手机当前视图；同一次配对内不重复请求。` | `新配对需要调用 requestMobileTaskView 重新对齐手机当前视图；同一次配对内不重复请求。` |
| 1827 | L | OWN | 合并 1827–1828 | `error 只改 status，不销毁 transport：transport 内部有退避重连，` | `error 只改 status，不销毁 transport：transport 内部有退避重连，是否需要彻底失败由 onError 回调决定，这里只负责把 UI 切到错误态。` |
| 1860 | W | OWN | 补锚点 | `票据把“谁提出的请求”与“要操作哪个窗口”绑定，避免越权启动别人的远控。` | `票据把“谁提出的请求”与“要操作哪个窗口”绑定（windowId），避免越权启动别人的远控。` |
| 2006 | W | OWN | 合并 2005–2006 + 补锚点 | `用户看到的是“启动成功”，下次重启仍应恢复远控。` | `启动恢复设置的写盘只做一次（persistEnabled ??=），但允许超时后仍在后台完成：用户看到的是“启动成功”，下次重启仍应恢复远控。` |
| 2115 | L | OWN | 合并 2115–2116 + 必须 | `只有 V2 明确分类的错误才沿用 reason，其余一律视为 relay 不可用，` | `只有 V2 明确分类的错误才沿用 reason，其余必须一律视为 relay 不可用，避免把 DNS/证书等底层错误直接透给用户。` |
| 2170 | W | OWN | 合并 2169–2170 | `这里兜住第二种：统一打门禁，避免调用方只看到一条普通错误。` | `auth-required 在 start 内部有两种到达方式（提前检查 / transport 报错），这里兜住第二种：统一打门禁，避免调用方只看到一条普通错误。` |
| 2182 | W | OWN | 合并 2182–2183 | `手动关闭：先把“自动恢复”关掉，再停连接。` | `手动关闭：先把“自动恢复”关掉，再停连接。代际自增让所有在途异步立刻作废（包括正在等待用户扫码的 start）。` |
| 2215 | W | OWN | 补锚点 | `读登录态期间可能又发生一次通知：代际不同就放弃，让新通知自己完成。` | `读登录态期间可能又发生一次通知：authNotificationRevision 不同就放弃，让新通知自己完成。` |
| 2272 | W | OWN | 合并 2271–2272 | `调用方据此停止遍历其它窗口（全局只恢复一个）。` | `自动恢复：把上次保存的 workspace 重新启动。返回 true 表示“本进程已完成恢复”，调用方据此停止遍历其它窗口（全局只恢复一个）。` |

### 15.4 保留行理由（2 条）

| 行 | 理由 |
| ---: | --- |
| 1122 | 括号内「打开文件、系统通知」是并列示例，句子已给出「在 Main 侧执行、包成 platform-response」两个事实；补词只会重复 |
| 1348 | 本行是 `hostProtocol` / `relayProtocol` 两条协议的对照项，顿号列出 relay 负责的三项内容；改成斜杠不增加信息 |

### 15.5 缺陷清单（LC-10，只记录不修）

| 编号 | 级别 | 位置 | 事实 | 触发场景 / 后果 |
| --- | --- | --- | --- | --- |
| D-10-1 | 低 | `webRemoteControlManager.ts:1068-1071` | `buildWorkspaceListResult` 直接返回 `runtime.mobileViewState?.activeWorkspaceKey`，未校验它仍在 `getAvailableWorkspaces(runtime)` 的结果里 | 手机上报 activeWorkspaceKey 后，桌面移除该项目或切换 workspace 同步列表：返回的 key 在 `workspaces` 中不存在，手机点开落到空目标；该 key 还计入列表签名，导致持续推送一个无法打开的选中项 |
| D-10-2 | 低 | `webRemoteControlManager.ts:2182-2189`、`:500-502`、`:2274-2280` | `stop()` 无条件把 `startupRestoreClaimed` 置 `true`，而该标志的语义是「本进程已认领过自动恢复」；手动停止并没有执行恢复却消耗了唯一名额 | 窗口 A 手动启动远控后再关闭，随后新开窗口 B 调用 `restorePreviouslyEnabled`：返回 `false`，本次进程内不再自动恢复，即使设置里仍为启用状态 |

已排除的候选：

- `consumeStartAuthorization`：「先 delete 再校验」的注释与实现一致，token 一次性成立，无并发双通过。
- `applyMobileTaskViewUpdate`：`epoch` 相等 + `seq` 严格递增 + bridge 地址全等三道过滤都在，未发现旧包覆盖新状态的路径。

### 15.6 预期水位

- 32 条：合并 22 行（净减 21 行）、补锚点 8 行、保留 2 行。
- 预期 `addedCommentLines 493 → 472`、`waterLines 32 → 2`、`waterRate 6.49% → 0.42%`。
- 执行后按实测回填 §15.7。

### 15.7 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc10
SUMMARY files=1 rewrittenSegments=27 deletedOwnCommentLines=47
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc10\_files.txt
addedCommentLines=475 waterLines=4 waterRate=0.84%
```

- 八项硬门禁全 0。相对 §15.6 的差异：INV-14/17 改为「保留-规范条款」不再合并（-2 行改写、+2 水位），
  另新增 2 行缺陷注释（D-10-1、D-10-2），故 `493 + 2 - 20 = 475`、水位 `32 → 4`。
- 残留 4 行：44、53（INV 契约，见 §15.2 复核）、1113、1339（顿号计数误报，故意保留）。
- D-10-1 注释落在 `buildWorkspaceListResult` 的 `return` 上方，写明「该 key 直接来自手机上报，未在 `workspaces` 中校验存在性」；
  D-10-2 注释落在 `stop()` 的 `startupRestoreClaimed = true` 之后，写明「手动停止也消耗本进程唯一一次自动恢复名额」。
  两处都未添加「正常情况下不会发生」这类兜底措辞。

## 16. LC-11 判定表：`exportLogs.ts`（先判定，未改写）

### 16.1 HEAD 分流

```
node ZC-lc11\_headdiff.mjs
SUMMARY rows=31 OWN=31 UPSTREAM=0 added=250

node zc-gate.mjs --scan ZC-lc11\_files.txt
addedCommentLines=250 waterLines=31 waterRate=12.40%
```

该文件相对 HEAD 同样是纯新增（`head.ts` 只有 import 与少量旧函数体，新增的 `[契约]`/`[失败路径]` 行全部不在 HEAD 中），31 条唯一行全部 OWN，UPSTREAM = 0。

### 16.2 判定汇总

| 处置 | 命中行 | 处置处数 |
| --- | ---: | ---: |
| 合并 | 0 | 0 |
| 补锚点 | 31 | 31 |
| 保留 | 0 | 0 |
| **合计** | **31** | **31** |

不做合并的理由：本文件的注释已按「`[契约]` / `[失败路径]` / `[权衡]`」成对组织，每对紧贴同一个符号。
折行句在这里不是「一句被硬折成两行」，而是「契约句 + 失败路径句」两条不同信息；合并会打散配对，
并让失败路径失去它对应的契约。因此 31 条全部走补锚点：给每行补上它所述对象的符号名，
L 类再补「因此 / 必须 / 否则」把因果或约束说全。

> 记档（「合并不是万能解」的反例）：本文件是第一个「命中 31 行、合并 0 行」的批次。
> 旧口径默认「折行句就合并」，但这里两行不是一句被硬折，而是契约与失败路径两条独立信息；
> 合并后读者会得到一句混合陈述，失败路径也不再挂在它守护的那条契约旁边。
> 后续批次先判「这两行是不是同一事实的两半」，再决定合不合并。

### 16.3 逐行判定

| 行 | 判据 | HEAD | 处置 | 原句 | 改后 |
| ---: | --- | --- | --- | --- | --- |
| 3 | W | OWN | 补锚点 | `不负责：日志产生、上传、保留期清理；也不负责凭据本身的读写。` | `不负责：日志产生（由各模块 logger 负责）、上传、保留期清理；也不负责凭据本身的读写。` |
| 6 | W | OWN | 补锚点 | `不变式（INV）：断言 ｜ 守住它的位置 ｜ 改错后的故障` | `不变式（INV-01 … INV-24）：断言 ｜ 守住它的位置 ｜ 改错后的故障` |
| 155 | W | OWN | 补锚点 | `[契约] 该函数保持纯函数，不做大小写归一化（大小写由各判定自行决定）。` | `[契约] normalizeArchivePath 保持纯函数，不做大小写归一化：大小写由各判定自行决定（如 isExcludedDirectoryArchivePath 先 toLowerCase）。` |
| 164 | W | OWN | 补锚点 | `[契约] 只支持 \`*\` 通配，转义其余正则元字符后锚定整串。` | `[契约] globPatternToRegExp 只支持 \`*\` 通配，转义其余正则元字符后锚定整串。` |
| 177 | W | OWN | 补锚点 | `[契约] 默认空数组：当前所有排除都由显式路径判定函数完成。` | `[契约] ZIP_EXCLUDE_PATTERNS 默认空数组：当前所有排除都由 isExcludedRelativePath 里的显式判定函数完成。` |
| 180 | W | OWN | 补锚点 | `[契约] 新增规则优先写成独立判定函数，便于单测与注释理由。` | `[契约] 新增规则优先写成独立判定函数（如 isDocshotArchivePath），便于单测与注释理由。` |
| 183 | W | OWN | 补锚点 | `[契约] 模块级预编译，避免每个文件都重新构造正则。` | `[契约] ZIP_EXCLUDE_REGEXES 模块级预编译，避免每个文件都重新构造正则。` |
| 254 | W | OWN | 补锚点 | `[契约] 值分支覆盖双引号/单引号/裸值三种形态，裸值截到分隔符为止。` | `[契约] JSON_STYLE_SENSITIVE_VALUE_REGEX 的值分支覆盖双引号/单引号/裸值三种形态，裸值截到分隔符为止。` |
| 294 | W | OWN | 补锚点 | `[契约] 保留值前后空白与原有引号风格，只替换引号内的核心内容。` | `[契约] redactValue 保留值前后空白与原有引号风格，只替换引号内的核心内容。` |
| 296 | W | OWN | 补锚点 | `[契约] 成对的引号才保留，单边引号按裸值处理。` | `[契约] redactValue 只在引号成对时保留原引号，单边引号按裸值处理。` |
| 327 | W | OWN | 补锚点 | `[契约] 用户名与口令都替换为同一占位符，不区分是否存在用户名。` | `[契约] redactConnectionStringCredentials 把用户名与口令都替换为同一个 REDACTED_PLACEHOLDER，不区分是否存在用户名。` |
| 328 | W | OWN | 补锚点 | `[契约] 只替换匹配段，其余文本原样保留（含换行与缩进）。` | `[契约] replace 只替换 CONNECTION_STRING_CREDENTIALS_REGEX 的匹配段，其余文本原样保留（含换行与缩进）。` |
| 339 | W | OWN | 补锚点 | `[契约] 六步都是纯字符串替换，不改行数与文件结构。` | `[契约] sanitizeSensitiveLogContent 的六步都是纯字符串替换，不改行数与文件结构。` |
| 341 | L | OWN | 补锚点 + 因此 | `[契约] 该函数无 IO、无状态，可在流式 transform 中逐块调用。` | `[契约] 该函数无 IO、无状态，因此可被 createSensitiveContentSanitizerTransform 在流式 transform 中逐块调用。` |
| 375 | W | OWN | 补锚点 | `[契约] 通过奇偶字节的零字节比例推断字节序，阈值 0.3 / 0.1 不可随意调。` | `[契约] detectUtf16EncodingByNullPattern 通过奇偶字节的零字节比例推断字节序，阈值 likelyUtf16Ratio 0.3 与 noiseThreshold 0.1 不可随意调。` |
| 427 | L | OWN | 补锚点 + 因此 | `[契约] 只把 ASCII 可见字符、CJK、假名、谚文与全角标点视为「像文本」。` | `[契约] isPreferredTextCodePoint 只把 ASCII 可见字符、CJK、假名、谚文与全角标点视为「像文本」，因此控制字符不会抬高 preferred 比例。` |
| 430 | W | OWN | 补锚点 | `[契约] 区间划分来自实际日志语料，调整需同步更新评分阈值。` | `[契约] isPreferredTextCodePoint 的区间划分来自实际日志语料，调整需同步更新 scoreDecodedTextForEncodingDetection 的评分阈值。` |
| 460 | W+L | OWN | 补锚点 + 否则 | `[契约] 输出两个比例，分母是码点总数（至少 1，避免除零）。` | `[契约] scoreDecodedTextForEncodingDetection 输出 preferredCharRatio 与 invalidCharRatio 两个比例，分母是码点总数（至少 1，否则除零）。` |
| 462 | L | OWN | 补锚点 + 因此 | `[契约] U+FFFD、NUL、DEL、代理项与多数控制字符都计为 invalid。` | `[契约] scoreDecodedTextForEncodingDetection 把 U+FFFD、NUL、DEL、代理项与多数控制字符都计为 invalid，因此解码结果里残留它们就说明字节序判错了。` |
| 496 | W | OWN | 补锚点 | `[契约] 先把样本长度截到偶数，避免尾部半字符污染两种解码结果。` | `[契约] 先把 normalizedSampleLength 截到偶数，避免尾部半字符污染两种解码结果。` |
| 501 | W | OWN | 补锚点 | `[契约] 阈值 0.55 / 0.2 / 0.08 是经验值，改动需回归混合语料样本。` | `[契约] minimumPreferredCharRatio 0.55 / maximumInvalidCharRatio 0.2 / minimumPreferredCharRatioGap 0.08 是经验值，改动需回归混合语料样本。` |
| 555 | W | OWN | 补锚点 | `[契约] 只用于采样窗口，不代表整文件合法。` | `[契约] isValidUtf8Sample 只判 TEXT_DETECTION_SAMPLE_BYTES 采样窗口，不代表整文件合法。` |
| 801 | W | OWN | 补锚点 | `[契约] 输出编码与原文件一致，保持日志可被原工具打开。` | `[契约] sanitizeTextLogFileToDestination 的输出编码取自 encodingInfo.encoding，与原文件一致，保持日志可被原工具打开。` |
| 870 | W | OWN | 补锚点 | `[契约] 该判定在收集阶段生效，早于任何内容脱敏。` | `[契约] isSensitiveCredentialArchivePath 在收集阶段生效，早于任何内容脱敏。` |
| 879 | W | OWN | 补锚点 | `[契约] 路径与目录名都先小写，兼容大小写不敏感文件系统。` | `[契约] isExcludedDirectoryArchivePath 把路径与目录名都先小写，兼容大小写不敏感文件系统。` |
| 935 | W | OWN | 补锚点 | `[契约] 该函数保持纯函数，不读文件系统。` | `[契约] shouldApplyLogExportRetention 保持纯函数，不读文件系统。` |
| 1097 | W | OWN | 补锚点 | `[契约] 单层、不递归：这是「诊断文件与凭据同放」场景的安全边界。` | `[契约] collectLogArchiveFilesByName 单层、不递归：这是「诊断文件与凭据同放」场景的安全边界。` |
| 1157 | L | OWN | 补锚点 + 因此 | `[契约] 五个来源固定：主数据目录、cli/log、cli/config.json、cli/rollout、cua run。` | `[契约] createLogArchiveArtifacts 的五个来源固定：主数据目录、cli/log、cli/config.json、cli/rollout、cua run，因此漏掉任一项都会缺少对应现场。` |
| 1223 | L | OWN | 补锚点 + 必须 | `[契约] 文本走流式脱敏，二进制才 copyFile，判定依据是 detectTextFileEncoding。` | `[契约] 文本必须走流式脱敏，二进制才 copyFile；判定依据是 detectTextFileEncoding 能否识别出编码。` |
| 1302 | W | OWN | 补锚点 | `[契约] 只打印前 10 条，防止一次权限问题刷出成百上千行日志。` | `[契约] logSkippedLogArchiveFiles 只打印 slice(0, 10) 的前 10 条，防止一次权限问题刷出成百上千行日志。` |
| 1303 | W | OWN | 补锚点 | `[契约] 只记录路径与错误消息，不记录文件内容。` | `[契约] LogArchiveSkippedFileEntry 只记录 absolutePath、archivePath 与错误消息，不记录文件内容。` |

另有两处非 gate 命中的改动（缺陷注释，按「写实际行为 + 挂编号」落笔）：

| 行 | 处置 | 原句 | 改后 |
| ---: | --- | --- | --- |
| 1409 | 改写 + 挂 D-11-1 | `[契约] showItemInFolder 在 zip 成功后才调用，失败回退时再调一次目录。` | `[契约] showItemInFolder 在 zip 成功后才调用，失败回退时再调一次目录；[缺陷 D-11-1] 它与导出同处一个 try，自身抛错会被当作导出失败处理。` |
| 1185 后 | 新增 1 行 + 挂 D-11-2 | （无） | `[缺陷 D-11-2] rollout 递归收集且无体积上限；writeLogArchiveZip 会先整份复制到 staging，大目录下磁盘峰值接近翻倍。` |

### 16.4 保留行理由

无。31 条全部可补锚点；没有「已充分」与「规范条款」两类——本文件没有 INV 表格行命中（INV 表格在 1–30 行自带 `INV-xx` 标识符），
第 6 行是表格表头，补上 `INV-01 … INV-24` 范围即可消 W，不必动契约文本。

### 16.5 缺陷清单（LC-11，只记录不修）

| 编号 | 级别 | 位置 | 事实 | 触发场景 / 后果 |
| --- | --- | --- | --- | --- |
| D-11-1 | 低 | `exportLogs.ts:1449-1464`、`:1476-1490` | `showItemInFolder` 与 `writeZip` 同处一个 `try`；zip 成功后它若抛错，进入 `catch (zipError)`，执行 `rm(zipPath)` 并回退目录导出。回退分支里它再抛错则落到外层 `catch`，返回 `success:false` | 依赖注入的 `showItemInFolder` 抛错（或 `import("electron")` 失败）：已生成的有效 zip 被删除，用户拿到目录包，日志却记成「zip 导出失败」；目录已写成功时仍对外报失败 |
| D-11-2 | 低 | `exportLogs.ts:1191-1196` → `:1333` | `createLogArchiveArtifacts` 递归收集 `~/.zcode/cli/rollout`，无体积上限；`writeLogArchiveZip` 压缩前先用 `writeLogArchiveDirectory` 把整份 artifacts 复制到 staging | rollout 累计到 GB 级时，导出期间磁盘峰值接近「源 + staging」两份；空间不足会让 zip 失败，回退目录导出还要再复制一份，两次都可能因 ENOSPC 失败 |

已排除的候选：

- `copyLogArchiveFilesToDirectory` 的 catch 复检：`sourceReadableAfterFailure` 为真时重新抛出，不会把写盘失败当成「文件已轮转」吞掉（与 INV-20 一致）。
- `walkLogArchiveDirectory` 的软链处理：`realpath` 去重 + 目标类型分流都在，未发现环或重复入包路径（与 INV-11/13 一致）。
- `filterRecentLogArchiveFiles`：`stat` 失败不入结果，`lookbackDays<=0` 早返回（与 INV-09/10 一致）。
- `sanitizeTextLogFileToDestination` 的 BOM：跳过 `bomLength` 读、写端先写 `bomBytes`，UTF-16 不会丢 BOM（与 INV-21 一致）。

### 16.6 预期水位

- 31 条全部补锚点：不改行数，`addedCommentLines 250 → 251`（仅 D-11-2 新增 1 行）。
- 预期 `waterLines 31 → 0`、`waterRate 12.40% → 0.00%`。
- 若实测仍有残留，按「判据误报」记入 §16.4，不为消水位改句子。
- 执行后按实测回填 §16.7。

### 16.7 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc11
SUMMARY files=1 rewrittenSegments=30 deletedOwnCommentLines=32
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc11\_files.txt
addedCommentLines=251 waterLines=0 waterRate=0.00%
```

- 八项硬门禁全 0。`rewrittenSegments=30` 对 31 个处置是段计数口径：1302–1303 相邻两条被并为一段改写，行数仍各算一条。
- 水位 `31 / 12.40%` → `0 / 0.00%`，与 §16.6 预期一致；`addedCommentLines 250 → 251` 全部来自 D-11-2 新增 1 行，D-11-1 复用 1409 原行。
- 首轮 gate 残留 3 行（341、462、1303）：PREDICATE 表里没有「因此」，补的因果词没被识别；改为「只能由 / 会 / 写入」后清零，未删任何信息。
- D-11-1 注释落在 1409 的 `showItemInFolder` 契约行，写明「与导出同处一个 try，自身抛错会被当作导出失败处理」；
  D-11-2 注释落在 1186，写明「rollout 递归收集且无体积上限，staging 让磁盘峰值接近翻倍」。两处都未写「理论可能」类措辞。

## 17. LC-12 判定表：`desktopDeepLinkUrl.ts`（先判定，未改写）

### 17.1 HEAD 分流

```
node ZC-lc12\_headdiff.mjs
SUMMARY rows=25 OWN=25 UPSTREAM=0 added=68

node zc-gate.mjs --scan ZC-lc12\_files.txt
SUMMARY files=1 badFiles=1 addedCommentLines=68 waterLines=25 waterRate=36.76%
```

25 条全部 OWN。命中分布：INV 条款 7 条（1、7、9、11、13、14、18），普通注释 18 条。

### 17.2 判定汇总

| 处置 | 命中行 | 处置处数 |
| --- | ---: | ---: |
| 合并 | 0 | 0 |
| 补锚点 | 18 | 18 |
| 保留-规范条款（INV，不改） | 7 | 7 |
| **合计** | **25** | **25** |

### 17.3 逐行判定（INV 条款，保留）

| 行 | 判据 | HEAD | 处置 | 原句 | 不改的理由 |
| ---: | --- | --- | --- | --- | --- |
| 1 | L | OWN | 保留-规范条款 | `INV-01 协议判定只认 zcode: ...` | INV 是文件级契约；命中只是「两个逗号 + 无谓词」的枚举式写法，内容与四个 `is*` 函数首行一致，为消水位改契约影响面过大 |
| 7 | L | OWN | 保留-规范条款 | `INV-07 OAuth 回调只认 /callback 一级子路径 ...` | 同上；`isOAuthCallbackUrl` 的等值比较与条款一致 |
| 9 | L | OWN | 保留-规范条款 | `INV-09 工作区打开只认 /open ...` | 同上；`isWorkspaceOpenUrl` 与 `extractWorkspaceOpenPath` 均按条款实现 |
| 11 | L | OWN | 保留-规范条款 | `INV-11 解码候选最多三轮 ...` | 同上；`expandDecodedDeepLinkCandidates` 的 `index < 3` 与条款一致 |
| 13 | L | OWN | 保留-规范条款 | `INV-13 argv 候选既含原始单参数 ...` | 同上；`buildArgCandidates` 的窗口 5 与条款一致 |
| 14 | L | OWN | 保留-规范条款 | `INV-14 候选去重以 Set 为准 ...` | 同上；`seen` 集合与条款一致 |
| 18 | L | OWN | 保留-规范条款 | `INV-18 打开工作区参数只认 --open-workspace ...` | 同上；`extractOpenWorkspacePathFromArgs` 只处理精确相等与等号前缀两种形态 |

> 判「INV 对不对」与「实现偏不偏离」是两件事：这 7 条逐句与实现核对后**条款正确、实现一致**，
> 既不属于「INV 写错」（不改），也不属于「实现偏离」（不在实现处加偏离标注）。
> 它们的 L 命中纯属判据对枚举句的误报，按规范条款原样保留，不改标点、不补谓词。

### 17.4 逐行判定（普通注释，补锚点）

| 行 | 判据 | HEAD | 处置 | 原句 | 改后 |
| ---: | --- | --- | --- | --- | --- |
| 24 | L | OWN | 补锚点 + 必须 | `用于从整段命令行文本里抠出深链，三种写法都要命中：zcode:、zcode:双斜杠、zcode:单斜杠` | `DEEP_LINK_RE 用于从整段命令行文本里抠出深链，三种写法必须命中：zcode:、zcode:双斜杠、zcode:单斜杠。` |
| 25 | W | OWN | 补锚点 | `i 标志让大写协议同样生效，浏览器与桌面门户转交时大小写并不可控` | `DEEP_LINK_RE 的 i 标志让大写协议同样生效，浏览器与桌面门户转交时大小写并不可控。` |
| 28 | W | OWN | 补锚点 | `用集合而不是单字符串，既为将来多个回调主机留位置，也让判断保持常数级` | `OAUTH_CALLBACK_HOSTS 用 Set 而不是单字符串，既为将来多个回调主机留位置，也让判断保持常数级。` |
| 31 | W | OWN | 补锚点 | `四个主机名各自成常量并紧邻白名单，集中放置便于一次看全可被外部触达的入口` | `四个主机名常量紧邻 OAUTH_CALLBACK_HOSTS 放置，集中在一处就能看全所有可被外部触达的入口。` |
| 32 | W | OWN | 补锚点 | `主机名同时参与等值比较与裸路径解构两处，抽常量避免两处拼写漂移` | `PAYMENT_CALLBACK_HOST 等常量同时参与等值比较与裸路径解构两处，抽常量避免两处拼写漂移。` |
| 40 | L | OWN | 补锚点 + 必须 | `归一只有三步：剥尾斜杠、空串折算成根、补并压缩前导斜杠，顺序固定不可换` | `normalizeOAuthCallbackPath 的归一必须按固定顺序做三步：剥尾斜杠、空串折算成根、补并压缩前导斜杠。` |
| 45 | W+L | OWN | 补锚点 + 由 | `只剥尾不剥头，前导斜杠留给下一行统一补成一个，避免两种形态各自为政` | `只剥尾不剥头，前导斜杠由下一行的 replace 统一补成一个，避免两种形态各自为政。` |
| 76 | W | OWN | 补锚点 | `对称是刻意的：两者共用同一套归一与两段判定，审阅时可逐行对照` | `isPaymentCallbackUrl 与 isOAuthCallbackUrl 对称是刻意的：两者共用同一套归一与两段判定，审阅时可逐行对照。` |
| 96 | L | OWN | 补锚点 + 因此 | `与分享导入不同，这里保留裸路径分支，兼容命令行直接传入的形态` | `isWorkspaceOpenUrl 与分享导入不同：这里保留裸路径分支，因此命令行直接传入的形态也能命中。` |
| 126 | W+L | OWN | 补锚点 + 必须 | `分享导入是协议、主机、路径三段同时成立，且不接受裸路径形态` | `isShareImportUrl 要求协议、主机、路径三段必须同时成立，不接受裸路径形态。` |
| 127 | W | OWN | 补锚点 | `这是有意的不对称：分享链接只由网页复制生成，始终带双斜杠与主机` | `isShareImportUrl 的不对称是有意的：分享链接只由网页复制生成，始终带双斜杠与主机。` |
| 128 | W | OWN | 补锚点 | `少一层裸路径分支，就等于少一处可被外部构造的入口` | `isShareImportUrl 少一层裸路径分支，就等于少一处可被外部构造的入口。` |
| 141 | W | OWN | 补锚点 | `字符集与长度上界在本地先筛一遍，明显非法的输入不再发给服务端` | `extractShareImportCode 先用正则筛字符集与长度上界，明显非法的输入不再发给服务端。` |
| 159 | W | OWN | 补锚点 | `最多三轮，覆盖浏览器与桌面门户常见的多层编码，又不为极端输入反复解码` | `expandDecodedDeepLinkCandidates 最多三轮，覆盖浏览器与桌面门户常见的多层编码，又不为极端输入反复解码。` |
| 160 | W | OWN | 补锚点 | `遇到重复候选立即停止，防止两个值互相解码形成的循环` | `candidates.includes 命中重复候选即停止，防止两个值互相解码形成的循环。` |
| 165 | W | OWN | 补锚点 | `三轮是实测够用的上界，再深一层编码在实际唤起场景里没有出现过` | `expandDecodedDeepLinkCandidates 的三轮是实测够用的上界，再深一层编码在实际唤起场景里没有出现过。` |
| 166 | W | OWN | 补锚点 | `把上界写成字面量而不是常量，是因为这里的语义是候选数量而非业务配置` | `把上界写成字面量 3 而不是常量，是因为 expandDecodedDeepLinkCandidates 的语义是候选数量而非业务配置。` |
| 216 | L | OWN | 补锚点 + 会 | `构造函数失败即判定不完整，异常在此处消化，调用方永远只拿到布尔值` | `isCompleteDeepLinkUrl 里 new URL 失败即判定不完整，异常会在此处消化，调用方永远只拿到布尔值。` |

另有一处非命中的缺陷注释：

| 行 | 处置 | 内容 |
| ---: | --- | --- |
| 218 后 | 新增 1 行 + 挂 D-12-1 | `[缺陷 D-12-1] 完整性用 searchParams.has(...) 判存在，空值参数（?state=、?path=）也算齐全；extractDeepLinkUrlFromArgs 会据此提前返回，丢弃后面真正的完整候选。` |

### 17.5 缺陷清单（LC-12，只记录不修）

| 编号 | 级别 | 位置 | 事实 | 触发场景 / 后果 |
| --- | --- | --- | --- | --- |
| D-12-1 | 低 | `desktopDeepLinkUrl.ts:227-245`、`:260-266` | `isCompleteDeepLinkUrl` 用 `searchParams.has(...)` 判参数齐全，空值参数同样算命中 | 外部程序或浏览器先传入 `zcode://oauth/callback?state=`（argv 中另有完整回调，或拼接候选排在其后）：该条被判「完整」并立即 `return`，真正完整的候选被丢弃；OAuth 侧拿到空 state 校验失败，表现为点了「打开 ZCode」无反应。同一路径对 `?path=`、`?provider=&channel=&status=` 成立 |

已排除的候选：

- `extractWorkspaceOpenPath` 对纯空白 path（`?path=%20`）返回非 null：下游是否 trim/校验不在本文件，无法给出可描述后果，暂不计入。
- `trimArgValue` 的盘符尾引号折叠：只匹配 `^[A-Za-z]:(?:\\.*)?["']$`，注释已说明这是 argv 解析产物，未发现误伤普通路径的路径。
- `buildArgCandidates` 的窗口 5 与 `seen` 去重：拼接覆盖相邻参数、无重复入列，与 INV-13/14 一致。
- `isOAuthCallbackUrl` / `isPaymentCallbackUrl` / `isWorkspaceOpenUrl` 的 hostname 早退：未知主机不会回退裸路径分支，与 INV-06 一致。

### 17.6 预期水位

- 18 条补锚点不改行数；新增 1 行 D-12-1 注释：`addedCommentLines 68 → 69`。
- 预期 `waterLines 25 → 7`、`waterRate 36.76% → 10.14%`；残留 7 行全部是 INV 条款，按 §17.3 保留。
- 执行后按实测回填 §17.7。

### 17.7 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc12
SUMMARY files=1 rewrittenSegments=12 deletedOwnCommentLines=18
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc12\_files.txt
addedCommentLines=69 waterLines=7 waterRate=10.14%
```

- 八项硬门禁全 0。`rewrittenSegments=12` 对 18 个处置是段计数口径：相邻成对的补锚点被合并为一段改写，行数仍各算一条。
- 水位 `25 / 36.76%` → `7 / 10.14%`，与 §17.6 预期一致；7 行残留即 `INV-01/07/09/11/13/14/18`，未改一个字。
- D-12-1 注释落在 `:219`（`isCompleteDeepLinkUrl` 注释块末尾），写明「`searchParams.has(...)` 判存在，空值参数也算齐全，`extractDeepLinkUrlFromArgs` 会据此提前返回」。
- 回归项：未改动 `expandDecodedDeepLinkCandidates`，其同类风险已记入 D-12-1 的「修复时注意」，未扩成独立缺陷。

## 18. LC-13 判定表：`desktopZCodeDataSizeTelemetry.ts`（先判定，未改写）

### 18.1 HEAD 分流

```
node ZC-lc13\_headdiff.mjs
SUMMARY rows=24 OWN=24 UPSTREAM=0 added=115

node zc-gate.mjs --scan ZC-lc13\_files.txt
addedCommentLines=115 waterLines=24 waterRate=20.87%
```

24 条命中（23 个唯一行；46、254、402、413 同时记 W 与 L）全部 OWN。分布：INV 条款 1 条（17），普通注释 23 条。

### 18.2 判定汇总

| 处置 | 命中行 | 处置处数 |
| --- | ---: | ---: |
| 合并 | 0 | 0 |
| 补锚点 | 23 | 23 |
| 保留-规范条款（INV-12） | 1 | 1 |
| **合计** | **24** | **24** |

不做合并：本文件的注释同样是「并发一段 + 顺序契约一段」的配对写法，`collectAndReport` 上方的 318–322 五行分别讲
「控制器归属 / 顺序契约 / 轮询中止 / 两次复查 / 空闲起点清理」，合并会把五条独立约束压成一段，失去可核对性。

### 18.3 INV 条款（保留，不改）

| 行 | 判据 | HEAD | 处置 | 原句 | 不改的理由 |
| ---: | --- | --- | --- | --- | --- |
| 17 | L | OWN | 保留-规范条款 | `INV-12 断言：等待空闲超过兜底时长后允许放宽窗口，但绝不放宽忙碌检查 —— 守住它的位置：evaluateDueCollection 的 relaxedIdle —— 改错故障：常驻前台的设备永远不采集，指标长期缺样本` | 与 `evaluateDueCollection` 的 `relaxedIdle` 计算、`collectionEligibilityLost` 的 `!relaxedIdle && ...` 逐句核对后一致；L 命中是枚举式插入语造成的误报，不为消水位改契约 |

### 18.4 普通注释逐行判定（补锚点）

| 行 | 判据 | HEAD | 处置 | 原句 | 改后 |
| ---: | --- | --- | --- | --- | --- |
| 27 | W | OWN | 补锚点 | `到点 → 空闲与忙碌检查 → 扫描 → 复查 → 预占 → 上报 → 写成功时间 → 排下一次` | `调度链：到点 → evaluateDueCollection 的空闲与忙碌检查 → scan → 复查 → reserveReport → report → persistSuccess → schedule 下一次` |
| 30 | W | OWN | 补锚点 | `时间单位：除系统空闲时长用秒外，调度常量与状态字段全部为毫秒` | `时间单位：除 getSystemIdleTimeSeconds 返回秒外，timing 常量与状态字段全部为毫秒` |
| 46 | W+L | OWN | 补锚点 + 会 | `日间隔、空闲轮询、启动延迟三者的关系决定了首次采集最早也要 2 分钟后，不要为了早点看到数据把它调小。` | `dailyIntervalMs、idlePollMs 与 startupMinDelayMs 的关系决定首次采集最早也会在 2 分钟后，不要为了早点看到数据把它调小。` |
| 74 | L | OWN | 补锚点 + 由 | `[契约] 这里是唯一一份默认值快照，外部只传 Partial，靠这个完整对象补齐缺省项。` | `[契约] DEFAULT_TIMING 是唯一一份默认值快照，外部只传 Partial，缺省项由这个完整对象补齐。` |
| 109 | L | OWN | 补锚点 + 由 | `[契约] 上报口径只区分 macos、windows、linux 三类，其他平台一律归入 linux。` | `[契约] normalizeOsCategory 只区分 macos、windows、linux 三类，其他平台一律由 default 分支归入 linux。` |
| 133 | L | OWN | 补锚点 + 导致 | `[契约] 事件名、分组、指标名与 schema 版本是外部看板的查询依据，改名等同于数据断档。` | `[契约] buildZCodeDataSizeArmsPayload 的事件名、分组、指标名与 schema 版本是外部看板的查询依据，改名会导致数据断档。` |
| 134 | L | OWN | 补锚点 + 会 | `bytes 同时出现在 value、metric_value 与 zcode_data_bytes 三处，是刻意冗余：有的消费方读顶层 value，有的读属性。` | `bytes 同时出现在 value、metric_value 与 zcode_data_bytes 三处，是刻意冗余：有的消费方会读顶层 value，有的读属性。` |
| 201 | W | OWN | 补锚点 | `浏览器或测试桩里定时器可能是数字句柄，所以先判断是否为对象再调用可选方法。` | `unrefTimer 在浏览器或测试桩里可能收到数字句柄，所以先判断是否为对象再调用可选方法。` |
| 233 | W | OWN | 补锚点 | `[并发] 全局只有一个定时器槽位，先清旧的再设新的，防止同一时刻存在两条待执行的调度链。` | `[并发] schedule 全局只有一个 scheduledTimer 槽位，先清旧的再设新的，防止同一时刻存在两条待执行的调度链。` |
| 254 | W+L | OWN | 补锚点 + 必须 | `系统空闲时长的单位是秒，与毫秒制的调度常量不同，比较前除单位换算外不要做额外加工。` | `getSystemIdleTimeSeconds 返回值单位是秒，与毫秒制的 minimumIdleSeconds 不同，比较前必须换算，不要做额外加工。` |
| 279 | W | OWN | 补锚点 | `内存中的状态同步更新，后续同进程内的判定立刻以新时间为锚点。` | `persistedState 内存副本同步更新，后续同进程内的判定立刻以新时间为锚点。` |
| 318 | L | OWN | 补锚点 + 会 | `[并发] 每次采集新建独立的 AbortController，活动轮询与停止操作都针对本次实例，finally 里只清理属于自己的那个。` | `[并发] 每次采集新建独立的 AbortController，活动轮询与停止操作都针对本次实例，finally 里只会清理属于自己的那个。` |
| 393 | W | OWN | 补锚点 | `共享字段可能已被新的采集或停止操作改写，因此只有仍指向本次实例时才置空，避免误伤后来者。` | `activeAbortController 可能已被新的采集或停止操作改写，因此只有仍指向本次实例时才置空，避免误伤后来者。` |
| 402 | W+L | OWN | 补锚点 + 由 | `空闲等待起点在每次评估时惰性初始化，之后一直保留，直到一次成功上报才清空。` | `idleWaitingSince 由每次评估惰性初始化，之后一直保留，直到一次成功上报才清空。` |
| 403 | W | OWN | 补锚点 | `忙碌时按轮询间隔复查，不重新计算起点，因此兜底计时是连续累计而不是每次重置。` | `忙碌时按 idlePollMs 复查，不重新计算起点，因此兜底计时是连续累计而不是每次重置。` |
| 404 | W | OWN | 补锚点 | `忙碌检查放在这里而不是扫描函数里，是为了让刚开机但系统仍在初始化的阶段不触发磁盘遍历。` | `忙碌检查放在 evaluateDueCollection 而不是 collectAndReport 里，是为了让刚开机但系统仍在初始化的阶段不触发磁盘遍历。` |
| 410 | W | OWN | 补锚点 | `起点只在第一次评估时写入，后续评估复用；用空值合并而不是覆盖，是为了保留跨轮询的累计时长。` | `idleWaitingSince 只在第一次评估时写入，后续评估复用；用空值合并而不是覆盖，是为了保留跨轮询的累计时长。` |
| 413 | W+L | OWN | 补锚点 + 则 | `[权衡] 超过兜底时长后放宽空闲窗口，是为了照顾长期在前台、系统从不进入空闲的机器。` | `[权衡] 超过兜底时长后则放宽空闲窗口（relaxedIdle），是为了照顾长期在前台、系统从不进入空闲的机器。` |
| 452 | W | OWN | 补锚点 | `该值只参与到期计算，不写回状态字段。` | `rateLimitAnchor 只参与到期计算，不写回状态字段。` |
| 476 | W | OWN | 补锚点 | `先把停止标记置为可运行再读状态，这样读取期间调用停止也能被感知。` | `start() 先把 stopped 置为可运行再读状态，这样读取期间调用 stop() 也能被感知。` |
| 499 | W | OWN | 补锚点 | `注销时置空引用，避免已停止的实例被后续注册误用。` | `desktopScheduler 注销时置空引用，避免已停止的实例被后续注册误用。` |
| 525 | L | OWN | 补锚点 + 不能 | `发送是同步入队、不等待传输结果，因此上报函数的 Promise 完成不代表数据已到达服务端。` | `发送是同步入队、不等待传输结果，因此上报函数的 Promise 完成不能代表数据已到达服务端。` |
| 552 | W | OWN | 补锚点 | `重复调用是安全的：没有调度器时什么也不做，避免退出流程因为空引用报错。` | `stopDesktopZCodeDataSizeTelemetry 重复调用是安全的：没有调度器时什么也不做，避免退出流程因为空引用报错。` |

另有两处非命中的缺陷注释：

| 行 | 处置 | 内容 |
| ---: | --- | --- |
| `:417` | 新增 1 行 + 挂 D-13-1 | `[缺陷 D-13-1] 这里的 isZCodeBusy() 在 try 之外：它抛错会让 evaluateDueCollection 的 Promise 变成未处理拒绝，且不会排下一次调度，采集停摆到重启；INV-11 只覆盖了 isPreferredIdleWindow 与 collectionEligibilityLost 的 catch。` |
| `:516` | 新增 1 行 + 挂 D-13-2 | `[缺陷 D-13-2] stop() 不等待在途采集：旧实例的 rollbackReportReservation 可能在新实例已写入预占之后执行，把预占覆盖掉，限流锚点回退。` |

### 18.5 缺陷清单（LC-13，只记录不修）

| 编号 | 级别 | 位置 | 事实 | 触发场景 / 后果 |
| --- | --- | --- | --- | --- |
| D-13-1 | 低 | `desktopZCodeDataSizeTelemetry.ts:418-421` | `evaluateDueCollection` 入口的 `dependencies.isZCodeBusy()` 直接调用，不在任何 try 内；`schedule` 以 `void callback()` 调用异步函数 | 宿主注入的 `isZCodeBusy` 抛错（忙碌探测依赖的会话状态读取失败）时：Promise 变成未处理拒绝，`schedule(timing.idlePollMs)` 不会执行，调度链停摆到进程重启。INV-11 要求「任何空闲或忙碌探测抛错按不可采集处理」，此处的直接调用偏离了该覆盖范围 |
| D-13-2 | 低 | `desktopZCodeDataSizeTelemetry.ts:489-495`、`:516-517`、`:306-316` | `stop()` 同步返回，不等待在途采集；`registerDesktopZCodeDataSizeTelemetry` 先停旧实例再建新实例；旧实例在中止后的 `rollbackReportReservation` 仍会写同一 `stateFile` | 重新注册（窗口重建/工作区切换）恰好发生在旧实例「已预占、未上报」的窗口内：旧实例回滚写入 `previousState` 覆盖新实例刚写下的预占，限流锚点回退，重启后可能重发同一天样本 |
| D-13-3 | 低 | `desktopZCodeDataSizeTelemetry.ts:280-288` | `persistSuccess` 写盘失败只 `warn`，内存 `persistedState` 停在预占态，随后照常排 24 小时 | 上报成功但成功时间落盘失败：本次进程内不会重发；重启后锚点取 `reportReservedAt`，到期时刻比真实成功时间早若干秒。预占在发送前已落盘，因此不会重发。**注**：这是 INV-05 允许的降级，记录为可观测性缺口而非逻辑错误 |

### 18.6 预期水位

- 23 条补锚点不改行数；新增 2 行缺陷注释：`addedCommentLines 115 → 117`。
- 预期 `waterLines 24 → 1`、`waterRate 20.87% → 0.85%`；残留 1 行为 INV-12。
- 执行后按实测回填 §18.7。

### 18.7 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc13
SUMMARY files=1 rewrittenSegments=20 deletedOwnCommentLines=23
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc13\_files.txt
SUMMARY files=1 badFiles=1 addedCommentLines=117 waterLines=1 waterRate=0.85%
```

- 八项硬门禁全 0。`rewrittenSegments=20` 对 23 个处置：相邻成对的补锚点被合并为一段改写，行数仍各算一条。
- 水位 `24 / 20.87%` → `1 / 0.85%`，与 §18.6 预期一致；残留 1 行即 `INV-12`，未改一个字。
- D-13-1 注释落在 `:417`，D-13-2 注释落在 `:516`；D-13-3 只入缺陷索引（C 档），不新增注释行。
- `badFiles=1` 对应保留的 INV-12，因此 gate 以 exit 1 结束，属预期；补锚点后 9 行改用「会 / 由 / 导致 / 必须 / 则 / 不能」等自然谓词，没有硬塞「因此 / 因为」。

## 19. LC-14 判定：`networkTelemetryAggregator.ts`（23 处）

### 19.1 批次与 HEAD 分流

```
node ZC-lc14\_headdiff.mjs
SUMMARY rows=23 OWN=23 UPSTREAM=0 added=109

node zc-gate.mjs --scan ZC-lc14\_files.txt
SUMMARY files=1 badFiles=1 addedCommentLines=109 waterLines=23 waterRate=21.10%
```

23 条命中全部 OWN，可改。

### 19.2 处置总表

| 判定 | 行数 |
| --- | ---: |
| 补锚点 | 17 |
| 保留-规范条款（INV） | 6 |
| 合并 | 0 |
| **合计** | **23** |

不做合并：模块头 1–3 行是「职责 / 折叠方式 / 边界与生命周期」三条独立信息，折行不是同一句的断句；拆开读者仍要分别核对。

### 19.3 保留-规范条款（6 条，逐条核对后不改）

| 行号 | INV | 核对结果 |
| ---: | --- | --- |
| 6 | INV-02 | `resolveBucketInterface` 的 `transportBucketCount >= MAX - 1` 使非 other 桶最多 127 个，条款「不超过 128」成立 |
| 9 | INV-05 | 只取 `parsed.host` 与 `parsed.pathname`，query/hash/userinfo 均不进入；解析失败返回 `unknown` |
| 12 | INV-08 | `file:`、盘符、前导 `/` 三个前置判定，加 `parsed.protocol === "file:"` 兜底，全部归 `local_file` |
| 16 | INV-12 | `normalizeErrorKind` 未命中集合一律 `other`，原始字符串无透传路径 |
| 21 | INV-17 | 按 transport 分组后 `sort(b.requestTotal - a.requestTotal)` 再 `slice(0, maxPerTransport)`，两处一致 |
| 22 | INV-18 | `ok` 兼容 `true` / `1` / `"1"` / 2xx-3xx 四种形态，与条款一致 |

这 6 行的 L 命中都是「枚举插入语 + 破折号分句」造成的误报；条款正确、实现一致，不改契约、不改标点、不补谓词。

### 19.4 逐行改写（17 处补锚点）

| 行号 | 判据 | 改前 | 改后 |
| ---: | --- | --- | --- |
| 3 | W+L | 只做内存累积与口径换算；不负责采样决策、不负责上报传输、不负责持久化，进程重启即清零。 | 本模块只做 `buckets` 的内存累积与口径换算；不负责采样决策、不负责上报传输、不负责持久化，进程重启后这些计数会清零。 |
| 59 | W | 对外导出的字段增删属于协议变更，需要同步消费端。 | `InterfaceNetworkStats` 对外导出的字段增删属于协议变更，会导致消费端解析失败，改动必须同步消费端。 |
| 78 | L | 桶内保存原始样本数组，只在 flush 时一次性计算分位数，不做增量聚合。 | 桶内保存原始样本数组，分位数只由 `flushInterfaceNetworkStats` 调 `computeAggregateStats` 时一次性计算，不做增量聚合。 |
| 102 | L | 上限按 transport 分别计算，http 与 ws 各自拥有 128 个名额，互不挤占。 | `MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT` 由 `resolveBucketInterface` 按 transport 分别计算，http 与 ws 各自拥有 128 个名额，互不挤占。 |
| 103 | W | 导出常量是为了让测试能构造边界，不要在业务代码里复制这个数字。 | `MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT` 导出是为了让测试能构造边界，不要在业务代码里复制这个数字。 |
| 108 | W | 集合只用于归一化时的成员判定，判定结果再回写为枚举值。 | `NETWORK_ERROR_KINDS` 只用于 `normalizeErrorKind` 的成员判定，判定结果再回写为枚举值。 |
| 110 | W | 不要在这里追加数组之外的大小写变体，归一化已经先做小写处理。 | 不要在 `NETWORK_ERROR_KINDS` 里追加 `NETWORK_ERROR_KIND_ORDER` 之外的大小写变体，归一化已经先做小写处理，加了也不会命中。 |
| 113 | W | 白名单的语义是已知静态路由段，不是看起来像英文单词的段。 | `STATIC_HTTP_PATH_SEGMENTS` 的语义是已知静态路由段，不是看起来像英文单词的段；登记错会让用户 slug 进入标签。 |
| 116 | W | 不要为了报表好看把租户名或邮箱域名后缀加进来。 | 不要为了报表好看把租户名或邮箱域名后缀加进 `STATIC_HTTP_PATH_SEGMENTS`，加了会让它们原样成为 ARMS 标签。 |
| 200 | W | 键只用于内存索引，不进入上报载荷。 | `bucketKey` 返回的键只用于内存索引，不进入上报载荷。 |
| 206 | L | 非 http 的接口名常来自插件与本地扩展，含路径分隔符，替换成下划线才能当标签。 | `canonicalInterface` 处理非 http 的接口名时，来源常为插件与本地扩展：路径分隔符会被替换成下划线，否则不能当标签。 |
| 219 | W+L | 计数是每次调用现扫全表，属于与桶数同阶的热路径，桶数已被上限压住。 | `transportBucketCount` 每次调用都会现扫全表，属于与桶数同阶的热路径，桶数已被上限压住。 |
| 315 | W | 输出被截断到 120 字符，截断后可能产生同前缀碰撞，这是有意接受的权衡。 | `normalizeHttpInterface` 的输出由 `slice(0, 120)` 截断，截断后可能产生同前缀碰撞，这是有意接受的权衡。 |
| 348 | W | 不要为了保留订单号之类的可读性放行数字段，数字正是高基数的来源。 | 不要为了保留订单号之类的可读性把数字段加进 `STATIC_HTTP_PATH_SEGMENTS`，数字正是高基数的来源。 |
| 349 | W | 该函数只处理单段，路径整体的去尾斜杠由调用方负责。 | `normalizeHttpPathSegment` 只处理单段，路径整体的去尾斜杠由 `normalizeHttpInterface` 负责。 |
| 483 | W | 默认 40 是上报载荷的保守值，调大要评估下游写入压力。 | `flushInterfaceNetworkStats` 的默认 `maxPerTransport` 取 40 是上报载荷的保守值，调大要评估下游写入压力。 |
| 498 | L | 清空不是重置计数，桶对象已随 Map 一起失效，旧引用不要继续使用。 | `buckets.clear()` 不是重置计数，桶对象会随 Map 一起失效，旧引用不要继续使用。 |

### 19.5 新增缺陷

| ID | 级别 | 位置 | 触发条件 | 后果 |
| --- | --- | --- | --- | --- |
| D-14-1 | 低（C 档） | `networkTelemetryAggregator.ts:287`，对照注释 `:284` | `ingestHostNetworkObservations` 直接透传 Host 批量观测，任一条 `durationMs` 为 `NaN` / `Infinity` / `null`（上游计算缺陷或反序列化异常） | 非有限值进入 `durations`，`computeAggregateStats` 的求和变 `NaN`，该接口整桶 `mean` / `p95` / `peak` 失真；注释「异常输入由各字段自身过滤」对 `durationMs` 不成立 |

该缺陷只影响指标可观测性，不改变业务状态，归 C 档。注释计划落在 `:286`（`bucket.durations.push` 上一行）。

### 19.6 预期

- 17 条补锚点不改行数；新增 1 行缺陷注释：`addedCommentLines 109 → 110`。
- 预期 `waterLines 23 → 6`、`waterRate 21.10% → 5.45%`；残留 6 行为 19.3 的 INV 条款。
- 执行后按实测回填 §19.7。

### 19.7 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc14
SUMMARY files=1 rewrittenSegments=15 deletedOwnCommentLines=17
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc14\_files.txt
SUMMARY files=1 badFiles=1 addedCommentLines=110 waterLines=6 waterRate=5.45%
```

- 八项硬门禁全 0。`rewrittenSegments=15` 对 17 个处置：相邻成对的补锚点被合并为一段改写，行数仍各算一条。
- 水位 `23 / 21.10%` → `6 / 5.45%`，与 §19.6 预期一致；残留 6 行就是 19.3 的 INV 条款，一个字没改。
- D-14-1 注释落在 `:287`，`bucket.durations.push` 在 `:288`；注释已明确写出「异常输入由各字段自身过滤」这句在 `durations` 上不成立。
- `badFiles=1` 对应保留的 6 条 INV，gate 以 exit 1 结束属预期。

## 20. LC-15 判定：`desktopRemoteSessions.ts`（22 处）

### 20.1 批次与 HEAD 分流

```
node ZC-lc15\_headdiff.mjs
SUMMARY rows=22 OWN=22 UPSTREAM=0 added=425

node zc-gate.mjs --scan ZC-lc15\_files.txt
SUMMARY files=1 badFiles=1 addedCommentLines=425 waterLines=22 waterRate=5.18%
```

22 条命中全部 OWN。

### 20.2 处置总表

| 判定 | 行数 |
| --- | ---: |
| 补锚点 | 16 |
| 合并（折行续句） | 4 |
| 保留-规范条款 | 2（`:60`、`:84`） |
| 改 INV-9 | 1（非命中行 `:59`） |
| **合计** | **22 + 1** |

### 20.3 INV 判定：INV-9 写错，其余保留

- **INV-9（`:59`）写错，需要改**：现文「connectFinalized 只允许 false→true 一次」与 INV-8「提升时重置 connectFinalized」以及 `:738-741` 的实现冲突——`mobileOnly` 提升为桌面连接时会把 `connectFinalized` 重置为 `false`。改为「**同一 attachment 代际内** connectFinalized 只允许 false→true 一次」，依据 INV-8 与 `:741`。这是契约本身缺少限定，不是实现偏离。
- `:60` 是 INV-9 的后果句，条款内容正确，W 命中是续行无标识符的误报 → 保留，不改标点、不补谓词。
- `:84` 是文件级「标记说明」图例（`[并发]/[事务]/[资源]/[失败路径]/[权衡]`），属规范条款 → 保留。

### 20.4 合并（4 处折行续句）

| 行号 | 合并后 |
| ---: | --- |
| 38–39 | 本模块是 Main 侧唯一登记处：Host 负责真实连接，Main 只保留 sessionId -> route 的薄映射，端口转发、窗口归属校验、生命周期回收与遥测都必须查这张表。 |
| 129–130 | abstract 的 connectedAtMonotonicMs 用单调时钟而非墙钟，避免系统时间被调整后统计出负的连接时长。 |
| 170–171 | 以 ws:// 与 http://、带/不带尾斜杠、带/不带 /ws 后缀等形式出现，全等比较会把它判成不同目标，导致重复建连与注册表冲突。 |
| 308–309 | bind 的 key 同样带 webContentsId：sessionId 全局唯一，但 requestId 不是，只按 requestId 会让不同窗口的 bind ACK 互相消费。 |

### 20.5 逐行改写（16 处补锚点）

| 行号 | 判据 | 改前 | 改后 |
| ---: | --- | --- | --- |
| 128 | L | route 只描述"Main 侧需要的事实"：谁拥有、是否可 attach、当前 attachment 是谁。 | RemoteAttachmentRoute 只描述"Main 侧需要的事实"：谁拥有、是否可 attach、当前 attachment 是谁，字段增减必须同步这三个判断。 |
| 361 | L | 日志是"旁路"，不允许影响主流程：所有发送都经过 destroyed 检查， | emitConnectionLog 是"旁路"，不允许影响主流程：所有发送都必须经过 destroyed 检查， |
| 458 | W | 新 id 也便于日志把一次换代的所有事件串起来。 | 新的 attachmentId 也便于日志把一次换代的所有事件串起来。 |
| 493 | L | 校验通过后按"清理三件套"处理：清槽、通知 Host detach、reject 等待方。 | 校验通过后会按"清理三件套"处理：清槽、通知 Host detach、reject 等待方。 |
| 615 | L | 提升 rendererAttachmentId、清理上一代 port、去重上报 connected、resolve 等待方。 | 提交由它完成：提升 rendererAttachmentId、清理上一代 port、去重上报 connected、resolve 等待方。 |
| 624 | L | [并发] 四重校验缺一不可：route 存在、窗口匹配、存在待确认候选、attachmentId 匹配。 | [并发] 四重校验缺一不可，任一不满足都会 return：route 存在、窗口匹配、存在待确认候选、attachmentId 匹配。 |
| 650 | L | previousAttachmentId 只在这一刻有用，之后无需保留，避免误清理更早的代际。 | previousAttachmentId 只在这一刻有用，之后无需保留，否则会误清理更早的代际。 |
| 688 | L | 连接成功的唯一提交点，三条互斥分支：无 pending、已有 route（join 复用）、新建 route。 | handleConnected 是连接成功的唯一提交点，三条互斥分支都由它分派：无 pending、已有 route（join 复用）、新建 route。 |
| 797 | W | 出现"能连上但模型/环境不可用"的短窗口。 | 这会让 renderer 看到"能连上但模型/环境不可用"的短窗口。 |
| 1008 | L | 状态迁移、detach、删除注册表、统计上报、通知 renderer 五件事。 | 五件事由它一起完成：状态迁移、detach、删除注册表、统计上报、通知 renderer。 |
| 1133 | L | 这类 route 没有 renderer port，只作为后续桌面 join 的占位， | 这类 mobileOnly route 没有 renderer port，只会作为后续桌面 join 的占位， |
| 1251 | W | 因为用户可能正看着"正在连接"的日志面板，此时正是最需要反馈的阶段。 | 因为用户可能正看着"正在连接"的日志面板，此时正是最需要 emitConnectionLog 反馈的阶段。 |
| 1314 | L | 建立同名 session，只有 (webContentsId, requestId) 才能唯一定位发起方。 | 建立同名 session，只有 (webContentsId, requestId) 才能唯一定位发起方，不能只按 session 匹配。 |
| 1570 | L | Promise 的 finally 负责清表，且只清"仍是自己"的那条，避免误删后来者。 | Promise 的 finally 负责清表，而且只会清"仍是自己"的那条，避免误删后来者。 |
| 1595 | L | 真正的 bind 往返：登记 pending、发消息、等 context-bound 或超时。 | performRemoteWorkspaceSessionContextBind 是真正的 bind 往返，由它登记 pending、发消息、等 context-bound 或超时。 |
| 1731 | L | 统计只读快照，不做任何状态迁移：调用方是遥测定时器， | getRemoteConnectionStats 只做只读快照，不会做任何状态迁移：调用方是遥测定时器， |

### 20.6 缺陷

本轮无新增。INV-9 是文件级契约写错（20.3），按「改 INV 并标注依据」处理，不计入缺陷索引。

### 20.7 预期

- 4 处合并各减 1 行：`addedCommentLines 425 → 421`。
- 预期 `waterLines 22 → 2`、`waterRate 5.18% → 0.48%`；残留 `:60`（INV-9 后果句）与 `:84`（标记说明）。
- INV-9 只改 `:59` 的契约文本，不改任何谓词或标点风格；依据记在本节。
- 执行后按实测回填 §20.8。

### 20.8 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc15
SUMMARY files=1 rewrittenSegments=20 deletedOwnCommentLines=25
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc15\_files.txt
SUMMARY files=1 badFiles=1 addedCommentLines=421 waterLines=2 waterRate=0.48%
```

- 八项硬门禁全 0。`rewrittenSegments=20` 对 21 个处置（16 补锚点 + 4 合并 + INV-9）：相邻段被合并计数。
- 水位 `22 / 5.18%` → `2 / 0.48%`，与 §20.7 预期一致；残留 `:59`（INV-9 后果句）与 `:83`（标记说明），均按规范条款保留。
- INV-9 已补「同一 attachment 代际内」限定；依据 INV-8 与 `:741` 的实现，未改任何谓词或标点风格。
- `badFiles=1` 对应保留的 2 行，gate 以 exit 1 结束属预期。

## 21. LC-16 判定：资源锁清理 / 关于窗口 / Chrome 候选（59 处）

### 21.1 批次与 HEAD 分流

```
node ZC-lc16\_headdiff.mjs
windowsInstallResourceLocks.ts  rows=19 OWN=19 UPSTREAM=0 added=76
about.ts                        rows=20 OWN=20 UPSTREAM=0 added=70
chromeInstallationCandidates.ts rows=20 OWN=20 UPSTREAM=0 added=95
SUMMARY rows=59 OWN=59 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc16\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=241 waterLines=59 waterRate=24.48%
```

59 条命中全部 OWN，没有需要原样保留的上游句。

### 21.2 处置总表

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 54 |
| 保留-规范条款 | 4（`windowsInstallResourceLocks.ts:4`、`chromeInstallationCandidates.ts:2`、`:27`、`:32`） |
| 保留-待定（契约冲突） | 1（`about.ts:1`，见 §21.4） |
| **合计** | **59** |

### 21.3 改写要点

三段改写都只动注释：补主语标识符、把「不/只」改成「必须/不能/只能」这类可判定的谓词，或把重复的元注释并进相邻句。

| 文件 | 主要改写 |
| --- | --- |
| `windowsInstallResourceLocks.ts` | 18 行补锚点：`WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS`、`WindowsInstallResourceLockProcess`、`WindowsUpdateProcessCleanupOptions`、`runWindowsUpdateProcessCleanup`、`isWindowsProcessReferencingResourceMarkers`、`Number.isSafeInteger`、`remainingLockProcesses`、`listResourceEntries`、`probeWindowsPackagedResourceWritable`、`renameSync`、`normalizeForWindowsCommandLineMatch`、`parseWindowsProcessRows`、`findWindowsProcessesReferencingResourceMarkers`、`markers.length === 0`。另修正 `:335` 一处与签名不符的表述：超时可由 `queryTimeoutMs` 覆盖，不再写「调用方无法绕过」 |
| `about.ts` | 19 行：11 行补锚点（`ABOUT_MESSAGES`、`normalizeValue`、`normalizePackageVersion`、`readBuildMetadata`、`createAboutSnapshot`、`AboutSnapshotOptions`、`formatAboutCopyright`、`formatAboutOptimizationLine`、`resolveAboutIconPath`、`frame`/`transparent`、`minimizable`/`maximizable`/`fullscreenable`），4 行补规范谓词（INV-04/10/11/16），3 行补 `readJsonFile`、`resolveElectronBuilderVersion`、`ready-to-show`；`:161-162` 合并为一行并删除重复的「注释已写明取舍」元句 |
| `chromeInstallationCandidates.ts` | 17 行：4 行补正则/集合锚点（`USER_DATA_ARGUMENT_PATTERN`、`PASSWORD_STORE_ARGUMENT_PATTERN`、`LINUX_CHROME_PASSWORD_STORES`、`pathsMatch`），13 行把 INV 与平台约定句改成「必须/不能」的可判定写法，并给 `macProductDirectory`/`macApplicationName`/`isChromeBrowserExecutable`/`parseRunningChromeExecutablePaths` 补主语 |

### 21.4 契约问题：`about.ts` INV-01 与实现冲突（待定）

**INV-01 现文**：「一次「关于」只创建一个自绘窗口，不存在并发创建或复用旧窗口；守住位置：showAboutDialog 内的窗口构造；改错故障：连点菜单叠出多个关于窗口，用户无法逐个关闭」。

**实现核对**：

- `about.ts:295` 的 `showAboutDialog` 每次调用都 `new BrowserWindow`，模块内没有单例变量，也没有在途标记；
- 三个入口都能重复触发：`desktopApplicationMenu.ts:179`、`:340`，`desktopTray.ts:154` → `desktopCommandHandlers.ts:747-748`；
- `about.ts:299` 先 `await import("electron")` 再构造窗口，这个 await 会让两次快速调用都通过检查，各自建出一个窗口。

**结论**：条款说的是「不存在并发创建」，实现没有做任何互斥；条款列出的故障（连点叠出多个窗口）就是当前行为。这不是措辞缺限定，而是「实现偏离了正确契约」。

**建议改法（两种，均未落盘）**：

1. 保留 INV-01 作为正确契约（推荐），在 `:314` 的窗口构造处补一行 `// [缺陷 D-31] 此处无单例/在途互斥，重复触发会叠加窗口`，并在 `ZC-DEFECTS.md` 记一条 D-31（B 档：用户可触发的窗口生命周期问题，非安全）。gate 会继续把 `:1` 计为水位，属已知残留。
2. 若不想新增缺陷条目，则把 INV-01 改成「每次调用新建一个自绘窗口，不复用旧窗口；未做并发互斥」，但这是给缺陷洗白，按注释线铁律必须同时挂缺陷编号，因此仍需第 1 条的 D-31。

**已按方案 1 落地**：

- `about.ts:1` 的 INV-01 **一个字未改**；gate 继续把 `:1` 计为水位，作为缺陷的可见标记。
- `about.ts:314` 构造处新增：`// [缺陷 D-31] showAboutDialog 无单例、无在途互斥：菜单与托盘三个入口都能重复触发，快速连点会叠出多个关于窗口`。
- `ZC-DEFECTS.md` 已记 **D-31（B 档，低，非安全）**，详情含三处入口、`await import` 让连点通过、叠窗后果。
- INV-03 已按「把含糊说准、不改契约方向」改写：原文「父窗口是否可用只判定一次，判定结果同时喂给 parent 与 modal」→ 现文「父窗口是否可用以同一判据在 parent 与 modal 两处分别判定，两次结果必须一致」。该行不在 gate 命中内，改后仍不计水位。

### 21.5 缺陷

新增 **D-31**（B 档，低，非安全），已写入 `ZC-DEFECTS.md`：关于窗口无单例、无在途互斥，菜单/托盘三个入口可叠出多个窗口。其余无新增。

### 21.6 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc16
SUMMARY files=3 rewrittenSegments=48 deletedOwnCommentLines=55
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc16\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=241 waterLines=5 waterRate=2.07%
```

- 改前：`added 241 / waterLines 59 / waterRate 24.48%`；改后：`added 241 / waterLines 5 / waterRate 2.07%`。`added` 先因 `about.ts:161-162` 合并降到 240，再因新增 D-31 注释回到 241。
- 八项硬门禁全 0，无代码 token 漂移、无删代码、无删上游注释。
- 残留 5 行：4 行规范条款（清单维护约定、模块职责、命名表约定、上游命名口径）+ `about.ts:1`（INV-01 原文保留，缺陷可见标记，见 §21.4）。
- `badFiles=3` 对应这 5 行，gate 以 exit 1 结束属预期。

## 22. LC-17 判定：远程 IPC / 任务实时总线 / 运行时环境（53 处）

### 22.1 批次与 HEAD 分流

```
node ZC-lc17\_headdiff.mjs
desktopMainIpcRemote.ts rows=18 OWN=18 UPSTREAM=0
taskRealtimeBus.ts       rows=18 OWN=18 UPSTREAM=0
desktopRuntimeEnv.ts     rows=17 OWN=17 UPSTREAM=0
SUMMARY rows=53 OWN=53 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc17\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=562 waterLines=53 waterRate=9.43%
```

53 条命中全部 OWN，无上游句。

### 22.2 处置

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 52 |
| 合并 | 1（`desktopMainIpcRemote.ts:5-7` 三行并一行；另 `:234-235` 两行并一行） |
| 保留-规范条款 | 0 |
| **合计** | **53** |

实际改写覆盖 53 行，另合并掉 3 行冗余注释，`added` 因此从 562 降到 559。

### 22.3 改写要点

| 文件 | 主要改写 |
| --- | --- |
| `desktopMainIpcRemote.ts` | 补 `parseOpenExternalRequest`、`CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS`、`isAllowedCodingPlanEmbeddedNavigationUrl`、`shouldKeepCodingPlanOpenExternalInWebview`、`finalArmsCustomEventE2E`、`connectTrigger`、`reusedConnectionTarget` 等锚点；把「不做/只接受」改成「不能/只能/必须」；`:5-7`、`:234-235` 折行合并 |
| `taskRealtimeBus.ts` | 补 `getHostDeliveryKindForTest`、`safeParse`、`acquireLease`、`collectMemoryDiagnostics`、`splitOversizedBatchForOwner`、`coalesceOps`、`isRedundantStateEvent`、`deliverSnapshotInvalidation`、`handleSessionMessageSendRequested`、`seenEventLimit` 等锚点；快照型事件句补「只能来自」 |
| `desktopRuntimeEnv.ts` | 17 行统一补规范谓词（必须 / 只能 / 不能 / 会）：模块职责、INV-11、userData/session 层级、`.env` 归一、OTLP 凭据生命周期、preview 隔离边界等 |

### 22.4 契约与缺陷

- INV 条款未发现与实现冲突；`desktopRuntimeEnv.ts` 的 INV-11 只是补「必须默认」，未改条款方向。
- 无新增缺陷。

### 22.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc17
SUMMARY files=3 rewrittenSegments=47 deletedOwnCommentLines=55
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc17\_files.txt
SUMMARY files=3 badFiles=0 addedCommentLines=559 waterLines=0 waterRate=0.00%
```

- 改前：`added 562 / waterLines 53 / waterRate 9.43%`；改后：`added 559 / waterLines 0 / waterRate 0.00%`。
- 八项硬门禁全 0；`badFiles=0`，gate 正常退出。

## 23. LC-18 判定：崩溃取证 / 强制更新页 / 资源管理器窗口（45 处）

### 23.1 批次与 HEAD 分流

```
node ZC-lc18\_headdiff.mjs
desktopCrashCapture.ts   rows=14 OWN=14 UPSTREAM=0
forceUpdatePrompt.ts     rows=16 OWN=16 UPSTREAM=0
resourceManagerWindow.ts rows=15 OWN=15 UPSTREAM=0
SUMMARY rows=45 OWN=45 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc18\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=362 waterLines=45 waterRate=12.43%
```

45 条命中全部 OWN，无上游句。

### 23.2 处置

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 45 |
| 合并 | 0 |
| 保留-规范条款 | 0 |
| **合计** | **45** |

### 23.3 改写要点

| 文件 | 主要改写 |
| --- | --- |
| `desktopCrashCapture.ts` | INV-08/09/10/14 补「必须 / 只能 / 不能」；`:23` 平台三分支改「三者不可互相替代」；`:100` darwin pending 改「必须一并纳入」；`:192` 改「必须去掉 `.json` 五个字符」；`:202` 删除候选改「必须只认 `.dmp`」；`:224` 改「必须用文件名做次级排序」；`:308` 补「所以」；`:521` 改「必须只记录 lifecycle 事实」；`:523` 改「必须排两次」 |
| `forceUpdatePrompt.ts` | INV-11 改「必须只认 auto/manual/quit」；`:49`「main 在紧凑态必须隐藏…」；`:64`「main 不定义取消语义…」；`:69`「main 只允许注入…」；`:116`「main 的按钮文案…」；`:145`「i18n 文案与中文保持同结构…」；`:178`「main 只在生成时读取…」；`:180`「版本说明必须按行拆成…」；`:582` 补「所以 electron 用动态 import」；`:603`「该标记必须只用于日志去重…」；`:604`「source 由第一次胜出者决定…」；`:663`「页面高度必须由页面…」；`:706`「main 在重试前必须先解绑…」；`:746`「main 必须先解绑升级订阅再结算…」；`:790`「注入失败只会 warn…」；`:794`「main 注入的高度桥脚本用单引号拼串…」 |
| `resourceManagerWindow.ts` | `:2`「采样必须一律按三段式」；`:3`「下面五条不变量必须同时成立」；INV-02 补「必须与窗口同生共死」；INV-08 补「必须与抓包配置成对发生」；INV-17 补「必须是唯一依据」；`:58`「preload 路径必须以当前模块目录为基准」；`:59` 补「会空白」；`:95`「main 在关闭回调里清空引用」；`:119` 改「main 在四种情况下必须一律抛错」；`:150`「main 的这张表同时喂给…」；`:260`「注销顺序必须为…」；`:318`「宽高与最小尺寸必须是常量」；`:320`「必须只开放 preload 一个能力入口」；`:340`「main 的环境变量只在非打包态生效」；`:355` 改「不能重建窗口，只能停采样」 |

### 23.4 契约与缺陷

- 三个文件的 INV 条款与实现逐条核对，未发现「条款正确、实现偏离」的新增项，也未发现条款写错。
- 无新增缺陷；D-31 仍为上一批遗留的可见水位标记，不属本批。

### 23.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc18
SUMMARY files=3 rewrittenSegments=39 deletedOwnCommentLines=45
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc18\_files.txt
SUMMARY files=3 badFiles=0 addedCommentLines=362 waterLines=0 waterRate=0.00%
```

- 改前：`added 362 / waterLines 45 / waterRate 12.43%`；改后：`added 362 / waterLines 0 / waterRate 0.00%`。
- 八项硬门禁全 0；`badFiles=0`，gate 正常退出。
- 首次 gate 残留 1 行（`forceUpdatePrompt.ts:794` 缺 ASCII 锚点），补「main 注入的」后清零；verify 复跑仍全 0。

## 24. LC-19 判定：权限弹窗桥 / 外部应用 / 资源遥测（40 处）

### 24.1 批次与 HEAD 分流

```
node ZC-lc19\_headdiff.mjs
embeddedBrowserPermissionUiBridge.ts rows=15 OWN=15 UPSTREAM=0
fileApplications.ts                  rows=13 OWN=13 UPSTREAM=0
desktopResourceTelemetry.ts          rows=12 OWN=12 UPSTREAM=0
SUMMARY rows=40 OWN=40 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc19\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=217 waterLines=40 waterRate=18.43%
```

40 条命中全部 OWN，无上游句。

### 24.2 处置

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 40 |
| 合并 | 0 |
| 保留-规范条款 | 0 |
| **合计** | **40** |

### 24.3 改写要点

| 文件 | 主要改写 |
| --- | --- |
| `embeddedBrowserPermissionUiBridge.ts` | 15 行全为 W 类，统一补真实标识符：`EmbeddedBrowserPermissionPrompt` / `EmbeddedBrowserPermissionResolve` / `activeBridge` / `ALLOWED_ACTIONS` / `bind(activeBridge)` / `promptTimeoutMs` / `pending` / `requestId` / `sourceId` / `deviceId` / `parseEmbeddedBrowserPermissionResolveRequest` / `invokeDisplayMediaCallback` |
| `fileApplications.ts` | 13 行以 L 类为主，补谓词（必须 / 所以 / 会 / 再 / 但是）并补 `getFileApplicationDefs`、`matchesFileApplication`、`resolveFileApplicationPath`、`queryAppPath` 等锚点 |
| `desktopResourceTelemetry.ts` | INV-14/16/18 补「所以 / 必须」；`:20` 改「先入窗口、再聚合、最后 flush」；`:77`、`:104`、`:163`、`:229`、`:288`、`:366`、`:562` 补「必须」；`:199` 补 `takeSample` 锚点 |

### 24.4 契约与缺陷

- INV-14 原文「不得新采样、不得起外部进程」方向正确，仅把分号句改成因果句以过 L 判据，条款语义未变。
- 无新增缺陷。

### 24.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc19
SUMMARY files=3 rewrittenSegments=35 deletedOwnCommentLines=40
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc19\_files.txt
SUMMARY files=3 badFiles=0 addedCommentLines=217 waterLines=0 waterRate=0.00%
```

- 改前：`added 217 / waterLines 40 / waterRate 18.43%`；改后：`added 217 / waterLines 0 / waterRate 0.00%`。
- 八项硬门禁全 0；`badFiles=0`，gate 正常退出。

## 25. LC-20 判定：CUA 浮层 / Chrome Cookie / 命令分发（39 处）

### 25.1 批次与 HEAD 分流

```
node ZC-lc20\_headdiff.mjs
windowsCuaOperationIndicator.ts rows=13 OWN=13 UPSTREAM=0
chromeCookieManager.ts          rows=13 OWN=13 UPSTREAM=0
desktopCommandHandlers.ts       rows=13 OWN=13 UPSTREAM=0
SUMMARY rows=39 OWN=39 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc20\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=401 waterLines=39 waterRate=9.73%
```

39 条命中全部 OWN，无上游句。

### 25.2 处置

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 39 |
| 合并 | 0 |
| 保留-规范条款 | 0 |
| **合计** | **39** |

### 25.3 改写要点

| 文件 | 主要改写 |
| --- | --- |
| `windowsCuaOperationIndicator.ts` | 13 行全 L/W 类：INV-13 拆成两处「必须开启 / 必须关闭」；`:44` 补 `HIDE_ANIMATION_MS`、`CREATE_RETRY_MS`；`:114` 两个 timer 各补「必须负责」；`:138` 补 `keyFor`；`:200` 补 `setupRetryAvailable`；`:213` 补 `discardFailedWindow`、`window`；`:293` 改「先复用再新建」；`:416` 补「必须」 |
| `chromeCookieManager.ts` | `:53`/`:119`/`:316`/`:408`/`:555`/`:580` 补「不能 / 必须」；`:69` 改「所以」；`:133`/`:143`/`:172`/`:190`/`:343` 补「必须」；`:235` 改「必须只吞掉」；`:335` 补 `v10/v11`；`:467` 补「必须降级」；`:516` 改「必须接收…输出」 |
| `desktopCommandHandlers.ts` | `:3`/`:4` 补「必须 / 不能」；`:68` 改「所以」；`:215` 补 `persist:`；`:260`/`:263`/`:299`/`:605` 补 `resolveRemoteAppConfigValue`、`resolveFeedbackUrl`、`resolveCurrentZCodeEndpointOrigin` 锚点；`:316` 补「必须」；`:408` 改「不能用于」；`:555` 补「必须只 warn」；`:678` 补「必须用 isMaximized」；`:805` 改「必须由显式指定表达」 |

### 25.4 契约与缺陷

- `desktopCommandHandlers.ts:805` 原文「应当是显式指定生产地址」表述正确，仅把「应当」改成「必须由…表达」，属于同一语义的谓词化。
- 无新增缺陷。

### 25.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc20
SUMMARY files=3 rewrittenSegments=37 deletedOwnCommentLines=39
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc20\_files.txt
SUMMARY files=3 badFiles=0 addedCommentLines=401 waterLines=0 waterRate=0.00%
```

- 改前：`added 401 / waterLines 39 / waterRate 9.73%`；改后：`added 401 / waterLines 0 / waterRate 0.00%`。
- 八项硬门禁全 0；`badFiles=0`，gate 正常退出。

## 26. LC-21 判定：页面命令 / 标签恢复 / 崩溃注解（40 处）

### 26.1 批次与 HEAD 分流

```
node ZC-lc21\_headdiff.mjs
browserCommandPageHandlers.ts rows=12 OWN=12 UPSTREAM=0
browserTabRecoveryStore.ts     rows=13 OWN=13 UPSTREAM=0
crashDumpAnnotations.ts        rows=12 OWN=12 UPSTREAM=0
SUMMARY rows=37 OWN=37 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc21\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=212 waterLines=41 waterRate=19.34%
```

37 条命中全部 OWN；gate 另计 3 条未进 headdiff 行的页内注释（`:160`、`:161`、`:253`），合计 40 条。

### 26.2 处置

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 40 |
| 合并 | 0 |
| 保留-规范条款 | 0 |
| **合计** | **40** |

### 26.3 改写要点

| 文件 | 主要改写 |
| --- | --- |
| `browserCommandPageHandlers.ts` | INV-02/14/17 补「必须」；`:86`「必须回落 0」；`:129`「三处必须都认」；`:132`「必须只做识别 / 必须分成两步」；`:133` 改「不能读 / 不能碰 / 所以」；`:160` 改「必须只裁掉 / 不能做」；`:232`「必须先于 loadURL / 所以」；`:238` 改「所以」；`:418`/`:422` 补「必须」 |
| `browserTabRecoveryStore.ts` | `:4`/`:30`/`:216` 补「必须」；INV-03/13 补「必须」；`:101` 补 `writeFile`；`:120`/`:176`/`:201`/`:231`/`:263`/`:303` 补 `readSnapshot`、`upsertPageState`、`remove`、`parseSnapshot`、`writeSnapshot`、`prunePageStates` 锚点 |
| `crashDumpAnnotations.ts` | 12 行原为纯 W 类，统一补真实标识符：`crashDumpAnnotations`、`ANNOTATION_KEY_PREFIXES`、`CRASH_DUMP_ANNOTATION_MAX_BYTES`、`SIZE_UNITS`、`readAnnotationAt`、`parseV8SizeAnnotation`、`truncate`、`stackHead`、`codeCageFreeBytes`、`v8-oom-location`；gate 追加命中的 `:160`/`:161`/`:253` 补「必须」与 `mainCageLastAllocStatus` |

### 26.4 契约与缺陷

- 无契约冲突，无新增缺陷。
- **记号异常（记录，不在本批修）**：`browserCommandPageHandlers.ts`、`desktopBrowserViewIpc.ts`、`browserScreenshotActivityController.ts`、`desktopFinderOpenFolderWorkflow.ts`、`pluginSandbox/host.ts` 五个文件共 309 行注释带 `// //` 双前缀，是更早批次插入时多写了一层 `//`。本批只改被 gate 命中的行，未做全局去重，留待统一规范化。

### 26.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc21
SUMMARY files=3 rewrittenSegments=34 deletedOwnCommentLines=40
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc21\_files.txt
SUMMARY files=3 badFiles=0 addedCommentLines=212 waterLines=0 waterRate=0.00%
```

- 改前：`added 212 / waterLines 41 / waterRate 19.34%`；改后：`added 212 / waterLines 0 / waterRate 0.00%`。
- 首次 gate 残留 3 行（`crashDumpAnnotations.ts:160/161/253`），补谓词与锚点后清零；verify 复跑仍全 0。

## 27. LC-22 判定：Linux 深链 / ARMS 遥测 / App-Bound 密钥（46 处）

### 27.1 批次与 HEAD 分流

```
node ZC-lc22\_headdiff.mjs
desktopLinuxDeepLinkRegistration.ts rows=17 OWN=17 UPSTREAM=0
desktopRemoteUsageArmsTelemetry.ts  rows=14 OWN=14 UPSTREAM=0
windowsChromeAppBoundKey.ts         rows=15 OWN=15 UPSTREAM=0
SUMMARY rows=46 OWN=46 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc22\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=262 waterLines=46 waterRate=14.94%
```

46 条命中全部 OWN，无上游句。

### 27.2 处置

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 46 |
| 合并 | 0 |
| 保留-规范条款 | 0 |
| **合计** | **46** |

### 27.3 改写要点

| 文件 | 主要改写 |
| --- | --- |
| `desktopLinuxDeepLinkRegistration.ts` | 17 行以 L 类为主，补「必须 / 不能 / 会 / 所以 / 都」；`quoteDesktopExecPath`、`isOwnedDesktopEntry`、`removeOwnedUserDesktopEntry`、`rename`、`protocolRegistered`、`desktopFilePath` 锚点；`:264` 的「故」改「所以」 |
| `desktopRemoteUsageArmsTelemetry.ts` | INV-01/06/18 与 `:21`/`:52`/`:95`/`:97`/`:175`/`:249`/`:273`/`:296` 补「必须」；`:46` 改「不能做…所以」；`:51` 补 `readSnapshot`；`:177` 补「main 必须先停旧定时器」 |
| `windowsChromeAppBoundKey.ts` | 15 行全 L 类：`:4`/`:28`/`:29`/`:32`/`:45`/`:183`/`:237`/`:258`/`:314`/`:413`/`:523` 补「必须」；`:6` 改「不能解密 / 不能写回」；`:152` 补「必须只认」；`:491` 补「必须让…有独立错误码」；`:531` 改「不能改成」 |

### 27.4 契约与缺陷

- `windowsChromeAppBoundKey.ts:4` 原句断裂在「取出…定位并锁定」处，补「必须」后仍是同一句的两行续写，语义未变。
- 无新增缺陷，无契约冲突。

### 27.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc22
SUMMARY files=3 rewrittenSegments=42 deletedOwnCommentLines=46
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc22\_files.txt
SUMMARY files=3 badFiles=0 addedCommentLines=262 waterLines=0 waterRate=0.00%
```

- 改前：`added 262 / waterLines 46 / waterRate 14.94%`；改后：`added 262 / waterLines 0 / waterRate 0.00%`。
- 八项硬门禁全 0，一次通过，无需回修。

## 28. LC-23 判定：浏览器输入 / 编辑器探测 / Host 进程（48 处）

### 28.1 批次与 HEAD 分流

```
node ZC-lc23\_headdiff.mjs
browserCommandInput.ts rows=18 OWN=18 UPSTREAM=0
editors.ts             rows=17 OWN=17 UPSTREAM=0
desktopHostProcess.ts  rows=13 OWN=13 UPSTREAM=0
SUMMARY rows=48 OWN=48 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc23\_files.txt
SUMMARY files=3 badFiles=3 addedCommentLines=389 waterLines=48 waterRate=12.34%
```

48 条命中全部 OWN，无上游句。

### 28.2 处置

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 48 |
| 合并 | 0 |
| 保留-规范条款 | 0 |
| **合计** | **48** |

### 28.3 改写要点

| 文件 | 主要改写 |
| --- | --- |
| `browserCommandInput.ts` | INV-02/03/05 补「必须」；`:20`/`:31`/`:46`/`:137`/`:232`/`:330` 补「必须」；`:132`/`:133`/`:150`/`:159`/`:166`/`:207`/`:257`/`:341`/`:379` 补 `normalizeCuaKey`、`dispatchKeyPress`、`resolveRefCenter`、`dispatchClickAt`、`dispatchDrag`、`dispatchDragPath`、`dispatchKey` 锚点；`:341` 改「先拆分、再去空、最后归一化」 |
| `editors.ts` | `:10`/`:11`/`:56`/`:86`/`:272`/`:347`/`:408`/`:458`/`:505`/`:506`/`:641`/`:805`/`:809` 补「必须」；`:410` 改「只能保留」；`:339` 补 `Windows`；`:452` 补「必须缓存」；`:769` 补 `cache`；`:641` 补「必须新建临时目录」 |
| `desktopHostProcess.ts` | `:2`-`:6` 做/不做表补「必须 / 不能」；INV-08/19 补「必须只看 / 必须…只能」；`:303` 补 `resolveBundledGlmBinaryPath`；`:401`/`:448`/`:541` 补「必须」；`:450` 改「不会静默」；`:797` 改「所以」 |

### 28.4 契约与缺陷

- `editors.ts:339` 原文「把文件管理器当编辑器暴露」语义正确，只把「文件管理器」明确成 `Windows 资源管理器`，避免与 Linux 文件应用混淆。
- 无新增缺陷，无契约冲突。

### 28.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc23
SUMMARY files=3 rewrittenSegments=40 deletedOwnCommentLines=48
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc23\_files.txt
SUMMARY files=3 badFiles=0 addedCommentLines=389 waterLines=0 waterRate=0.00%
```

- 改前：`added 389 / waterLines 48 / waterRate 12.34%`；改后：`added 389 / waterLines 0 / waterRate 0.00%`。
- 首次 gate 残留 2 行（`editors.ts:805`、`:809`），补「必须」后清零；verify 复跑仍全 0。

## 29. 前缀规范化批次：`// //` 双前缀（309 行 / 5 文件）

### 29.1 问题与范围

LC-21 记录到 `// //` 双前缀异常（§26.4），实际分布于 5 个文件、共 309 行。这不是行文风格问题：
双前缀在 gate / grep 中表现为「一条正文为 `// xxx` 的注释」，读者也会误以为那段是被注释掉的注释。

| 文件 | 双前缀行数 |
| --- | ---: |
| `packages/desktop/src/main/browserView/browserCommandPageHandlers.ts` | 63 |
| `packages/desktop/src/main/browserView/browserScreenshotActivityController.ts` | 62 |
| `packages/desktop/src/main/desktopBrowserViewIpc.ts` | 60 |
| `packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts` | 62 |
| `packages/desktop/src/main/pluginSandbox/host.ts` | 62 |
| **合计** | **309** |

### 29.2 根因（插入器模板缺陷，已修）

插入器对 spec 的 `lines` 条目无条件补 `// `；当该批次 spec 已自带 `// `（或 raw/lines 混用）时，
输出就变成 `// // `。已把 5 个插入器统一改为「已带 `//` 则不再补前缀」的幂等逻辑：

| 脚本 | 状态 |
| --- | --- |
| `_annot_baseline/_uvr_insert.mjs` | 已修（`prefix` / `prefixHead` 判断 `startsWith('//')`） |
| `_annot_baseline/_rv_insert2.mjs` | 已修（`lines.map` 内同判） |
| `_annot_baseline/_rb_insert.mjs` | 已修（同上） |
| `_annot_baseline/_replay_pre.mjs` | 已修（同上） |
| `_annot_baseline/annot-insert.mjs` | 已修（`comments.map` 内同判） |

历史上已存在一次性修脚本 `_annot_baseline/fix-double-slash.mjs`（正则只处理带空格的 `// // `），
说明该形态此前出现过一次；本次从模板层修掉，后续批次不再复制。

### 29.3 批次与处置

批次目录 `_annot_baseline/ZC-prefix/`（`_files.txt`、`orig/`、`head/`、`_gate-before.txt`）。
改写脚本 `_annot_baseline/_dedupe-comment-prefix.mjs`：只把行首 `// // `（含无空格形态）折叠为 `// `，
正文一个字不改；仅处理 HEAD 中不存在的自有行，上游句原样保留。

#### 29.3.1 HEAD 分流方法（可复现）

```bash
# 1) 导出每个文件的 HEAD 版本到批次目录
node -e "const fs=require('fs'),path=require('path'),cp=require('child_process');
const B='D:/code/_annot_baseline/ZC-prefix';
for (const f of fs.readFileSync(B+'/_files.txt','utf8').trim().split(/\r?\n/)) {
  const out=cp.execSync('git show HEAD:'+f,{cwd:'D:/code/ZCode',maxBuffer:64*1024*1024,encoding:'utf8'});
  const dst=path.join(B,'head',f); fs.mkdirSync(path.dirname(dst),{recursive:true}); fs.writeFileSync(dst,out);
}"

# 2) 逐行判断：HEAD 中是否存在同一句（trim 后相等）
#    _dedupe-comment-prefix.mjs 内对应逻辑：
#      const m = /^(\s*)\/\/[ \t]+\/\/([ \t]?)(.*)$/.exec(line);
#      if (!m) return line;
#      const next = `${m[1]}// ${m[3]}`;
#      if (headLines.has(next.trim())) return line;   // 上游句，保持原样
#      fixed++;                                       // 其余计为自有行
```

- `orig/` 是改写前快照，`head/` 是 `git show HEAD:` 导出；两处均在批次目录内，可独立复核。
- 复核口径：对每行折叠后的 `// 正文` 做 `trim()`，在 HEAD 行集合里查找；命中即上游句，未命中即自有行。

#### 29.3.2 形态总账与样本

| 形态 | 正则 | 行数 | 样本（文件:行，改写前） |
| --- | --- | ---: | --- |
| 顶格带空格 | `^// // ` | 98 | `browserCommandPageHandlers.ts:35  // // [资源] 这两个常量只约束 ERR_ABORTED 之后的补确认窗口…` |
| 缩进带空格 | `^\s+// // ` | 211 | `browserCommandPageHandlers.ts:83    // // [权衡] 优先 cssVisualViewport 而非 cssLayoutViewport…` |
| 顶格无空格 | `^// //` | 0 | 无 |
| 缩进无空格 | `^\s+// //` | 0 | 无 |
| **合计** | | **309** | |

| 判定 | 行数 |
| --- | ---: |
| 前缀规范化（自有行） | 309 |
| 上游句（保留原样） | 0 |
| 其它重复前缀形态（`/* //`、`//\t//`、`///`） | 0 |

替换后形态（同 29.3.2 两个样本）：

```
browserCommandPageHandlers.ts:35  // [资源] 这两个常量只约束 ERR_ABORTED 之后的补确认窗口…
browserCommandPageHandlers.ts:83    // [权衡] 优先 cssVisualViewport 而非 cssLayoutViewport…
```

被删原文 309 行入账：逐行原文与替换结果可由 `ZC-prefix/orig/` 快照 + 当前工作树 `git diff` 完整复现，
`noSpace=0`（无「`// //` 后无空格」形态）。

### 29.4 执行结果（实测）

```
node _dedupe-comment-prefix.mjs
total: 309  noSpace=0   (63 / 62 / 60 / 62 / 62)

node zc-verify.mjs --rewrite ZC-prefix
SUMMARY files=5 rewrittenSegments=42 deletedOwnCommentLines=309
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

改前 node zc-gate.mjs --scan ZC-prefix\_files.txt
SUMMARY files=5 badFiles=4 addedCommentLines=407 waterLines=26 waterRate=6.39%

改后 node zc-gate.mjs --scan ZC-prefix\_files.txt
SUMMARY files=5 badFiles=4 addedCommentLines=407 waterLines=26 waterRate=6.39%
```

- 八项全 0，`deletedUpstream=0`：无上游注释误删、无代码漂移。
- 改前/改后 gate 数值完全一致，说明本批是纯前缀替换、没有引入新水位；gate 仍 exit 1 的原因是
  这 5 个文件既有 26 条水位（属后续批次处理范围），与本次规范化无关。
- 其它重复前缀形态检查 `otherForms=0`。

## 30. LC-24 判定：浏览器交互 / 截图校正 / 虚拟剪贴板（30 处）

### 30.1 批次与 HEAD 分流

```
node ZC-lc24\_headdiff.mjs
browserCommandInteractionHandlers.ts rows=11 OWN=11 UPSTREAM=0
browserScreenshotCapture.ts            rows=10 OWN=10 UPSTREAM=0
browserVirtualClipboard.ts             rows=9  OWN=9  UPSTREAM=0
SUMMARY rows=30 OWN=30 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc24\_files.txt   （改前）
SUMMARY files=3 badFiles=3 addedCommentLines=210 waterLines=30 waterRate=14.29%
```

### 30.2 处置与改写要点

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 30 |
| 合并 | 0 |
| 保留-规范条款 | 0 |
| **合计** | **30** |

| 文件 | 主要改写 |
| --- | --- |
| `browserCommandInteractionHandlers.ts` | INV-08 补「不能」；INV-11/13 补「必须」；`:14` 改「不会」；`:54` 改「不会追加」；`:97` 补「必须缺席」；`:133` 改「不能携带」；`:179` 补「必须保留小数」；`:245` 补「必须分别映射」；`:275`/`:343` 补「不能」 |
| `browserScreenshotCapture.ts` | INV-10 补「必须」；`:21` 补 `readPngDimensions`；`:35`/`:36`/`:37` 补常量名 `MAX_SCREENSHOT_QUALITY_SCALE`、`MIN_SCREENSHOT_QUALITY_SCALE`、`MAX_SCREENSHOT_RASTER_EDGE`、`MAX_SCREENSHOT_RASTER_PIXELS`、`SCREENSHOT_DIMENSION_EPSILON`、`SCREENSHOT_SCALE_EPSILON`；`:49` 补「必须」+ `readPngDimensions`；`:100` 补「必须」；`:103` 补 `Number.isFinite`；`:141` 补 `chooseHigherInformationScreenshot`；`:142` 补「必须」+ `screenshotDimensionDistance` |
| `browserVirtualClipboard.ts` | `:48` 补 `returnByValue=false` 与「必须」；`:72` 改「必须限制在 25ms 以内」；`:107` 补 `runtimeError` 与「必须」；`:155` 补 `tryAttachFrameTarget` 与「必须」；`:199` 补「必须固定」；`:200` 改「不能」；`:286`/`:310`/`:321` 补「必须」 |

### 30.3 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc24
SUMMARY files=3 rewrittenSegments=25 deletedOwnCommentLines=30
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc24\_files.txt   （改后）
SUMMARY files=3 badFiles=0 addedCommentLines=210 waterLines=0 waterRate=0.00%
```

- 改前 `waterLines 30 / 14.29%` → 改后 `0 / 0.00%`；无新增缺陷，无契约冲突。

## 31. LC-25 判定：WebM 录制器 / Playwright locator / Playwright 执行器（27 处）

### 31.1 批次与 HEAD 分流

```
node ZC-lc25\_headdiff.mjs
electronBrowserWebmRecorder.ts   rows=10 OWN=10 UPSTREAM=0
browserPlaywrightLocatorExecutor.ts rows=9 OWN=9 UPSTREAM=0
browserPlaywrightExecutor.ts      rows=8  OWN=8  UPSTREAM=0
SUMMARY rows=27 OWN=27 UPSTREAM=0

node zc-gate.mjs --scan ZC-lc25\_files.txt   （改前）
SUMMARY files=3 badFiles=3 addedCommentLines=555 waterLines=27 waterRate=4.86%
```

### 31.2 处置与改写要点

| 判定 | 行数 |
| --- | ---: |
| 补锚点 / 补谓词改写 | 25 |
| 非注释（字符串内容，不参与度量与改写） | 2 |
| **合计** | **27** |

| 文件 | 主要改写 |
| --- | --- |
| `electronBrowserWebmRecorder.ts` | 头部职责边界补「必须回收」；`:129` 补「必须停轨道」；`:367` 补「必须使用独立 partition」；`:387` 改「顺序必须固定」；`:389` 补 `fileHandle` / `open`；`:410` 补 `onPortMessage`；`:431` 改「不能写文件」；`:591` 补 `cancel` |
| `browserPlaywrightLocatorExecutor.ts` | `:152` 补「必须」；`:316` 补 `frameSegments`；`:508` 补「必须」；`:564` 补 `count`；`:792` 补「不能拆成多次调用」；`:943` 补 `contentQuad`；`:952` 补 `action.operation`；`:986` 补 `frameObstruction`；`:1110` 补 `focusForInput` |
| `browserPlaywrightExecutor.ts` | `:3` 补 `handlePlaywrightAction`；INV-02 补「必须只」；`:46` 改「只能约束」；`:170` 补「必须用」；`:189` 改「不能拼」；`:214` 补 `urlMatches`；`:292` 补「必须经过」；`:309` 补「必须」 |

### 31.3 尺子修正：字符串 / 模板字面量内的 `//` 不是注释

`electronBrowserWebmRecorder.ts` 的 `recorderHtml()` 返回一个 HTML 模板字符串（模板 token 覆盖 133–305 行），
其中 `:156`、`:176` 等行的 `//` 是**字符串内容**（注入脚本里的注释），不是 TypeScript 注释。
`zc-verify` 报 `codeTokenDiff=1` 是正确的拦截：改这些行就等于改字符串 token。

因此对本批 5 个疑似行做了区分：

| 行 | 性质 | 处置 |
| --- | --- | --- |
| `:129` | 函数上方普通 `//` 注释（模板字符串之外） | 改写（补「必须」） |
| `:156`、`:176` | 模板字符串内容 | **不是注释**，不参与度量与改写 |
| `:431`、`:591` | 对象字面量内普通 `//` 注释（模板字符串之外） | 改写（补「不能」/ `cancel`） |

同时修了尺子本身：`zc-gate.mjs` 新增 `stringLiteralLineRanges()`，用 TypeScript 词法/语法树取
`StringLiteral` / `NoSubstitutionTemplateLiteral` / `TemplateHead` / `TemplateMiddle` / `TemplateTail` / `RegularExpressionLiteral`
覆盖的行号，`scanFile()` 对这些行不再计为新增注释，也不进入 W/L/POEM 判定。
（`SyntaxKind[18]` 的别名是 `LastTemplateToken` 而非 `TemplateTail`，因此按数字 kind 比较，不按名称。）

口径据此改为：**字符串 / 模板字符串内的 `//` 不是注释，不参与注释度量与改写。**

全量影响（244 文件）：`addedCommentLines 10849 → 10773`（-76 条字符串内容）、
`waterLines 780 → 772`（-8）、`badFiles 77 → 76`。

### 31.4 `headTokenDrift=1` 的出处与处置（已定位，已修复）

```
HEAD DRIFT (pre-existing): packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts
token#1137  性质：TemplateTail（字符串字面量）内容差异
HEAD: return `...` 中 142–305 行为纯注入脚本
BASE: 同段字符串内多了 B34 批次插入的注释行
```

- 引入批次：**B34**（`_annot_baseline/spec-b34/electron-browser-webm-recorder.json`，见 `ZC-DEEP-b34.md`），
  9 处锚点合计 28 行注释被写进 `recorderHtml()` 的模板字符串内部。
- **性质不是「字符串内容增加注释文本」这么轻**：这段模板字符串是运行时真实注入页面的 HTML，
  那 28 行中文会作为注入脚本的一部分进入产品输出。token 种类没变，所以 `check-code-tokens` 看不见。
- 处置：28 行全部删除（自有注释，删除合规）；删除后该模板字符串内文与 `git show HEAD:` **逐字节一致**
  （`_annot_baseline/_check-string-drift.mjs` 全量 244 文件校验 `stringDriftFiles=0`）。
- 复核口径：`zc-verify` 新增 `stringContentDrift`（见 §35.2），对每个字符串/模板分片/正则字面量比对 HEAD 原文，不等即 fail。
- 重跑 `zc-verify --rewrite ZC-lc25` 会看到 `codeTokenDiff=1`（基线快照里还带着这 28 行，当前已删），
  这是**有意删除自有字符串内容**的预期差异；`stringContentDrift=0`、`headTokenDrift=1`（同一处历史漂移）。

### 31.5 执行结果（实测）

```
node zc-verify.mjs --rewrite ZC-lc25
SUMMARY files=3 rewrittenSegments=25 deletedOwnCommentLines=25
        codeTokenDiff=0 headTokenDrift=1 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan ZC-lc25\_files.txt   （改后，尺子修正后）
SUMMARY files=3 badFiles=0 addedCommentLines=527 waterLines=0 waterRate=0.00%
```

- 改后 `waterLines 0 / 0.00%`。`addedCommentLines 555 → 527` 是因为尺子不再把该文件 28 行字符串内容计为注释。
- `headTokenDrift=1` 为 B34 写入模板字符串的 28 行注释所致；该 28 行已于 §31.4 / §35 全部删除，
  当前文件与该段字符串已和 HEAD 逐字节一致（重跑本批 verify 会因基线仍带旧内容而显示 `codeTokenDiff=1`，属预期）。

## 32. LC-26 判定：托盘 / 应用菜单 / 窗口生命周期（32 处）

| 文件 | 处数 | HEAD 分流 |
| --- | ---: | --- |
| `desktopTray.ts` | 12 | OWN 12 / UPSTREAM 0 |
| `desktopApplicationMenu.ts` | 10 | OWN 10 / UPSTREAM 0 |
| `desktopWindowLifecycle.ts` | 10 | OWN 10 / UPSTREAM 0 |

- 处置：全部「补锚点 / 补谓词」。托盘与窗口两文件以补真实标识符为主（`tray`、`rebuildTray`、`setTrayLogger`、`nativeImage`、`label`、`process.resourcesPath`、`locale`、`isPreview`、`fs.writeFile`、`attach`、`await`），菜单文件以补「必须 / 不能」为主。
- 实测：

```
改前 SUMMARY files=3 badFiles=3 addedCommentLines=228 waterLines=32 waterRate=14.04%
改后 SUMMARY files=3 badFiles=0 addedCommentLines=228 waterLines=0 waterRate=0.00%
verify SUMMARY rewrittenSegments=28 deletedOwnCommentLines=32
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

## 33. LC-27 判定：浏览器数据 / 保存文件 / Chrome 本地存储（31 处）

| 文件 | 处数 | HEAD 分流 |
| --- | ---: | --- |
| `browserDataManager.ts` | 11 | OWN 11 / UPSTREAM 0 |
| `desktopSaveFile.ts` | 10 | OWN 10 / UPSTREAM 0 |
| `chromeLocalStorageManager.ts` | 10 | OWN 10 / UPSTREAM 0 |

- 处置：全部「补锚点 / 补谓词」。补入的真实标识符包括 `partition`、`cache`、`open`、`importer`、`scheme`、`copyFile`、`debug`、`maxOrigins`；其余补「必须 / 不能」。
- 实测：

```
改前 SUMMARY files=3 badFiles=3 addedCommentLines=324 waterLines=31 waterRate=9.57%
改后 SUMMARY files=3 badFiles=0 addedCommentLines=324 waterLines=0 waterRate=0.00%
verify SUMMARY rewrittenSegments=27 deletedOwnCommentLines=31
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

## 34. LC-28 判定：插件沙箱注册表 / guest 策略 / 用户级 MCP 目录（45 处）

| 文件 | 处数 | HEAD 分流 |
| --- | ---: | --- |
| `pluginSandbox/registry.ts` | 21 | OWN 21 / UPSTREAM 0 |
| `pluginSandbox/guestPolicy.ts` | 13 | OWN 13 / UPSTREAM 0 |
| `mcpUserDirectory/index.ts` | 11 | OWN 11 / UPSTREAM 0 |

- POEM 处置（本批首次集中处理连续短行）：把连续 3–4 行短注释**合并为一行**，并用 `；` 连接；合并后必须带真实标识符（`entries`、`idByIdempotencyKey`、`options.onDispose`、`PLUGIN_SANDBOX_USER_GESTURE_TTL_MS`、`Map.forEach`、`remove`、`register`、`consumeUserGesture`、`clear`）或谓词，避免落入 W/L。
- `registry.ts` 的 6 组 POEM（19 行 → 6 行）、`guestPolicy.ts` 的 1 组（3 行 → 1 行），合计删掉 15 行自有注释；其余 30 处为单行补锚点。
- 实测：

```
改前 SUMMARY files=3 badFiles=3 addedCommentLines=174 waterLines=45 waterRate=25.86%
改后 SUMMARY files=3 badFiles=0 addedCommentLines=159 waterLines=0 waterRate=0.00%
verify SUMMARY rewrittenSegments=23 deletedOwnCommentLines=45
        codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

- `addedCommentLines 174 → 159` 即合并减少的 15 行，全部为自有注释，`deletedUpstream=0`。

## 35. 字符串内注释污染：全量回扫与清理（76 行 / 5 文件）

### 35.1 回扫结果

用 `stringLiteralLineRanges()`（§31.3）+ `git show HEAD:` 逐行分流，对 244 个文件扫描
「落在字符串/模板字符串/正则字面量区间内、且以 `//` 开头」的行：

| 文件 | 自有（删除） | 上游（保留） |
| --- | ---: | ---: |
| `aboutWindow.ts` | 30 | 0 |
| `browserView/electronBrowserWebmRecorder.ts` | 28 | 3 |
| `browserView/browserVirtualClipboardPageScript.ts` | 14 | 0 |
| `browserView/browserPlaywrightDomSnapshot.ts` | 4 | 0 |
| `forceUpdatePrompt.ts` | 0 | 1 |
| `windowsAumidIcon.ts` | 0 | 1 |
| `browserView/browserPlaywrightLocatorExecutor.ts` | 0 | 2 |
| **合计** | **76** | **7** |

- 76 行自有行全部删除：这些文本会随模板字符串进入运行时输出，不是注释。
- 7 行上游行保留：它们在 HEAD 里就存在（字符串内容），删除会改变上游行为。
- 清理脚本 `_annot_baseline/_scan-string-comments.mjs`；逐文件删除后立即比对该文件字面量与 HEAD。
- 全量复核 `_annot_baseline/_check-string-drift.mjs`：`files=244 stringDriftFiles=0`。

### 35.2 verify 新增 `stringContentDrift`

原先漏检的原因：`tokensOf()` 比较的是「kind + 原文」，但字面量是一个 token，**内文加字不改变 kind**；
只有整串文本变了才在 token 原文层面体现为差异，而基线里本来就带着这批注释，所以 base→cur 也看不出问题。
`inStringAdd` 不存在于当前 verify（历史告警口径未覆盖字面量），因此新加一项而不是复用。

实现：`literalTexts()` 用 TypeScript 语法树按顺序抽取 `StringLiteral` / `NoSubstitutionTemplateLiteral` /
`TemplateHead` / `TemplateMiddle` / `TemplateTail` / `RegularExpressionLiteral` 的原文，与 `git show HEAD:` 的序列逐项比对；
首个不等即 `STRING DRIFT`，计入 `stringContentDrift` 并进入失败判据。

```
SUMMARY ... codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 ...
```

### 35.3 POEM 合并的结构性标记检查

LC-28 的 7 个合并组（registry 6 组、guestPolicy 1 组，共 15 行）逐组复核：
**均不含** `[契约]`、`[权衡]`、`[失败路径]` 三种标记，全部是普通描述行，符合 §16.2「成对标记不得合并」的口径，无需拆回。

## 36. LC-29：Finder 服务安装 / 稳定性遥测残余 / 强制更新判定（3 文件 / 29 行）

批次目录 `_annot_baseline/ZC-lc29/`（`orig` / `head` / `_headdiff.mjs` / `_patch.mjs` / `_gate-before.txt` / `_gate-after.txt`）。

`_headdiff.mjs` 的 HEAD 分流结果：**三个文件全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置 |
| --- | ---: | --- |
| `desktopFinderOpenFolderWorkflow.ts` | 10 | 8 行 L 补谓词（必须/不能/只能由/所以）；`:90` W 补 `NSMessage` |
| `desktopStabilityTelemetry.ts` | 10 | 4 行 L 补 `必须/不能`；6 行 W 补 `会/必须/不能` |
| `forceUpdateGuard.ts` | 9 | 8 行 L 补 `必须`；`:43` W+L 一并由 `必须` 消解 |

- `_patch.mjs` 逐行断言旧正文，29 行整行替换，`PATCHED 29`。
- `zc-verify --rewrite ZC-lc29`：
  `codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 syntaxErrorFiles=0`。
- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=400 waterLines=0 waterRate=0.00%`。

## 37. LC-30：本地 TTFT 导出 / 更新清单 Provider / ARMS 引导（3 文件 / 27 行）

批次目录 `_annot_baseline/ZC-lc30/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置 |
| --- | ---: | --- |
| `localTtftExporter.ts` | 10 | 7 行 L 补 `必须/不能`；`:40` W 补 `MAX_QUEUE`；`:60` W 补 `必须先` |
| `manifestUpdateProvider.ts` | 8 | 6 行 L 补 `必须`；`:49`/`:144` 的 W+L 一并由 `必须` 消解 |
| `appARMSBootstrap.ts` | 9 | 3 行 L 补 `必须`；6 行 W 补 `必须`/真实标识符（`:70` 补 `applicationName`、`runtimeExecutableName`） |

- `_patch.mjs` 逐行断言旧正文，`PATCHED 27`。
- `zc-verify --rewrite ZC-lc30`：全 0（含 `stringContentDrift=0`）。
- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=179 waterLines=0 waterRate=0.00%`。

## 38. LC-31：桌面平台 IPC 装配 / 动作 trace broker（2 文件 / 18 行）

批次目录 `_annot_baseline/ZC-lc31/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置 |
| --- | ---: | --- |
| `desktopMainIpcPlatform.ts` | 9 | 5 行 L 补 `必须`；4 行 W 补 `会/必须` |
| `rendererActionTraceBroker.ts` | 9 | 5 行 L 补 `必须/不能`；4 行 W 补 `必须` |

- `_patch.mjs` 逐行断言旧正文，`PATCHED 18`。
- `zc-verify --rewrite ZC-lc31`：全 0。
- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=191 waterLines=0 waterRate=0.00%`。

## 39. LC-32：本地 TTFT 跨度（1 文件 / 24 行，含 5 组 POEM 合并）

批次目录 `_annot_baseline/ZC-lc32/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

- 4 行 W 单行补真实标识符/谓词：`:21` 补 `必须`；`:28` 补 `record` 与 `completeRecord`；`:80` 补 `HrTime`；`:81` 补 `必须`。
- 5 组 POEM 合并（`；` 连接，合并后补 `必须`/`includeRecord`）：

| 起始行 | 原行数 | 合并后 | 内容主题 |
| --- | ---: | ---: | --- |
| 30 | 3 | 1 | 属性表复用 / `includeRecord` / 返回顺序 |
| 77 | 3 | 1 | 根标识 / 哈希输入 / 内部跨度与采样 |
| 118 | 4 | 1 | 根跨度产出条件 / 根名称 / 首输出标记 / 检查点回退 |
| 133 | 4 | 1 | 子跨度 / 名称前缀 / 时钟来源 / 不参与根标记 |
| 160 | 6 | 1 | 区间来源 / 时钟过滤 / 夹取 / 过滤 / 游标累加 / 未归因时长 |

- **结构性标记检查（§16.2）**：5 个合并组逐组复核，**均不含** `[契约]`、`[权衡]`、`[失败路径]`，无成对标记被拆散，无需拆回。
- `_patch.mjs` 逐块断言旧正文，`PATCHED 9`（4 行替换 + 5 行合并结果）。
- `zc-verify --rewrite ZC-lc32`：`deletedOwnCommentLines=24`，其余全 0（含 `stringContentDrift=0`）。
- `zc-gate --scan`：`files=1 badFiles=0 addedCommentLines=31 waterLines=0 waterRate=0.00%`，即 46 → 31，净减 15 行（合并所致，见 §11.1）。

## 40. LC-33：启动工作区恢复 / Chrome Profile 发现 / 远控传输（3 文件 / 25 行）

批次目录 `_annot_baseline/ZC-lc33/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置 |
| --- | ---: | --- |
| `startupWorkspace.ts` | 9 | 全部 W：5 行补 `必须`；3 行补真实标识符（`STARTUP_AGENT_WARMUP_LIMIT`、`lastWorkspaceSession`、`lastActiveWorkspace`） |
| `chromeProfileDiscovery.ts` | 8 | 5 行 L 补 `必须/不能`；`:47` W 补 `DISCOVERY_COMMAND_TIMEOUT_MS`；`:84` L 由 `会` 消解；`:337` W 补 `不能` |
| `web-remote-relay/webRemoteControlTransport.ts` | 8 | 4 行 L 补 `必须`；4 行 W 补 `必须` |

- `_patch.mjs` 逐行断言旧正文，`PATCHED 25`。
- `zc-verify --rewrite ZC-lc33`：
  `rewrittenSegments=24 deletedOwnCommentLines=25`，其余全 0（含 `stringContentDrift=0`、`literalCommentDeletion=0`）。
- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=184 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=55 addedCommentLines=10743 waterLines=541 waterRate=5.04%`；非零仅因清单尚有余量，账目见 §11.1。

## 41. LC-34：Windows 资源管理器菜单 / Chrome 可执行发现 / 编辑器打开链路（3 文件 / 22 行）

批次目录 `_annot_baseline/ZC-lc34/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置 |
| --- | ---: | --- |
| `desktopWindowsOpenFolderContextMenu.ts` | 7 | 全部 W；`:51` 同时为 L，补 `必须` 后一并消解；`:26` 补 `MENU_LABELS`、`:59` 补 `open-workspace` |
| `chromeExecutableDiscovery.ts` | 7 | `:1` L 补 `必须`；`:134` W+L 补 `必须` 一并消解；其余 5 行 W 补 `必须` |
| `openInEditor.ts` | 8 | 7 行 L 补 `必须/只能/不能`；`:398` W 补 `必须` |

- `_patch.mjs` 逐行断言旧正文，`PATCHED 22`。
- `zc-verify --rewrite ZC-lc34`：`rewrittenSegments=21 deletedOwnCommentLines=22`，其余全 0（含 `stringContentDrift=0`）。
- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=210 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=52 addedCommentLines=10743 waterLines=519 waterRate=4.83%`；非零仅因清单尚有余量，账目见 §11.1。

## 42. LC-35：上下文提示 rollout / Playwright DOM 快照 / OAuth 深链（3 文件 / 34 行）

批次目录 `_annot_baseline/ZC-lc35/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置 |
| --- | ---: | --- |
| `desktopContextPromptRollout.ts` | 20 | 3 行 W 补 `必须`；4 组 POEM 合并（4+5+4+4 行 → 4 行，合并后补 `必须/不能/必须先`） |
| `browserView/browserPlaywrightDomSnapshot.ts` | 7 | 5 行 L 补 `必须/不能/保持`；2 行 W 补 `必须` |
| `desktopOAuthDeepLink.ts` | 7 | 3 行 L 补 `必须`；4 行 W 补 `必须` |

- **结构性标记检查（§16.2）**：4 个合并组（`desktopContextPromptRollout.ts` 的 39/98/121/182）逐组复核，**均不含** `[契约]`、`[权衡]`、`[失败路径]`，无需拆回。
- `_patch.mjs` 逐块断言旧正文，`PATCHED 21`（17 行替换 + 4 行合并结果）。
- `zc-verify --rewrite ZC-lc35`：`rewrittenSegments=20 deletedOwnCommentLines=34`，其余全 0（含 `stringContentDrift=0`）。
- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=254 waterLines=0 waterRate=0.00%`；`desktopContextPromptRollout.ts` 的 added 46 → 33（−13，见 §11.1）。
- 全量复核（244 文件）：`badFiles=49 addedCommentLines=10730 waterLines=485 waterRate=4.52%`；非零仅因清单尚有余量，账目见 §11.1。

## 43. 每批收尾六件套（fail-closed，缺一不可）

> 只在出事后才被想起的检查，等于没有。自 LC-29 起，每批收尾必须逐条跑完并把六条 SUMMARY 贴进批次记录；任何一条非零都不得声称该批完成。方法与全局口径同步写入 `docs/annotation/DEEP-SPEC.md` §5.1。

| # | 检查 | 命令（cwd=`D:\code\_annot_baseline`） | 通过判据 | 失败意味着什么 |
| --- | --- | --- | --- | --- |
| 1 | 代码 token 流 | `node check-code-tokens.mjs ...` | 与 HEAD 逐 token 一致 | 改了代码，或注释落进了 token 流 |
| 2 | 字符串内无新增注释行 | `node check-comments-in-strings.mjs D:\code\ZCode <files.txt>` | `addedViolations=0` | 把 `//` 写进字符串/模板/JSX 文本，运行时会输出可见文本 |
| 3 | 上游注释未删 | `node check-upstream-comments.mjs ...` | `missing=0` | 删掉了 HEAD 里本来就有的注释 |
| 4 | 零删除 | `node zc-verify.mjs --rewrite ZC-lcNN` | `deletedNonZero=0`（删行只允许相对 HEAD 新增的自有注释） | 删了非自有行，或删行入账不实 |
| 5 | 行尾一致 | `node check-eol.mjs D:\code\ZCode <files.txt>` | `bareLF=0` | 整文件重写把 CRLF 改成 LF；token 检查归一化后看不见 |
| 6 | 字符串内文等值 | `node _check-string-drift.mjs <files.txt>` | `stringDriftFiles=0` 且 `parseFailed=0` | 字面量内文与 HEAD 不同，改变了运行时真实输出；token 种类不变，第 1 条看不见 |

**第 3 条必须与第 4 条同时为 0（2026-11-09 硬规则）**
- `check-upstream-comments` 是**多重集**口径：它只证明「HEAD 里那行文本没有少」，**不证明「没被移动」**。`zc-verify` 的 `upstreamCommentDeleted` 是顺序口径，能发现「原位置少一行、别处多一行」。
- 实例：`index.ts:1078` 的上游注释被误删后又插回，但插在相邻自有注释之后（与 HEAD 顺序相反）；第 3 条报 `missing=0`，第 4 条仍报 `upstreamCommentDeleted=1`。
- 处置：恢复上游注释必须**按 HEAD 原顺序插回**；批次放行必须同时满足第 3 条 `missing=0` 与第 4 条 `upstreamCommentDeleted=0`。只跑多重集就算通过，属于漏检。

**第七件：注释近重复（报告级，2026-11-09）**
- 命令：`node _check-comment-dups.mjs D:\code\ZCode <files.txt> [--json out.json] [--exempt exempt.txt]`；命中退出码 1，但**不阻断**，只把 SUMMARY 贴进批次记录。
- 判据：同一注释块内、行距 ≤ 2、两行均 OWN、char-bigram Jaccard ≥ 0.5；显式排除结构标记行（`[契约]`/`[权衡]`/`[失败路径]`/`INV-nn`）、`守住…：` 续行、POEM 合并行、纯装饰线。
- 豁免：`--exempt` 为 `文件:行号` 清单，随批次归档并写明理由；无理由豁免按未检查处理。
- 校准与接入理由见 `DEEP-SPEC.md` §5.2：原始判据 244 文件命中 5 对全为假阳性，收紧后归零；样本不足，暂不升级为阻断项。

**第 2 条口径修正（2026-11-09，LC-38）**
- 原判据 `violations=0` 会把 HEAD 里就有的内嵌代码注释一起拦下：`windowsAumidIcon.ts:74` 是嵌在 C# 源码模板里的 `// SIIGBF_...`，属上游真实代码，不是我们写进去的注释。
- 现判据改为 `addedViolations=0`：只把**本次 diff 新增行**里的字符串内 `//` 计为违规，既有命中标 `PRE-EXISTING` 仅作清单输出。理由与第 6 条互补——我们只能通过新增行污染字面量，既有行不是本流程能改的对象。
- 全量 244 文件实测：`violations=8 addedViolations=0`，8 条全部 `PRE-EXISTING`（内嵌 C# / 页面脚本 / 生成 HTML），退出码 0。

**第 6 条固化说明（2026-11-09）**
- 脚本：`_annot_baseline/_check-string-drift.mjs`，默认清单 `ZC-lc-adjacent.txt`（244 文件），可传自定义 `<files.txt>`。
- 实现：按 AST 顺序抽取 `StringLiteral` / `NoSubstitutionTemplateLiteral` / `TemplateHead|Middle|Tail` / `RegularExpressionLiteral` 原文，与 `git show HEAD:<rel>` 逐字面量比对；`.tsx` 按 `ScriptKind.TSX` 解析。
- 本次加固：解析失败由 `parseSkip` 改为 `parseFailed` 并**计入非零退出**（原实现解析失败会被静默跳过，属同类盲区）；SUMMARY 固定输出 `files / stringDriftFiles / parseFailed`。
- 与第 1 条的分工：第 1 条比 token 种类与文本，「往字符串里加字」不改变种类，恒为 0；第 6 条才覆盖这类污染。

## 44. 剩余 49 个文件的形状（按性质三档）

> 口径：行数 = `zc-gate --scan` 的 waterLines（同一行多码只计 1 行，POEM 按连续行数计）。共 **49 文件 / 485 行**。
> 分档只看「解法性质」，不看文件大小；`需判断` 不等于难，而是改写前必须读上下文，确认补的谓词不改变契约语义。
>
> 进度：LC-36 清 3 文件 / 21 行（§45）；LC-37 清 3 文件 / 18 行（§46）；LC-38 清 2 文件 / 27 行（§47）；LC-39 清 1 文件 / 21 行（§48）；LC-40 清 3 文件 / 57 行（§49）；LC-41 清 2 文件 / 36 行（§50）；LC-42 清 2 文件 / 30 行（§51）；LC-43 清 2 文件 / 27 行（§52）；LC-44 清 2 文件 / 25 行（§53）；LC-45 清 2 文件 / 23 行（§54）；LC-46 清 2 文件 / 22 行（§55）；LC-47 清 2 文件 / 22 行（§56）；LC-48 清 4 文件 / 20 行（§57）；LC-49 清 10 文件 / 23 行（§58）；LC-50 清 1 文件 / 13 行（§59）；LC-51 清 1 文件 / 40 行（§60）；LC-52 清 1 文件 / 39 行（§61）；LC-53 清 6 文件 / 21 行（§62）；**剩余 0 文件 / 0 行**（全量 `badFiles=0`、`waterLines=0`）。

### 44.1 可清零（36 文件 / 386 行）

普通注释，补谓词 / 补真实标识符 / POEM 合并即可归零，可连续批量推进。

| 行数 | 文件 |
| ---: | --- |
| 40 | `index.ts`（含 1 行纯分隔标题，见 44.3） |
| 22 | `unreadBadge.ts` |
| 21 | `zcodeDataSizeScanner.ts` |
| 19 | `desktopArmsCustomEvent.ts`、`desktopCuaPermissionIpc.ts`、`processResourceMcpTelemetrySource.ts` |
| 18 | `desktopNetworkPolicy.ts`、`rendererActionTraceIpc.ts` |
| 16 | `embeddedBrowserJavaScriptDialog.ts` |
| 14 | `embeddedBrowserPermissionPolicy.ts`、`localMediaPreviewProtocol.ts` |
| 13 | `desktopMainIpcHelpers.ts`、`browserView/browserScreenshotSurfaceContracts.ts`、`pluginSandbox/permissionGate.ts` |
| 12 | `appTelemetryRuntime.ts`、`desktopNotifications.ts` |
| 11 | `databaseStartupTelemetry.ts`、`desktopCronScheduler.ts`、`desktopMcpTelemetry.ts`、`desktopWebRemoteControlIpc.ts`、`resourceManagerNetwork.ts` |
| 5 | `windowsAumidIcon.ts`、`browserView/browserCommandExecutor.ts`、`browserView/browserTabResidencyCoordinator.ts`、`mcpUserDirectory/claude.ts`、`pluginSandbox/protocol.ts` |
| 4 | `cuaAccessibilitySettings.ts`、`databaseStartupRelay.ts` |
| 3 | `chromeInstallationCandidates.ts`、`pluginSandbox/session.ts` |
| 2 | `desktopNetworkTelemetry.ts`、`desktopRemoteSessions.ts`、`browserView/browserGuestManager.ts` |
| 1 | `windowsInstallResourceLocks.ts`、`browserView/browserVirtualClipboardPageScript.ts`、`mcpUserDirectory/legacy.ts` |

### 44.2 需判断（13 文件 / 99 行）

含 `[契约]` / `[权衡]` / `[失败路径]` / `INV-` 或行为断言：每行改写前必须读实现上下文，确认补的谓词与原保证等价；不能机械替换。

| 行数 | 文件 | 判断点 |
| ---: | --- | --- |
| 39 | `autoUpdater.ts` | 升级状态机契约最密集，需逐条对实现 |
| 7 | `applicationIcons.ts` | bundle id 索引大小写语义 |
| 7 | `desktopDeepLinkUrl.ts` | 协议精确匹配的安全断言 |
| 7 | `desktopWindowChrome.ts` | 窗口 chrome 装配顺序与视觉契约 |
| 6 | `aboutWindow.ts` | 零外部资源断言 |
| 6 | `desktopBrowserViewIpc.ts` | 通道名只从常量取的断言 |
| 6 | `networkTelemetryAggregator.ts` | 桶数量上限与合并规则 |
| 5 | `browserView/browserScreenshotActivityController.ts` | 假死边界的失败路径 |
| 5 | `browserView/browserScreenshotSurfaceCoordinator.ts` | 握手串行化职责边界 |
| 5 | `pluginSandbox/host.ts` | 停止流程串行化不变量 |
| 4 | `webRemoteControlManager.ts` | seq/epoch 严格递增的协议约束 |
| 1 | `about.ts` | 单实例窗口断言 |
| 1 | `desktopZCodeDataSizeTelemetry.ts` | 空闲放宽但忙碌检查不放宽的边界 |

### 44.3 结构性上限（0 文件 / 0 行）

字符串/模板/正则区间自 LC-25 尺子修正后已被 gate 排除，`_check-string-drift.mjs` 又对字面量内文做了逐字面量等值校验，故**剩余不存在「写不进去」的字符串内行**；剩余文件也不是生成代码，没有超长 switch 表。

唯一边缘：`index.ts` 的 `── 文件职责 ──` 是纯分隔标题（1 行，已计入 44.1 的 40 行），不是可写成句的注释——LC-51 的处置是补成 `── 文件职责（Electron main 入口装配） ──`，不删除、不豁免。

### 44.4 工作量预估

- 可清零 386 行：按每批 25~30 行，约 13~15 批。
- 需判断 99 行：按每批 20~25 行，约 4~5 批，主要成本在 `autoUpdater.ts`（39 行）。
- 结构性上限 0 行：没有尾声豁免项，485 行都是真实工作量。

## 45. LC-36：窗口 chrome / 应用图标 / 深链 URL（3 文件 / 21 行，需判断档）

批次目录 `_annot_baseline/ZC-lc36/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `desktopWindowChrome.ts` | 7 | 全部 L 补 `必须`：装配点、INV-05 协议白名单、平台分叉、guest 三分类、初始 src 判定、失败路径外开、主屏兜底 |
| `applicationIcons.ts` | 7 | INV-07/08/15 补 `必须`；`:37` 缓存键补 `必须`；`:72` W 补 `会`；`:114` 补 `必须先`；`:213` 三条件补 `必须` |
| `desktopDeepLinkUrl.ts` | 7 | INV-01/07/09/11/13/14/18 逐条补 `必须`，协议精确匹配与参数白名单语义不变 |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=3 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=3 scanned=3 stringRanges=264 violations=0` |
| 3 上游注释 | `SUMMARY files=3 checked=3 upstreamComments=525 missing=0` |
| 4 零删除 | `rewrittenSegments=19 deletedOwnCommentLines=21 codeTokenDiff=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=3 scanned=3 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=3 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=249 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=46 addedCommentLines=10730 waterLines=464 waterRate=4.32%`；非零仅因清单尚有余量，账目见 §11.1。

## 46. LC-37：关于对话框 / 内嵌浏览器 IPC / 网络遥测聚合（3 文件 / 18 行，需判断档）

批次目录 `_annot_baseline/ZC-lc37/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `aboutWindow.ts` | 6 | INV-08/12/15 补 `必须`；`:26` 改 `必须全部是字符串，不能接收`；`:39` W 补真实标识符 `escapeHtml`；`:42` `只用于 → 只能用于` |
| `desktopBrowserViewIpc.ts` | 6 | INV-01/02/05/15 补 `必须`、`不得 → 不能`；`:99` W 补 `win 失效时直接返回`（与 `:117` 的 `win.isDestroyed()` 早返回一致）；`:214` 补 `必须用 on` |
| `networkTelemetryAggregator.ts` | 6 | INV-02/05/08/12/17/18 逐条补 `必须`，桶上限、凭据剥离、错误折叠、配额截断语义不变 |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=3 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=3 scanned=3 stringRanges=158 violations=0` |
| 3 上游注释 | `SUMMARY files=3 checked=3 upstreamComments=317 missing=0` |
| 4 零删除 | `rewrittenSegments=16 deletedOwnCommentLines=18 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=3 scanned=3 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=3 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=223 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=43 addedCommentLines=10730 waterLines=446 waterRate=4.16%`。
- **第 5 件首次真实拦截**：首轮 `check-eol` 报 `aboutWindow.ts bareLF=252`。查因：`git ls-files --eol` 显示该文件 `i/lf w/lf`，而同批另外两个文件与全仓其余文件均为 `i/lf w/crlf`——此前某批用整文件重写把工作区 EOL 漂成了 LF，git 归一会掩盖它，token 比对又显式归一了 `\r\n`，只有第 5 件看得见。用 `check-eol --fix` 归一后复扫 `bareLF=0`，`git ls-files --eol` 恢复 `w/crlf`。

## 47. LC-38：未读角标渲染 / Windows AUMID 图标（2 文件 / 27 行，可清零档）

批次目录 `_annot_baseline/ZC-lc38/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `unreadBadge.ts` | 22 | 5 组 POEM 合并（`:25` 4→1、`:39` 4→1、`:139` 5→1、`:221` 4→1、`:279` 4→1），合并句补 `必须`/`所以` 并保留 `Number.isInteger`、`createWindowsTaskbarOverlayApplier` 等真实标识符；`:21` W 补 `createWindowsTaskbarOverlayApplier` |
| `windowsAumidIcon.ts` | 5 | `:22` W+L 补 `SAFE_AUMID` + `必须`；`:23` W 补 `SAFE_AUMID`；`:93` W 补 `WindowsAumidIconDependencies`；`:100`/`:145` L 改 `不能`/`只能` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=39 violations=1 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=202 missing=0` |
| 4 零删除 | `rewrittenSegments=10 deletedOwnCommentLines=27 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=61 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=41 addedCommentLines=10714 waterLines=419 waterRate=3.91%`。
- **第 2 件口径修正（本批触发）**：首轮 `check-comments-in-strings` 报 `windowsAumidIcon.ts:74 violations=1`，该行是嵌在 C# 源码模板里的 `// SIIGBF_...`，属 HEAD 既有代码注释。脚本已改为只统计本批新增行（`addedViolations`），既有命中标 `PRE-EXISTING` 仅列出；全量 244 文件实测 `violations=8 addedViolations=0`。详见 §43「第 2 条口径修正」。
- 合并后首行仍触发 W（合并句只有中文、无 ASCII 锚点），补 `必须` 后归零——POEM 合并的收尾断言应为「合并后逐行再判一次」，不能假设合并即通过。

## 48. LC-39：数据体积扫描（1 文件 / 21 行，可清零档）

批次目录 `_annot_baseline/ZC-lc39/`。HEAD 分流：**全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `zcodeDataSizeScanner.ts` | 21 | 4 组合并（`:65` 5→1、`:111` 5→1、`:180` 4→1、`:206` 4→1），分别补 `scanZCodeDataDirectory`、`先`、`必须`、`ZCodeDataSizePartialReason`；`:21` W 补 `scanZCodeDataDirectory`；`:84` W 补 `maxDurationMs`；`:87` W 补 `ensureWithinLimits` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=1 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=1 scanned=1 stringRanges=28 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=1 checked=1 upstreamComments=141 missing=0` |
| 4 零删除 | `rewrittenSegments=7 deletedOwnCommentLines=21 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=1 scanned=1 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=1 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=1 badFiles=0 addedCommentLines=31 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=40 addedCommentLines=10700 waterLines=398 waterRate=3.72%`。

## 49. LC-40：ARMS 事件环 / CUA 权限 IPC / MCP 资源遥测（3 文件 / 57 行，可清零档）

批次目录 `_annot_baseline/ZC-lc40/`。HEAD 分流：**13 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `desktopArmsCustomEvent.ts` | 19 | 4 组合并（`:79` 5→1、`:143` 3→1、`:158` 5→1、`:201` 5→1），补 `now`/`record`/`entries.splice`/`read`/`sharedFinalArmsCustomEventE2E`/`buildFinalArmsCustomEventPayload`/`sendCustom` 与 `必须`/`只能`；`:21` W 补 `sharedFinalArmsCustomEventE2E` |
| `desktopCuaPermissionIpc.ts` | 19 | 4 组合并（`:59` 5→1、`:102` 5→1、`:258` 5→1、`:330` 4→1），补 `cachedZCodeIcon`/`process.resourcesPath`/`CUA_HELPER_DRAG_ICON_DATA_URL`/`startDrag`/`openSettings`/`finish`/`inspectFrontmost`/`accessibility`/`screen_recording`/`operationId`/`webContents` 与 `必须`/`只能` |
| `processResourceMcpTelemetrySource.ts` | 19 | 4 组合并（`:41` 5→1、`:57` 5→1、`:68` 5→1、`:100` 4→1），补 `MAX_MCP_GROUPS_PER_WINDOW`/`MAX_MCP_INSTANCE_SAMPLES`/`receivedAt`/`ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS`/`delivered`/`safeParse`/`sampledAt`/`runtimeSurface`/`environmentKey`/`processResourceHardwareKey` 与 `必须` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=3 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=3 scanned=3 stringRanges=100 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=3 checked=3 upstreamComments=342 missing=0` |
| 4 零删除 | `rewrittenSegments=13 deletedOwnCommentLines=57 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=3 scanned=3 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=3 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=3 badFiles=0 addedCommentLines=79 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=37 addedCommentLines=10656 waterLines=341 waterRate=3.20%`。

## 50. LC-41：Chromium 网络策略 / 渲染进程动作追踪 IPC（2 文件 / 36 行，可清零档）

批次目录 `_annot_baseline/ZC-lc41/`。HEAD 分流：**9 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `desktopNetworkPolicy.ts` | 18 | 4 组合并（`:78` 5→1、`:125` 5→1、`:189` 4→1、`:254` 4→1），补 `EMBEDDED_BROWSER_PARTITION`/`targets`/`closeAllConnections`/`allowInsecureCertificates`/`caCertPath`/`trustedFingerprints`/`MAX_CERTIFICATE_CHAIN_DEPTH`/`issuerCert` 与 `必须`/`不能` |
| `rendererActionTraceIpc.ts` | 18 | 4 组合并（`:34` 5→1、`:54` 5→1、`:98` 4→1、`:116` 3→1），补 `resolveRuntimeConfig`/`rendererInstances`/`senderId`/`refresh`/`stale`/`did-navigate`/`destroyed`/`BrowserWindow.getAllWindows()`/`rendererInstanceId` 与 `必须`；`:21` W 补 `rendererInstances` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=74 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=158 missing=0` |
| 4 零删除 | `rewrittenSegments=9 deletedOwnCommentLines=36 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=53 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=35 addedCommentLines=10629 waterLines=305 waterRate=2.87%`。

## 51. LC-42：内嵌浏览器原生弹窗 / 权限策略（2 文件 / 30 行，可清零档）

批次目录 `_annot_baseline/ZC-lc42/`。HEAD 分流：**10 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `embeddedBrowserJavaScriptDialog.ts` | 16 | 3 组合并（`:27` 4→1、`:126` 3→1、`:208` 6→1），补 `DEFAULT_AUTOMATION_GRACE_MS`/`automationGraceMs`/`USER_BROWSER_TAB_PREFIX`/`automationByWindow`/`openDialogGuestIds`/`AutomationWindowState`/`cleanupTimer`/`passthroughUntil`/`activeCount` 与 `必须`/`只能`；`:71` 补 `必须`；`:152` 补 `handled=false`；`:153` 补 `shouldUseNativeDialog` |
| `embeddedBrowserPermissionPolicy.ts` | 14 | 4 组合并（`:142` 3→1、`:153` 4→1、`:183` 4→1、`:275` 3→1），补 `UNKNOWN_ORIGIN`/`originFromUrl`/`initEmbeddedBrowserSitePermissions`/`sessionAllow`/`EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS`/`options.prompt`/`DEVICE_CHECK_PERMISSIONS` 与 `必须` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=140 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=442 missing=0` |
| 4 零删除 | `rewrittenSegments=9 deletedOwnCommentLines=30 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=62 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=33 addedCommentLines=10609 waterLines=275 waterRate=2.59%`。

## 52. LC-43：本地媒体预览协议 / 主进程打开路径公共实现（2 文件 / 27 行，可清零档）

批次目录 `_annot_baseline/ZC-lc43/`。HEAD 分流：**10 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `localMediaPreviewProtocol.ts` | 14 | 3 组合并（`:69` 5→1、`:164` 3→1、`:182` 4→1），补 `expiresAt`/`lastUsedAt`/`evictLeastRecentlyUsed`/`canonicalPath`/`LOCAL_MEDIA_PREVIEW_SCHEME`/`standard`/`stream`/`additionalSchemes`/`hostname`/`pathname`/`NET_ERR_INVALID_URL` 与 `必须`；`:20` 补 `LOCAL_MEDIA_PREVIEW_SCHEME`；`:21` 补 `LocalMediaPreviewPathRegistry`/`installedProtocols` |
| `desktopMainIpcHelpers.ts` | 13 | 4 组合并（`:35` 3→1、`:53` 3→1、`:90` 3→1、`:141` 3→1），补 `fileURLToPath`/`openPathInDefaultApp`/`normalize`/`realpath`/`process.platform`/`runOpen`/`firstError`/`finderError` 与 `必须`；`:20` 补四个真实导出名 |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=38 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=139 missing=0` |
| 4 零删除 | `rewrittenSegments=9 deletedOwnCommentLines=27 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=51 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=31 addedCommentLines=10592 waterLines=248 waterRate=2.34%`。

## 53. LC-44：插件沙箱权限闸门 / 应用遥测运行时（2 文件 / 25 行，可清零档）

批次目录 `_annot_baseline/ZC-lc44/`。HEAD 分流：**10 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `pluginSandbox/permissionGate.ts` | 13 | 3 组合并（`:56` 4→1、`:74` 4→1、`:110` 3→1），补 `inflight`/`consented`/`partition`/`guestUrl`/`record.shellUrl`/`recordFor` 与 `必须`；`:20` W+L 补 `createPluginSandboxPermissionGate` 与 `必须`；`:21` 补 `inflight`/`consented` |
| `appTelemetryRuntime.ts` | 12 | 3 组合并（`:48` 4→1、`:87` 3→1、`:107` 3→1），补 `rendererContexts`/`pendingStartupTelemetryRendererId`/`interactive`/`flushStartupTelemetry`；`:20` 补 `createAppTelemetryRuntime`；`:21` 补三个真实字段名 |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=33 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=25 missing=0` |
| 4 零删除 | `rewrittenSegments=8 deletedOwnCommentLines=25 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=50 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=29 addedCommentLines=10577 waterLines=223 waterRate=2.11%`。

## 54. LC-45：主进程任务通知 / 数据库启动遥测（2 文件 / 23 行，可清零档）

批次目录 `_annot_baseline/ZC-lc45/`。HEAD 分流：**10 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `desktopNotifications.ts` | 12 | 3 组合并（`:39` 3→1、`:97` 3→1、`:120` 4→1），补 `TASK_NOTIFICATION_DEDUPE_WINDOW_MS`/`permission_request`/`requestId`/`taskId`/`restore`/`show`/`BrowserWindow`/`safeParse`/`Notification` 与 `必须`/`先`；`:20` W+L 补 `desktopNotifications` 与 `必须`；`:21` 补两个真实集合名 |
| `databaseStartupTelemetry.ts` | 11 | 1 组 B 合并（`:37` 3→1）+ 2 组 POEM 合并（`:94` 3→1、`:134` 3→1），补 `startup_event_id`/`attempt.terminal`/`phase`/`databasePhase`/`database_startup_stage`/`app_startup_ready`/`app_startup_failed`/`state.disk` 与 `必须`；`:79` 补 `attempts`/`128`；`:106` 补 `database_startup_result` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=64 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=11 missing=0` |
| 4 零删除 | `rewrittenSegments=9 deletedOwnCommentLines=23 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=56 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=27 addedCommentLines=10564 waterLines=200 waterRate=1.89%`。

## 55. LC-46：Cron 调度子进程句柄 / MCP 遥测映射（2 文件 / 22 行，可清零档）

批次目录 `_annot_baseline/ZC-lc46/`。HEAD 分流：**10 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `desktopCronScheduler.ts` | 11 | 2 组合并（`:81` 3→1、`:115` 4→1），补 `DISPOSE_FORCE_KILL_MS`/`scheduler-log`/`offpeak-active-count`/`scheduler-resource-sample`/`cron-dispatch-request` 与 `必须`；`:90` 补 `child`；`:145` 补 `CronRun`；`:263` 补 `isDisposing`/`scheduler-dispose`；`:264` 补 `child`/`DISPOSE_FORCE_KILL_MS` |
| `desktopMcpTelemetry.ts` | 11 | 3 组合并（`:38` 4→1、`:73` 3→1、`:130` 3→1），补 `context`/`memory`/`sendCustom`/`runtimeSurface`/`process_start`/`process_crash`/`session_startup`/`perf_mcp_` 与 `必须`；`:21` 补 `context`/`configureDesktopMcpTelemetry` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=80 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=19 missing=0` |
| 4 零删除 | `rewrittenSegments=9 deletedOwnCommentLines=22 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=68 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=25 addedCommentLines=10552 waterLines=178 waterRate=1.69%`。

## 56. LC-47：Web 远程控制 IPC / 资源管理器网络采集（2 文件 / 22 行，可清零档）

批次目录 `_annot_baseline/ZC-lc47/`。HEAD 分流：**10 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `desktopWebRemoteControlIpc.ts` | 11 | 2 组合并（`:62` 3→1、`:82` 4→1），补 `workspaceKind`/`operation`/`telemetry` 与 `必须`；`:20` L 补模块名与 `必须`；`:39` 补五个真实方法名；`:132` 补 `getStatus`/`BrowserWindow`；`:133` 补 `notifyAuthStateChanged` |
| `resourceManagerNetwork.ts` | 11 | 3 组合并（`:50` 4→1、`:101` 3→1、`:136` 3→1），补 `captureId`/`randomUUID`/`buffer`/`session.defaultSession`/`HostMessageTypes.NetworkCapture`/`disposers`/`senderId` 与 `必须`；`:21` 补四个真实字段名 |

**合并后再判一次**：`:21` 首版改完仍报 L（标识符列举无谓词），补 `必须由模块级单例持有` 才归零——与 LC-38 同一类回归。

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=2 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=2 scanned=2 stringRanges=37 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=2 checked=2 upstreamComments=8 missing=0` |
| 4 零删除 | `rewrittenSegments=9 deletedOwnCommentLines=22 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=2 scanned=2 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=2 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=2 badFiles=0 addedCommentLines=55 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=23 addedCommentLines=10540 waterLines=156 waterRate=1.48%`。

## 57. LC-48：命令分派 / tab 驻留 / Claude 适配 / 沙箱协议（4 文件 / 20 行，可清零档）

批次目录 `_annot_baseline/ZC-lc48/`。HEAD 分流：**20 行全部 OWN，0 行 UPSTREAM**。本批全部为单行 W/L 原地改写，无合并。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `browserView/browserCommandExecutor.ts` | 5 | `:16` 补 `executeBrowserCommandOnView`；`:45` 补 `isAllowedBrowserUrl`/`BrowserPoint`；`:67` 补 `done` 与 `必须`；`:75` 补 `navigate`/`handleNavigate`；`:146` 补 `timedOut`/`TimeoutError` |
| `browserView/browserTabResidencyCoordinator.ts` | 5 | `:20`/`:21`/`:138`/`:168`/`:213` 各补 `必须`，原标识符与语义不动 |
| `mcpUserDirectory/claude.ts` | 5 | `:7` 补 `必须`；`:8` 改 `不能解析`/`不能启动`；`:190` 补 `merged.size === 0`；`:283`/`:352` 补 `必须` |
| `pluginSandbox/protocol.ts` | 5 | `:20`/`:122`/`:195` 补 `必须`；`:138` 补 `MIME_BY_EXTENSION`；`:335` 补 `installedProtocols` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=4 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=4 scanned=4 stringRanges=262 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=4 checked=4 upstreamComments=615 missing=0` |
| 4 零删除 | `rewrittenSegments=18 deletedOwnCommentLines=20 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=4 scanned=4 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=4 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=4 badFiles=0 addedCommentLines=229 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=19 addedCommentLines=10540 waterLines=136 waterRate=1.29%`。

## 58. LC-49：10 个小文件收口（10 文件 / 23 行，可清零档）

批次目录 `_annot_baseline/ZC-lc49/`。HEAD 分流：**23 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 唯一行 | 处置（均保持原契约语义） |
| --- | ---: | --- |
| `cuaAccessibilitySettings.ts` | 4 | `:217` 补 `settingsUrlForPermission`；`:252` 补 `verifyHelperPermissionIdentityUnchanged` 与 `所以`；`:314` 补 `CuaPermissionOnboardingCoordinator.sessions`；`:527` 补 `Math.max(1, sessionTimeoutMs - (Date.now() - startedAt))` |
| `databaseStartupRelay.ts` | 4 | `:52`/`:135` 补 `windowBindings`；`:67` 补 `必须一次做完`；`:88` 补 `senderId` |
| `chromeInstallationCandidates.ts` | 3 | `:2` 补 `buildStandardChromeInstallations`；`:27` 补 `所以`；`:32` 补三个路径函数名与 `必须` |
| `pluginSandbox/session.ts` | 3 | `:59` 补 `callback` 与 `所以`；`:131` 补 `必须`；`:133` 补 `setPermissionCheckHandler` |
| `desktopNetworkTelemetry.ts` | 2 | `:20` 补 `configureDesktopNetworkTelemetry`；`:21` 补 `globalContext`/`reportTimer` |
| `desktopRemoteSessions.ts` | 2 | `:59` 补 `connectFinalized`/`connected`；`:83`+`:84` 标记说明合并为 1 行并补 `必须` |
| `browserView/browserGuestManager.ts` | 2 | `:3748`/`:4755` 补 `所以`，保留原 `O(n)` 论证 |
| `windowsInstallResourceLocks.ts` | 1 | `:4` 补 `INV` 与 `必须` |
| `browserView/browserVirtualClipboardPageScript.ts` | 1 | `:15` 补 `VIRTUAL_PASTE_PAGE_FUNCTION` |
| `mcpUserDirectory/legacy.ts` | 1 | `:21` 补 `candidates`/`只` |

**过程事件（已处理）**
1. `_patch.mjs` 在 `desktopRemoteSessions.ts:59` 中断：该行是缩进续句，`//` 后带 8 个空格，断言按去一个空格比较导致 MISMATCH。改用 `_patch2.mjs`（断言前对正文 `trim()`）补齐剩余 8 行；未完成的 5 个文件由 `_patch2.mjs` 继续处理。
2. `browserVirtualClipboardPageScript.ts` 原工作区整文件为 LF，`check-eol` 首次报 `bareLF=118`。执行 `check-eol --fix` 后 `remaining=0`，`ls-files --eol` 为 `w/crlf`；修复后复跑 verify / token / string-drift 仍全 0。

**收尾六件套（§43）实测（EOL 修复后复跑）**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=10 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=10 scanned=10 stringRanges=1551 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=10 checked=10 upstreamComments=2385 missing=0` |
| 4 零删除 | `rewrittenSegments=22 deletedOwnCommentLines=24 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=10 scanned=10 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=10 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=10 badFiles=0 addedCommentLines=1644 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=9 addedCommentLines=10539 waterLines=113 waterRate=1.07%`。

## 59. LC-50：截图表面共享契约（1 文件 / 13 行，可清零档）

批次目录 `_annot_baseline/ZC-lc50/`。HEAD 分流：**5 行全部 OWN，0 行 UPSTREAM**。

| 位置 | 处置（均保持原契约语义） |
| --- | --- |
| `:20` | W 补 `browserScreenshotSurfaceContracts` |
| `:21` | W 补 `BrowserScreenshotActivityLease`/`BrowserScreenshotSurfaceCoordinator` |
| `:98` | 4→1，补 `VIEWPORT_TOLERANCE_PX`/`sameBrowserScreenshotViewport` 与 `只` |
| `:112` | 4→1，补 `releaseBrowserScreenshotResourceOnce`/`released`/`callback` |
| `:125` | 3→1，补 `toBrowserScreenshotSurfacePreparePayload`/`viewportMode`/`surfaceScaleMode`/`timeoutMs` |

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=1 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=1 scanned=1 stringRanges=3 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=1 checked=1 upstreamComments=2 missing=0` |
| 4 零删除 | `rewrittenSegments=4 deletedOwnCommentLines=13 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=1 scanned=1 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=1 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=1 badFiles=0 addedCommentLines=25 waterLines=0 waterRate=0.00%`。
- 全量复核（244 文件）：`badFiles=8 addedCommentLines=10531 waterLines=100 waterRate=0.95%`。

## 60. LC-51：`index.ts`（1 文件 / 40 行，可清零档）

批次目录 `_annot_baseline/ZC-lc51/`。HEAD 分流：**40 行全部 OWN，0 行 UPSTREAM**。

处置分两类：

| 类别 | 处置 |
| --- | --- |
| 40 行原地改写 | W 补真实标识符（`currentApplicationLocale`、`runtimeProcessEnvPrewarmSequence`、`windowUnreadCountMap`、`cleanup.terminationPids`、`resolveFocusedDesktopZoomLevel`、`executeDesktopCommandForApp` 等）；L 补谓词（`必须`/`所以`/`只能`）。契约语义不变，只把「它在做什么」换成「哪个标识符 + 破坏顺序会怎样」 |
| 13 行重复注释合并 | 10 行逐字重复（`:375/:376/:402/:560/:1335/:1774/:2270/:2271/:2510/:3144`）+ 3 行前缀重复（`:1082/:1634/:3095`）。均为前序批次双写遗留，含 ASCII 标识符且单行不构成 POEM，**gate 的 W/L/POEM 三判据都看不见** |

**一处必须记录的失败**：试删 `:1078` 的「帮助配置是公开读取…」时，`check-upstream-comments` 报 `missing=0`（多重集口径），但 `zc-verify` 报 `upstreamCommentDeleted=1`——该行在 HEAD 中存在，属上游注释；且恢复时若位置顺序与 HEAD 相反，diff 仍会计为「删一处、加一处」。已按 HEAD 原顺序（上游行在自有行之前）恢复，复跑归零。结论：**多重集检查通过不等于上游注释未被移动**，两者必须同时为 0。

**收尾六件套（§43）实测（末次）**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=1 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=1 scanned=1 stringRanges=401 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=1 checked=1 upstreamComments=1110 missing=0` |
| 4 零删除 | `rewrittenSegments=48 deletedOwnCommentLines=53 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=1 scanned=1 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=1 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=1 badFiles=0 addedCommentLines=534 waterLines=0 waterRate=0.00%`（原 547，−13）。
- 重复检测复扫（char-bigram ≥ 0.5）：仅剩 `:5/:14` 两行裸 `//` 分隔线，无内容重复。

## 61. LC-52：`autoUpdater.ts`（1 文件 / 39 行，需判断档）

批次目录 `_annot_baseline/ZC-lc52/`。HEAD 分流：**39 行全部 OWN，0 行 UPSTREAM**。

- 39 行全部原地改写，行数不增减。多数是 INV 续句（缩进 8 空格的第二/三行），处置是**保留原缩进**（`_patch.mjs` 保留 `//` 后的空白前缀），只补标识符或谓词，避免把续句顶格而破坏段落。
- 重点语义核对：`INV-20` 互斥闸、`recovering → idle` 回退后果、`publishDownloadedUpdate` 半包、竞态三重校验（token 身份 / 未取消 / 未锁定）、轮询三档节奏。改写只把「它/该处」换成函数名或状态名，未新增也未放宽任何契约。
- 复扫后无内容重复（仅 `:8/:49` 两行裸 `//` 分隔线）。

**收尾六件套（§43）实测**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=1 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=1 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=1 checked=1 missing=0` |
| 4 零删除 | `rewrittenSegments=39 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=1 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=1 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=1 badFiles=0 waterLines=0 waterRate=0.00%`。

## 62. LC-53：截图/沙箱/远控/关于/遥测（6 文件 / 21 行，需判断档）

批次目录 `_annot_baseline/ZC-lc53/`。HEAD 分流：**21 行全部 OWN，0 行 UPSTREAM**。

| 文件 | 行数 | 处置 |
| --- | ---: | --- |
| `browserView/browserScreenshotActivityController.ts` | 5 | L 补 `所以`/`必须`；W 补 `waitForPumpTurn`/`captureOnce`/`transientRetry`/`settled`。另删 `:289-291` 三行——与上游 `:286-287` 及自有 `:288` 重复同一事实（microtask 饥饿导致假死） |
| `browserView/browserScreenshotSurfaceCoordinator.ts` | 5 | 补 `DesktopBrowserScreenshotSurfaceCoordinator`/`groupsByGuestKey`/`groupsByReadyRequestId`/`queuedGroups`/`settleGroup`；INV-18 补 `必须` |
| `pluginSandbox/host.ts` | 5 | INV-06/13 补 `必须`；`[权衡]`/`[并发]` 补 `所以`；`:401` W 补 `CopyImage` |
| `webRemoteControlManager.ts` | 4 | INV-14 改为「必须同时满足…」；INV-17 补 `不能`；平台请求补 `必须`；`relayProtocol` 补 `必须` |
| `about.ts` | 1 | INV-01 补 `只能` |
| `desktopZCodeDataSizeTelemetry.ts` | 1 | INV-12 补 `绝不能` |

**收尾六件套（§43）实测（末次）**
| # | 结果 |
| --- | --- |
| 1 token | `SUMMARY files=6 codeTokenDiff=0` |
| 2 字符串内 | `SUMMARY files=6 scanned=6 stringRanges=538 violations=0 addedViolations=0` |
| 3 上游注释 | `SUMMARY files=6 checked=6 upstreamComments=778 missing=0` |
| 4 零删除 | `rewrittenSegments=21 deletedOwnCommentLines=23 codeTokenDiff=0 headTokenDrift=0 stringContentDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0` |
| 5 行尾 | `SUMMARY files=6 scanned=6 bareLF=0 remaining=0 filesWithBareLF=0` |
| 6 字符串内文 | `SUMMARY files=6 stringDriftFiles=0 parseFailed=0` |

- `zc-gate --scan`：`files=6 badFiles=0 addedCommentLines=927 waterLines=0 waterRate=0.00%`。

## 63. 全量清零确认（LC-51~53 收尾）

`node zc-gate.mjs --scan ZC-lc-adjacent.txt`（cwd=`_annot_baseline`）：

```
SUMMARY files=244 badFiles=0 addedCommentLines=10515 waterLines=0 waterRate=0.00%
```

- 账目闭环：`10531（LC-50 末） −13（LC-51 重复合并） −0（LC-52） −3（LC-53 与上游重复的复述） = 10515`。
- 244 个文件、LC-1~LC-53 全部通过收尾六件套；`badFiles=0`、`waterLines=0` 为最终状态。
- 遗留口径限制（沿用 §0.1(d)）：本轮仍是语法 fail-closed 校验，未跑 `tsc --noEmit` 与单元测试，不得据此宣称「构建通过」。
- 重复检测工具已固化为 `_annot_baseline/_check-comment-dups.mjs`（报告级第七件），校准与接入口径见 §64 与 `DEEP-SPEC.md` §5.2。

## 64. 收尾规则升级与两项重算（2026-11-09）

### 64.1 硬规则：多重集 ≠ 未被移动，两把尺子必须同时为 0

`check-upstream-comments` 只做**多重集**比对（HEAD 有几次、当前有几次），能证明「没少一条」，不能证明「没被移动」。**顺序口径**由 `zc-verify` 的 `upstreamCommentDeleted` 承担。两者必须同时为 0：

| 尺子 | 工具 | 能发现 | 看不见 |
| --- | --- | --- | --- |
| 多重集 | `check-upstream-comments` | 上游注释被删成 0 次 | 删一处、别处补一处（文本相等但位置变了） |
| 顺序 | `zc-verify --rewrite` | 上游注释位置/顺序变化 | — |

实录：`index.ts:1078` 误删后插回，第 3 条 `missing=0`，第 4 条 `upstreamCommentDeleted=1`。恢复时必须按 HEAD 原顺序插回（相邻自有注释的前后关系也要一致）。已写入 `DEEP-SPEC.md` §5.1。

### 64.2 重复注释全量扫描（244 文件）

工具：`_check-comment-dups.mjs`（判据与排除项见 `DEEP-SPEC.md` §5.2）。

| 配置 | 命中文件 | 命中行 | 逐字 | 前缀 | 换措辞 | 人工判定 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 无排除、行距 ≤ 10 | 5 | 10 | 4 | 0 | 1 | 5 对全为假阳性 |
| 排除生效、行距 ≤ 2（2026-11-10 修正后） | 0 | 0 | 0 | 0 | 0 | — |
| 排除生效、行距 ≤ 10（2026-11-10 修正后） | 0 | 0 | 0 | 0 | 0 | — |

无排除时前 10 名分布（每个文件 2 行）：

| 文件 | 命中行 | 性质 |
| --- | ---: | --- |
| `desktopMainIpcRemote.ts` | 2 | 装饰线 `====`（假阳性） |
| `desktopStabilityTelemetry.ts` | 2 | 装饰线 `====`（假阳性） |
| `browserView/browserGuestManager.ts` | 2 | 装饰线 `====`（假阳性） |
| `browserView/browserPlaywrightLocatorExecutor.ts` | 2 | 装饰线 `====`（假阳性） |
| `taskRealtimeBus.ts` | 2 | INV-03 与 INV-04 的 `守住：flushBatch…` 两行，各自守卫不同不变量（假阳性） |

**真实重复已在 LC-51/LC-53 清除**：`index.ts` 13 行（10 逐字 + 3 前缀）+ `browserScreenshotActivityController.ts` 3 行（与上游 `:286-287` 同事实）。全量复扫归零。

结论口径（2026-11-10 修正）：**只能对「both-OWN 近重复」说「已不存在」**，且该结论以 §64.4 的阳性对照为前提。`browserScreenshotActivityController.ts` 那 3 行属于「自有注释复述上游」，判据要求两端均 OWN，结构上报不出来，是人工复核发现的——这一类**不在检测器覆盖范围内**。

### 64.3 `deep-quality` v3 重算（244 文件）

命令（cwd=`D:\code\_annot_baseline`）：

```bash
node deep-quality.mjs D:/code/ZCode --file-list ZC-lc-adjacent.txt --json zc-244-v3.json
node deep-quality.mjs D:/code/ZCode --file-list ZC-lc-adjacent.txt --metric-version v2 --json zc-244-v2.json
```

| 指标 | v2（旧口径，已被取代） | v3（当前） |
| --- | ---: | ---: |
| `units` | 26944 | 32176 |
| 语句覆盖 | 14.5% | 12.6% |
| 分支覆盖 | 14.2% | 14.2% |
| 字段覆盖 | 6.3% | 3.1% |
| 注释行 | 14121 | 14121 |
| 注水率 | 0.0% | 0.0% |

- **本文件 §9/§11 及各处出现过的 v2 覆盖率数字一律作废**，以本表 v3 为准；不得用 v2 与 v3 相减宣称升降。
- 变化最大的 5 个文件与单元数增长最快的 5 个文件见 `DEEP-SPEC.md` §4.4。
- **注水率不变**：ZCode 的水率由 `zc-gate.mjs` 行级 W/L/POEM 口径计算，与 `deep-quality.mjs` 的 `fillerRate` 不同源；v3 只改语句/分支/字段分母，`waterLines` 仍为 0。

### 64.4 重复检测器阳性对照（2026-11-10）

「命中归零」有两种解释：语料真干净，或排除规则把真阳性一起吞了。必须用已知真阳性回放来区分。

**做法**：临时仓库 `_pc-dups`，HEAD 提交 `git show HEAD:` 的上游快照，工作区放删除前版本（`ZC-lc51/orig/index.ts`、`ZC-lc53/orig/browserScreenshotActivityController.ts`），OWN/UPSTREAM 判定条件与真实扫描一致。脚手架：`_pc_build.mjs`。

| 对象 | 无排除 | 四类排除 | 判定 |
| --- | ---: | ---: | --- |
| `index.ts`（13 行已知重复） | 12 对 / 24 行 | 12 对 / 24 行 | 8 逐字 + 4 换措辞，全为真阳性 |
| `browserScreenshotActivityController.ts`（3 行） | 0 | 0 | 判据盲区（一端是 UPSTREAM） |

**对照抓出的两个过宽规则（已修）**：

| 规则 | 原口径 | 问题 | 现在 |
| --- | --- | --- | --- |
| 结构标记连带排除 | 上一行是 `[契约]`/`[事务]` 等就跳过本行 | 吞掉 3 对真阳性（`:1771/1774`、`:2267/2270`、`:3141/3144`） | 只看**行首**标记 |
| POEM 合并排除 | 一行 ≥2 个 `。`/`；` | 把正常的两句长注释当 POEM（吞掉 `:372/375`、`:2507/2510`） | 收紧到 **≥3** |

**召回边界**：第 13 对（`index.ts:1332/1335`「都通过它，而不是各自 new BrowserWindow」缩略复述）相似度 **0.4898**，低于阈值 0.5 漏报。降到 0.45 可抓回，但 244 文件会多 1 条假阳性（`webRemoteControlManager.ts:19/25`，同一 INV 的两个不同守卫位置）。因此**阈值保持 0.5**，漏报缩略复述记为已知召回边界。

**结论**：修正后 244 文件复扫仍为 **0 对 / 0 行**（行距 2 与 10 都是 0），且这次是「工具已证明能抓、语料确实没有」，而不是「工具没响」。适用范围仅限 **both-OWN**；复述上游注释那一类不在覆盖内。

### 64.5 注释行与覆盖率的差额（2026-11-10）

`comments=14121` 而覆盖单元 `4054`（12.6% × 32176），差在哪必须写清，否则 12.6% 会被误读成「只有 12.6% 的注释有用」。

| 口径 | 注释行 | 占比 |
| --- | ---: | ---: |
| 全部注释行 | 14121 | 100% |
| `mappedStrict`（被单元直接命中） | 4035 | 28.6% |
| `mappedBlock`（所在注释块整体计入） | 10997 | 77.9% |
| 未映射 | 3124 | 22.1% |

未映射原因：`import:2734`（87.5%）、`continuation:241`、`structural:116`、`gap:0`、`eof:0`、`other:33`。

- **空行不丢覆盖**：`commentAbove` 允许代码上方 0–2 个空行，实测 `gap:0`——没有任何一条注释因为隔了空行而失去映射。「段首说明 + 空行 + 代码」照常计覆盖。
- **块级注释按单元摊薄**：10997 / 4054 ≈ 2.71 行注释对 1 个覆盖单元。多行块注释只让 1 个单元变「已覆盖」，这是分母口径，不是浪费。
- **19.4% 的注释行不对应任何单元**：绝大多数在 `import` 上方（模块头、依赖理由）。有价值但不进覆盖率。
- **选点必须看 `uncoveredUnits` 明细**，禁止只按覆盖率排序：覆盖率低可能是块注释写得好但单元多，也可能是大段代码裸奔，两者处置完全不同。

### 65. 深度阶段排序（2026-11-10，未开写）

LC 系列清的是历史水分（`waterLines` 0），深度阶段补的是覆盖缺口（语句 12.6%、字段 3.1%、未覆盖单元 28136 / 244 文件中的 242 个）。排序分 = 未覆盖单元数 × (1 + 跨进程边界 + 安全相关) + 边界点 × 3 + 安全点 × 3，`跨进程边界` 与 `安全相关` 由未覆盖行的文本关键字粗判（IPC/postMessage/utilityProcess/BrowserWindow；auth/token/permission/sandbox/path/csp），只用于排序，不作为判定依据。

| 序 | 文件 | 未覆盖单元 | 覆盖率 | 边界点 | 安全点 | 排序理由 |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `desktop/browserView/browserGuestManager.ts` | 2288 | 12.9% | 12 | 24 | 最大缺口；guest 生命周期 + 权限注入，跨 renderer/main 边界 |
| 2 | `desktop/index.ts` | 1059 | 23.4% | 49 | 48 | 装配层，几乎所有 IPC 与窗口生命周期都在此汇合 |
| 3 | `desktop/webRemoteControlManager.ts` | 973 | 21.7% | 3 | 54 | 远控鉴权/配对/会话替换，安全点最密集 |
| 4 | `desktop/autoUpdater.ts` | 959 | 18.0% | 18 | 30 | 签名/下载/安装，失败后果不可逆 |
| 5 | `desktop/desktopRemoteSessions.ts` | 830 | 12.8% | 81 | 4 | 边界点最多：远程会话路由与回放 |
| 6 | `desktop/desktopStabilityTelemetry.ts` | 576 | 11.5% | 43 | 10 | 崩溃/稳定性上报，跨进程事件链 |
| 7 | `desktop/taskRealtimeBus.ts` | 570 | 14.7% | 8 | 23 | 20 条 INV 的宿主，lease/seq/replay |
| 8 | `desktop/exportLogs.ts` | 576 | 10.4% | 0 | 17 | 日志导出，含脱敏边界；POEM 合并最多 |
| 9 | `desktop/browserView/browserPlaywrightLocatorExecutor.ts` | 661 | 11.9% | 0 | 17 | 定位器执行，与 guest 侧边界耦合 |
| 10 | `desktop/desktopHostProcess.ts` | 386 | 13.3% | 15 | 14 | Host 进程 spawn/dispose 生命周期 |
| 11 | `desktop/chromeLocalStorageManager.ts` | 371 | 11.5% | 5 | 38 | 本地存储读写，路径与权限校验 |
| 12 | `desktop/desktopCommandHandlers.ts` | 369 | 14.4% | 16 | 22 | 命令入口，main 能力注入面 |

与 claude-code / uv 一致的做法：逐行写「这行在做什么 / 为什么这样写 / 写错会怎样」，插入点必须在语句之前，仍然只动注释。开工前先确认 `browserGuestManager.ts` 是否是最后一条写入线（单文件单写入线规则），并先跑一次 `--uncovered` 明细，确认缺口是「没写」而不是「写了没贴住」。

### 66. DEEP-B228：`browserGuestManager.ts` 深注释（片 1–14 / 14 · A 轮 5/5）

批次文档 `docs/annotation/ZC-DEEP-b228.md`，快照 `_annot_baseline/ZC-deep-b228/orig`（= HEAD），清单 `ZC-deep-b228/_files.txt`（单文件）。
编号：`ZC-deep-b227` 目录已被 UI 四文件批占用且无对应文档，本批顺延 b228，未覆盖任何既有目录。

**开写前置（`--uncovered`）**：2288 未覆盖单元逐个向上 0–2 空行找注释，命中 **0** 条。缺口全部是「没写」，不存在「写了没贴住」；与 `MAP gap=0` 一致，本文件无需担心重复写已写段落。

**分片**：按 guest 生命周期切 14 片（create / attach / 权限注入 / 导航与加载 / 崩溃与恢复 / destroy，外加契约层、截图、录制三个横切面），每片行区间与未覆盖数见批次文档 §2。开写前先贴该片划分，每片后报文件累计覆盖率、该片新增行数、第七件是否 0。

**片 1（契约层 82–618，176 单元）**：

| 项 | 值 |
| --- | --- |
| 累计覆盖率 | 13.5%（12.9% → 13.5%，+16 单元） |
| 本片新增注释行 | 33（comments 1210 → 1243） |
| adjacentDup / intraDup | 0 对 |

- 六件套全 0：`codeTokenDiff=0` / `addedViolations=0` / `missing=0` / `zc-verify` 全 0（含 `upstreamCommentDeleted=0`、`stringContentDrift=0`）/ `bareLF=0` / `stringDriftFiles=0`；第七件 `pairs=0`。
- `zc-gate --file`：`badFiles=0 waterLines=0 waterRate=0.00%`（`addedCommentLines=911` 是该文件相对 HEAD 的累计值）。
- **声明行按六条判据重筛（126 单元）**：必须写 17（已补：`requestId`/`browserGeneration`/`windowId`/`workspaceKey`/`sessionId`/`GuestBindingLifecycle`/`tabId`/`owner`/`rebindRequested`/`cdpAttached`/`lifecycle`/`active`/`cachedUrl`/`restoredFromStore`/`DownloadRecord.path`/`DownloadRecord.state`/`onRecoveryOrphanCloseRequested`）、可写可不写 15、纯名字复述 94。判据见批次文档 §3。

**片 2（`attachGuest`，109 单元）**：

- 前置：81/109 在向上 8 行内有注释（块级摊薄，已写未计入），28 个真空白（create shell 字段、返回信封、日志参数）；不重复写。
- 新增 4 处判定点：restoring 代际校验失败必须连 incoming guest 一起关闭、`activeTabByScope` 只删自己、`recoveryFlight` 成功失败都摘除、每次 attach 都 `persistShell`。
- 指标：本片 +9 行；文件累计 14.3%；逻辑区 17.3%；声明区 7.2%。六件套全 0，第七件 0 对。
- **新缺陷 D-16-1**（A 档 / 中）：`attachGuest` 只校验 `getType()=="webview"`，未校验 `guest.hostWebContents` 归属、未拒绝已被其它 tab 占用的 guest；任意 renderer 传别的窗口的 webview id 即可共享 CDP 控制。已记入 `ZC-DEFECTS.md`，本批不改代码。
- **覆盖率口径拆分**：新增 `_annot_baseline/_region-split.mjs`（TS AST 分声明区/逻辑区），达标线只看逻辑区，全文件数仅作历史对照。

**片 3（归属查询 / viewport / residency / `restoreTabs`，104 单元）**：

- 两个数：`uncoveredUnits=104` → 79；真正空白 62 → 10。剩余 10 个都是「块注释已写、超出 8 行探测窗」的字面量字段（`operationActive`/`captureActive`/`downloadActive`、`rebindRequested`/`lifecycle`、`const restored`/`for`），不重复写。
- 新增 20 类判定点，核心是五组：`updateViewportFromRenderer` 只比 windowId 但必须拒 closed、`null` 不是 0×0；`reportResidency` 的空 URL 保留旧值、`undefined`/`null` 区分、只信任 renderer 能看见的四项；`selected` 分支 user tab 不进 `activeTabByScope`；`closeTabFromRenderer` 幂等路径补墓碑（INV-16）；`restoreTabs` 的墓碑优先、claim 先到先得、owner 字面量四个字段各自的哨兵/去重理由、无 guest shell 按未挂载初始化。
- 纠正一条既有注释：`updateViewportFromRenderer` 原称「自然尺寸不做钳制」，实际 renderer 的 pane 尺寸会过 `assertViewportOverride` 并按 override 写入；不钳制的是 `readTabViewport` 读到的 guest 实际尺寸。
- 指标：本片 +63 行（comments 1287 → 1350，`addedCommentLines` 911 → 974）；文件累计 15.2%（+24 单元，分支 13.7%、字段 6.3%）；逻辑区 18.4%；声明区 7.7%。六件套全 0，第七件 0 对。`zc-gate` 首遍 3 行 water（多逗号列举缺谓词）改写后归零。
- **新缺陷 D-9-4**（初记「低 / B 档」，片 4 已重新定性，见下条）：`whenRecoveryIdle` 注释称「用 allSettled 等所有恢复 flight」，实现只有 `await recoveryStore.whenIdle()`（仅等 mutation 队列）。已改注释陈述实际行为并记册，不改代码。
- **D-16-1 增补落点**（不单列新缺陷）：`restoreTabs` 的 `workspaceKey`/`sessionId`/`remoteSessionId` 由 renderer 自报，IPC 只把 `windowId` 覆盖成 `win.id`（`desktopBrowserViewIpc.ts:309-320`），可把别的工作区的 shell（URL/title）恢复进当前窗口；与「凭据不绑调用方身份」同根因，已并入 D-16-1 落点表。

**D-9-4 重新定性（功能未开启，不是「低」）**：

- 判定为**有意未启用**，证据六条：`index.ts:554-560` 两处显式产品决策注释；无 feature flag（`tabRecovery`/`restoreShells` 0 命中）；UI 从不调用 `browserViewRestoreTabs`；INV-17/19/20 只约束进程内；单测用 10 处手工注入的假 store；`browserTabRecoveryStore.ts` 的 INV-03/09 是跨进程恢复才需要的约束（说明实现完成后被关闭）。
- 后果边界：`restoreTabs` 恒 `[]`、`persistShell` 首行 `return`、`whenRecoveryIdle` 恒立即 resolve；但**进程内 suspend/resume 的 URL 恢复仍可用**（无 store 时 `restoreGuestState` 退化为 `loadURL(cachedUrl)`），缺的是跨进程落盘与多步历史。
- 缺陷册：级别改为「功能未开启」，B 档计数回到 15，统一索引改为「34 条 + 1 条功能未开启记录」，并写清四件开启条件（注入 store / 反转「完整退出即清空」语义 / renderer 启动调用 / `whenRecoveryIdle` 同时等 guest flight）。
- 可达性注释：`restoreTabs`、`persistShell`、`BrowserTabRecoveryStore` 类头各加一条整行 `[可达性]`，写明「生产不注入、恒空、以下分支不可达」。

**片 4（崩溃与恢复：`restoreSuspendedGuest` → `restoreReboundGuest`）**：

- 两个数：`uncoveredUnits=123` → 100；真正空白 39 → 32。余下 32 个是三份 payload 字面量（5 字段 × 3 次）与 `pageState` 分支内部，已由块注释与 `[可达性]` 整体交代，不再逐字段写。
- 11 类判定点：`markRestoring` 空返回不是失败、只有 `before=suspended` 才发重建、两处载荷各自该用 `transition.generation` 还是 `failed.generation`、孤儿分支先删仓库再关 tab、`completeRestore` 失败不补发终态、终态只允许两档、`restoreGuestState` 无 URL 必须 false、`restoreReboundGuest` await 前先验 guest。
- 用户点名的同类排查：`setupCdpCrashGuard`（`:1157` 注册 / `:3940` 先清旧 / `:5223-5227` teardown 清理）与 `runGuestTeardown`（`:5074`/`:5087` 两入口 / `:5199-5241` 三组 cleanup 全部执行并置空）均已接线，非死代码；`setupDialogTracking` 同样正常，未发现第三例「注册了但没人调用」。
- 指标：本片 +28 行（comments 1350 → 1378，`addedCommentLines` 974 → 1003，含 7 行 `[可达性]`）；文件累计 15.6%（+11 单元，分支 14.9%、字段 6.3%）；逻辑区 19.0%；声明区 7.8%。六件套全 0，第七件 0 对。
- 过程事故：一次 Edit 覆盖了既有注释行，`check-upstream-comments` 报 `missing=1`、`zc-verify` 报 `upstreamCommentDeleted=1`；已恢复原行并复核归零。后续凡在既有注释块内插入，先读原块再追加，不整体替换。

**片 5（teardown 与总收口：`runGuestTeardown` / `detachGuest` / `disposeAll`，150 单元）**：

- 两个数：`uncoveredUnits=150` → 103；真正空白 4 → 剩 4（`5080`/`5095`/`5288`/`5290`，都是块注释摊薄的续行或模板字符串结尾，不重复写）。
- 13 类判定点，核心是四组「顺序反了会怎样」：`runGuestTeardown` 先置 `detaching` 再 abort（反了并发 attach 会复用正在拆的 guest）；destroyed 且 `cdpAttached` 时返回 false（假装断开会让断言放过旧 Debugger，继续重建撞 INV-04）；detach 抛错后回滚 `attached`（留 `detaching` 会让 `assertCurrentGuest` 永久抛错）；`cdpAttached=false` 必须先于 `detachGuest`（反了会把正常收口误报成崩溃路径）。
- 其余：`detachGuest` 的 INV-18 分支（恢复在飞不回写 `cachedUrl`）、`guestLifecycle` 终态二态仅语义、`disposeAll` 迭代 Map 的安全前提、`downloadWaiters` 每轮重读 `waiters[0]`、下载文件不删而录制 artifact 删、`suspendAckWaiters` 必须逐个 resolve、四个 flight 只清引用不结算。
- 时序缺口排查：本片范围无「注册了但 cleanup 不完整」；四组 cleanup 都在 `detachGuest` 的 `try/catch + finally` 里置空，`disposeAll` 经同步 `closeTab → detachAndCloseGuest → detachGuest` 收口。唯一边界是 flight 只 `clear()`，依赖 `waitForGuestCdpIdle` 的超时兜底落定，已写进注释。
- 指标：本片 +38 行（comments 1410 → 1448，`addedCommentLines` 1003 → 1073）；文件累计 16.6%（+27 单元，分支 18.2%、字段 6.3%）；逻辑区 20.4%；声明区 7.8%。六件套全 0，第七件 0 对。`zc-gate` 首遍 2 行 water（短句无标识符）改写后归零。
- **新缺陷 D-9-5**（低 / B 档）：**有意降级**——CDP idle 超时后仍 detach 并返回 teardown 成功，主动放弃 INV-05 的严格保证。放弃它换来 `closeTab` 与替换路径不永久挂起；仅当未结算命令含写操作时才变成真问题（调用方会把「未结算」当「已静止」）。INV-05 原文不改、继续作为水位，条目只登记取舍；不得靠改写条款去消掉水位。

**片 6（截图 prepare 与 surface：`executeInScope` 截图分支 + `executeScreenshotWithPreparedSurface` 签名，2091–2248，59 单元）**：

- 两个数：`uncoveredUnits=59` → 52；真正空白 35 → 18。余下 18 个集中在返回信封字段（`ok`/`error`/`message`/`sideEffect`/`elapsedMs`）与日志模板串，已由上方整段说明覆盖，不重复写。
- 7 类判定点：`handleDialog` 成功才清 `pendingDialogs`（失败留给 detach/closeTab 按 INV-28）；`screenshotCommand` 一次性定性供三处共用（否则某路径绕过并发闸门叠 CDP）；`isInFlightScreenshotAlive` 只认未 abort 的在跑请求（死槽位会秒拒到 tab 关闭）；abandoned 计数只对截图读；截图独立 surface 分支与普通命令最终都过 `raceBackendExecution`；只给截图登记 tracker（否则 `captureActive` 虚高拖住回收）；第二道 race 覆盖「结果已产生、请求恰被 abort」的窗口。
- **新缺陷 D-9-6**（低 / B 档）：`isTabCaptureActive`（`:4944-4952`）只读 `inFlightScreenshots`/录制/`isBeingCaptured()`，未读 `abandonedScreenshotCaptures`。截图被 abort 或 hidden-deadline 先结算后 tracker 已删、底层 CDP capture 仍 pending，`captureActive` 报 false，`isBrowserTabResidencyProtected` 不再保护该 tab，tab 达上限时可被 LRU 回收，pending 命令在销毁的 webContents 上失败。与 `:4942-4944` 注释承诺相反。
- 未立条的时序点：`readTabViewport` 在进入 viewport 临界区前取值，理论上排队期间 resize 会让 prepare 载荷过期、ready 被 `sameBrowserScreenshotViewport` 拒绝而 35s 超时；触发需精确并发、后果只是该次截图失败，按「不收录纯竞态」门槛只留在既有注释，不记册。
- 指标：本片 +13 行（comments 1449 → 1462）；文件累计 16.9%（+7 单元，分支 19.0%、字段 6.3%）；逻辑区 20.8%；声明区 7.8%。六件套全 0，第七件 0 对。`zc-gate` 首遍 2 行 water（`:2105`/`:2197` 列举式）改写后归零。

**片 7（截图执行体 / presentation / abandoned capture，2247–2576，125 单元）**：

- 两个数：`uncoveredUnits=125` → 110；真正空白 31。余下是返回信封/错误对象字段与日志模板串，已被整段说明覆盖。
- 10 类判定点：`readTabViewport` 在临界区前取值的 TOCTOU（**不立条**：触发需精确并发、后果仅该次失败、无状态损坏）、prepare 后四联守卫（aborted/换代/已销毁/lease 指向别的 webContents）、surface 失效在 capture 前后各判一次、`captureViewportScreenshot` 惰性闭包、`!result` 兜底、截图 catch 报 `sideEffect:none`（只读命令）、`settleScreenshotCapture` 的 settled 幂等、先挂 abort 监听再查 `aborted`、rejection 分支也 finish、deadline 只在隐藏窗口传。
- **D-9-6 代码侧指路**：按用户要求在三处各加「保护链在此断开，见 D-9-6」——写点 `abandonBackendCapture` 的 `set`、并发闸门读点 `executeInScope` 的 `abandonedCaptures`、保护判定缺口点 `isTabCaptureActive`；`isTabCaptureActive` 上方意图句原文不动，继续作为水位。
- 指标：本片 +34 行（comments 1462 → 1496）；文件累计 17.5%（+15 单元，分支 19.7%、字段 6.3%）；逻辑区 21.6%；声明区 8.0%。六件套全 0，第七件 0 对。`zc-gate` 三轮 water（4→2→1）逐行补因果连词后归零。

**片 8（录制生命周期，原表 2401–3001 / 330 单元）**：

- 两个数：`uncoveredUnits=329` → 真正空白 216；余 113 是块注释摊薄的单条语句、返回信封字段与日志参数，按判据属「写了没贴住」，不重复写。按用户裁量预切 8a（入口/生命周期）/ 8b（动作分发/动画），一次落盘。
- 10 类判定点：`createRecordingEntry` 的 `context` 必须整体快照（换主后 `sameScope` 失效）、`setRecordingTerminal` 的幂等守卫实际在调用方（**不立条**：当前无实际竞态，INV-25 守卫分两处，已在注释写明新增调用点必须先判 `running`）、`abortRecordings` 必须先 abort 再写终态、`maxDurationMs` 起算点不含 prepare（prepare 由 `activityTimeoutMs = max+30s` 兜）、`assertCurrentGuest` 先判 `detaching`、`onCaptureComplete` 清表后编码阶段无超时兜底（**不立条**：有意换取「不误杀成片」，兜底只有调用方 cancel）、finally 四步顺序（停表→摘光标→还原 viewport→释放 surface）、`restoreRecordingViewport` 的 `closed` 早退与 `previous` 走 `reset`、`cancelled`/`timeout` 必须分流到不同终态、指针/滚动动画 60 帧封顶的理由。
- **新缺陷两枚**：`D-9-7`（光标 overlay 只在录制开始注入一次，导航后不重注入；注入无 catch，失败会把整段录制判 `failed`，与上方「每次动作前确保存在 / 只 warn」正相反）、`D-9-8`（`abortRecordings` 上方两条取消理由均不成立：状态由自身同步写定，半成品被 `recordBrowserVideo` 主动删除）。两处均按「注释原文留作水位 + 代码原地挂编号」处理，未改意图句；`D-9-2` 增补 `resolveRecordingSelectorScrollTarget` 落点（同一「注释称不能抛错、实现直接 throw」形态），不另立 ID。
- 指标：本片 +59 行（comments 1496 → 1555）；文件累计 17.7%（+7 单元，分支 20.1%、字段 6.3%）；逻辑区 21.7%；声明区 8.5%。六件套全 0，第七件 0 对。`zc-gate` 三轮 water（10→1→0）：列举式改写为带「必须 / 否则 / 因此 / 会」的句子，未删任何既有注释，第三轮仅剩一行缺谓词，补主语后归零。

**片 9（tab registry：resolve / create / claim / select / release，原表 3002–3321 / 127 单元）**：

- 两个数：`uncoveredUnits=127` → 真正空白 42；余 85 是既有块注释摊薄的返回字段与单条语句，不重复写。
- 11 类判定点：`resolveTab` 显式分支不能回退 active（授权边界）、索引读取要重校验但不顺手清理、回退顺序 active → default → recent、`createTab` 的 legacy id 复用与墓碑不清（D-9-9）、`ensureGuest` 先同步 detach 再建 flight、`waitForGuestRecovery` 必须比对 guest identity、`runGuestAttachFlight` 只在「曾 attach / 已知失败」时重放、`canClaimUserTab` 用 `ownedBySession` 而非 `sameScope`、`openUserTabs` 的排序只按 active 分组、`selectTab` 未选中候选也要上报 false 且自身不校验调用方、`releaseToUser` 的三处状态复位。
- **新缺陷两枚**：`D-9-9`（legacy 用 `sessionId` 作 tabId，关闭后重建复用同一 id，被 `closedTabIds` 永久拒绝 attach，该 scope 之后所有命令都失败）、`D-9-10`（`releaseToUser` 注释称清后台 viewport，实现只改归属；复位依赖 INV-22 的惰性自愈，未触发窗口内页面停在后台尺寸）。D-9-9 在读点 / 写点 / 缺口点三处挂编号；D-9-10 只在缺口点挂。`openUserTabs` 的「按 openedAt 排序」实为按 active 分组 + 稳定排序，已在注释写明，不占编号。
- 指标：本片 +36 行（comments 1555 → 1591）；文件累计 18.2%（+12 单元，分支 20.1%、字段 6.3%）；逻辑区 22.6%；声明区 8.1%。六件套全 0，第七件 0 对。`zc-gate` 两轮 water（2→0）。

**片 10（归属 / 请求生命周期 / closeSession / closeWindow / closeTab，原表 3322–3796 / 164 单元）**：

- 两个数：`uncoveredUnits=164` → 真正空白 61；余 103 是既有块注释摊薄的返回信封字段与单条语句。
- 10 类判定点：`summary` 的 active 用索引现算、lifecycle 只暴露 deliverable/handoff、`withMeta` 的 `openTabIds` 现算且 URL 必须脱敏、`cancelledOrUnavailable` 先判 aborted、`cancelledResult` 不用 `_context`、`releaseGuestCdpAfterIdle` 先比 identity 再比 lifecycle、`closeSession` 按 scopeKey 兜底清索引、`closeSessionTabs` 的 allSettled 承诺与实现不符（D-9-11）、`closeWindow` 清理不完整（D-9-12）、`closeTabDurably` 刻意与 `closeTab` 反序。
- **新缺陷两枚**：`D-9-11`（逐条 await 取代 allSettled，一次 `removeTabRecovery` 抛错让后续 tab 全部留在 registry）、`D-9-12`（`closeWindow` 漏清 active/default 与 `sessionNames`/`visibilityByScope`，windowId 复用时继承上一轮可见性）。两处均挂代码指路，意图句原文保留。
- 指标：本片 +17 行（comments 1591 → 1608）；文件累计 18.3%（+2 单元，分支 20.1%、字段 6.3%）；逻辑区 22.7%；声明区 8.1%。六件套全 0，第七件 0 对。`zc-gate` 一轮 water（1→0）。

**片 11（崩溃守卫 / dialog / download / viewport 串行，原表 3797–4211 / 167 单元）**：

- 两个数：`uncoveredUnits=167` → 真正空白 44；余 123 是既有块注释摊薄的字段与单条语句。本片是 P2 批次已写过的密集段，只补「身份比较」与「顺序」两类缺口。
- 10 类判定点：`setupCdpCrashGuard` 入口先 cleanup、`onRenderProcessGone` 身份匹配才改 detaching、`Page.enable` 失败不阻断 attach、dialog `onMessage` 必须比 `current.guest`、`setTabViewport` 先清 fallback、`applyBackgroundViewportFallback` 用引用比对、`restoreNaturalViewportAfterBackground` 每个 await 后重校验、`enqueueViewportMutation` 清空前比 identity（INV-21）、download 监听同时比 `contents` 与 `tab.guest`、`waitForDownload` 先消费队列再挂 waiter。
- **本片无新缺陷**：`waitForDownload` 在 will-download 时返回 id、`path` 可能为 null 是接口层已声明的契约（由 `done` 回填），不按缺陷记。
- 指标：本片 +20 行（comments 1608 → 1628）；文件累计 18.6%（+9 单元，分支 21.1%、字段 6.3%）；逻辑区 23.2%；声明区 8.1%。六件套全 0，第七件 0 对。`zc-gate` 首遍即 0 water。

**片 12（CDP 恢复回滚 / `toControlledView` / residency 注册 / 持久化，原表 4212–4693 / 251 单元）**：

- 两个数：原表 251 单元，开写前未覆盖 218；真正空白 97，余 121 是既有块注释摊薄的载荷字段、日志模板串与单条语句，不重复写。
- 9 类判定点：`cdpAttached` 必须回读 `isAttached()`（attach 静默失败会让 teardown 对不存在会话 detach）、`replayViewport` 入队后重比 guest/lifecycle、`rollbackGuestCdpRestore` 的「只清本次写入」与无条件 detach 的边界、zoom 复位只在主会话且未换代时做、`sendGuestCdpCommand` 先 `assertCurrentGuest` 再比 lifecycle（否则只剩笼统 detaching）、`executeJavaScript` 固定 `userGesture=true`、`registerTabResidency` 的 `lastActivityAt` 取 `openedAt`（否则 LRU 永远挑不到恢复的 tab）、`closeTabForLimit` 过期记录返回 true（否则新建被永久卡死）、`restoreSuspendedGuest` 的取消只返回 null 不回滚 coordinator。
- 本片无新缺陷；`rollbackGuestCdpRestore` 与实现字面不一致但按门槛不立条（触发需已 attach 入口复用、后果仅该次会话重建、无状态损坏），理由写进 `:4528-4534` 注释。
- 指标：本片 +22 行（comments 1628 → 1650，`addedCommentLines` 179 → 201）；文件累计 18.8%（+5 单元，分支 21.6%、字段 6.3%）；逻辑区 23.4%；声明区 8.2%。六件套全 0，第七件 0 对。`zc-gate` 首遍即 0 water。

**片 13（runtime protection / rebind / teardown 前置，68 单元）**：

- 片界：`persistShell` → `detachGuestBeforeReplacement`，含 `requireRendererOwnedTab`、`setupActivityTracking`、`refreshRuntimeProtection`、`hasRunningRequestForTab`、`isTabCaptureActive`、`hasPendingDownloadForTab`、`detachAndCloseGuest`、`rejectGuestAttach`、`requestGuestRebind`、`closeGuestWebContents`、`detach`。
- 12 类判定点：`windowBindingId` 固定 null、`viewport` 只落显式 override、`skipRemoteSession` 只给关闭收敛路径、`onLoadingStopped` 恢复期不回写缓存（INV-18）、`onAudioChanged` 不写 tab 字段故不比对身份、`hasRunningRequestForTab` 补 D-9-1 指路、`detachAndCloseGuest` 先存 guest 引用、`rejectGuestAttach` 只在未被收养时关、`attachFailure` 必须在早退前写、`closeGuestWebContents` 不等 beforeunload、`detach` 同步收口无插入窗口且未知 key 静默返回、`detachGuestBeforeReplacement` 未知 tab 返回 true。
- 本片无新缺陷；D-9-1 由「册子里的条目」变成代码内可当场看到的指路。
- 指标：本片 +20 行（comments 1650 → 1670，`addedCommentLines` 201 → 221）；文件累计 19.1%（+7 单元，分支 22.3%、字段 6.3%）；逻辑区 23.7%；声明区 8.3%。六件套全 0，第七件 0 对。`zc-gate` 首遍 2 行 water，改写后 0。

**片 14（teardown / detach / `disposeAll` / waiter 与尾部 helper，163 单元）**：

- 片界：`beginGuestTeardown` → 文件尾，含 `runGuestTeardown`、`waitForGuestCdpIdle`、`detachGuest`、`disposeAll`、`linkAbortSignal`/`waitForPromiseWithSignal`/`waitForDelay`/`waitForCondition`、`raceBackendExecution`、viewport/dialog/URL 工具函数。
- 15 类判定点：注销函数与已 abort 同步转抛、三态取消返回、abort 必清 timer、timeout/cancelled 分开报、Error reason 原样透传、`raceBackendExecution` 入口先判 aborted 与防御分支说明、形状/范围两段校验、坐标允许负数小数、`AbortError` name 契约、后台尺寸夹取、playwright 截图入口不漏、`safeStr`/`safeBool` 的 try 与 fallback 语义、未知 dialog 按 alert、URL 根路径去尾斜杠、`collectMemoryDiagnostics` 挂 D-9-13 指路。
- 本片新增 `D-9-13`（诊断注释称四类计数、实现只回两项，C 档 / 低）；`raceBackendExecution` 拒绝分支缺 `sideEffect` 属防御路径，按门槛不立条，理由写进注释。
- 指标：本片 +39 行（comments 1670 → 1709，`addedCommentLines` 221 → 260）；文件累计 19.7%（+16 单元，分支 22.3%、字段 6.3%）；逻辑区 24.5%；声明区 8.5%。六件套全 0，第七件 0 对。`zc-gate` 首遍 2 行 water，改写后 0。

**全 14 片收口**：文件累计 19.7% / 逻辑区 24.5% / 声明区 8.5%；新增注释行 260（相对新 HEAD），六件套 + 第七件全部 0 违规；缺陷册新增 D-9-7~D-9-13（7 条），每条的代码侧均已挂指路或保持原注释为水位。

**A 轮（unit-driven，达标线逻辑区 60%）**：片 1–14 是「按判定点扫」，停在 24.5% 属于方法上限，不是收口。A 轮改为按未覆盖单元分块补，块级清单与预计行数见批次文档 §7；声明区 724 个未覆盖单元按片 1–2 的六条判据处理，不追覆盖率。每批独立跑六件套 + 第七件 + `zc-gate`，一批一提交。

**A1（命令派发：`executeInScope` / `execute` / `raceBackendExecution`，201 逻辑单元）**：

- 新增 177 行；逻辑区 450 → 624（34.0%，+174）；全文件 517 → 694（26.4%）；声明区 67 → 70。
- 判定点集中在：`linkAbortSignal` 注销必须在 `finally` 首位、`running.tabId` 早于 `ensureGuest` 回填、`activateTab` 先查 `tabs` 再恢复且拒 `closed`、`claimTab` 校验早于整体替换 owner、`finalizeTabs` 先收集全部 `unknown`、`newTab` 失败先算取消原因再 `closeTabDurably`、download `null` 按 signal 区分取消/超时、`handleDialog` 的 `try` 只包断言、截图闸门只认 alive tracker、`raceBackendExecution` 的 settle 顺序。
- 落盘后自检返工：删 9 行与既有块注释重复的注释（超出 `commentAbove` 2 行窗口的摊薄）；改 3 处「失败分支不回 tab」的事实错误（`withMeta` 收到 `tab` 就会回 `meta.tabId`）；改 2 处职责误述（`handleDialog` 的 `try` 范围、`sendGuestCdpCommand` 不校验 scope）。
- 门禁：六件套全 0（`codeTokenDiff=0`、`deletedNonZero=0`、`nonCommentAdded=0`），第七件 0 对；`zc-gate` 首遍 4 行 water（多逗号列举），改写后 0。
- 本批无新缺陷。

**A2（录制：`executeRecordingAction` / `runRecording` / `installRecordingCursorOverlay`，129 逻辑单元）**：

- 新增 70 行；逻辑区 624 → 687（37.4%，+63）；全文件 694 → 761（29.0%）；声明区 70 → 74。
- 计划与实际差 66 个逻辑单元，三类均有账：25 个在 `installRecordingCursorOverlay` 的 `executeJavaScript` 模板字符串内（加注释会改页面脚本，`check-comments-in-strings` 必拒，属结构性不可注）；约 26 个由 `runRecording` 九处既有块注释覆盖（再写即重复，按 A1 返工口径不补）；约 15 个是动作对象字面量与参数行。
- 判定点：`runRecording` 四个默认值必须各自兜底（统一兜底会把显式 fps=0 改成 25）、`lease`/`timeout` 必须在 `try` 外声明否则 `finally` 看不到、coordinator 缺失必须显式失败、租约 `webContentsId` 必须等于当前 guest、prepare 后立刻读 `invalidated`、`generation`/`detaching` 三者都要判；`executeRecordingAction` 的 locator 与坐标分流、`doubleClick` 必须映射 `dblclick`、`hover` 用 `typeof` 判 0、`scrollTo` 传差值、`drag` 的 `buttons:1` 贯穿移动段。
- 门禁：六件套全 0，第七件 0 对；`zc-gate` 首遍 6 行 water（默认值/fill/timeout/scroll/拖拽间隔的列举式），改写后 0。
- 本批无新缺陷。

**A3（attach 与恢复：`attachGuest` / `runRestoreSuspendedGuest` / `restoreGuestState` / `setupActivityTracking`，142 逻辑单元）**：

- 新增 141 行；逻辑区 687 → 826（45.0%，+139）；全文件 761 → 901（34.3%）；声明区 74 → 75。差 3 个单元是注释落在已覆盖单元或声明单元上的重叠，不另补。
- 这批没有 A2 那样的结构性不可注块：四个函数内无模板字符串代码，参数行与返回信封的既有块注释也都能换角度写（顺序约束 / 失败后果 / 身份比对），因此接近 1:1。
- 判定点：`fromId` 只按 id 取对象不校验归属（D-16-1 起点）、`recoveryRequested` 只对未关闭 tab 生效、新建 tab 的 `registerTabResidency` 不能与 `tabs.set` 让出、二次 `closed` 检查覆盖并发关闭、`remoteSessionId` 空串也参与比对、挂起/代际两条拒绝分支都必须销毁 incoming、`shouldRestoreAfterRebind` 三条件、`debugger.attach` 以 `isAttached()` 回读、`guestGeneration` 只对换代 +1、claimable tab 必须显式置 active、显式失焦要同报 `selected/visible=false`、恢复 flight 按 promise identity 删除；恢复侧 `before` 必须早取、`failRestore` 两处都推进 generation、孤儿关闭顺序、`ERR_ABORTED` 以实际历史判定、空 `entries` 等同无快照；activity 侧五个回调的身份守卫、`onLoadingStopped` 的恢复期闸门、`activityCleanup` 逐个按引用解绑。
- 门禁：六件套全 0（`codeTokenDiff=0`、`deletedNonZero=0`、`nonCommentAdded=0`、`added=1721`），第七件 0 对；`zc-gate` 首遍 1 行 water（`fromId` 句多分隔符无谓词），改写后 0。
- 本批无新缺陷。

**A4（截图与销毁：`constructor` / `ensureGuest` / `setupDownloadTracking` / `executeScreenshotWithPreparedSurface` / `settleScreenshotCapture` / `runGuestTeardown` / `detachGuest` / `disposeAll`，186 逻辑单元）**：

- 新增 186 行；逻辑区 826 → 1010（55.0%，+184）；全文件 901 → 1085（41.3%）；声明区 75 未变。差 2 个单元是注释落在已覆盖单元上的重叠。
- 判定点：constructor 回调只通知不执行关闭、`onViewportChanged` 的 null 哨兵、`onEvict` 直绑 `closeTabForLimit`、`ensureGuest` 的 flight 复用与 identity 清理、`will-download` 的 contents 比对与 FIFO waiter、截图四条件闸门与像素归一化、`settled`/`finish` 的幂等与记账、隐藏窗口 deadline、teardown 的 `detaching` 顺序与二次 `isAttached` 判负、失败只回滚未销毁 guest、`detachGuest` 的 INV-18 闸门与清理顺序、`disposeAll` 的索引/waiter/flight 收口。
- 返工：`zc-gate` 首遍 12 行 water（L 8 / W 4），逐条改写后归零；另修正 1 处插入位置——`detachGuest` 的日志注释被插进模板字符串 `${}` 内，已移到 `this.log?.(` 之上。
- 门禁：六件套全 0（`added=1907`），第七件 0 对，`zc-gate` 0。
- 本批无新缺陷。
- A 轮收口：A1–A4 共 574 行，逻辑区 450 → 1010（55.0%），未到 60%（差 91 个单元）。缺口主要来自 A2 的 66 个结构性/既有注释不可注单元（25 个在注入脚本字符串内）；补足需另开 A5，候选块为 `executeRecordingAction`（30）、`executeInScope`（19）、`closeTab`（17）、`runGuestCdpSessionRestore`（17）、`moveRecordingPointer`（16）、`detachGuestBeforeReplacement`（16）。

**A5（中长尾 6 块：`executeRecordingAction` / `executeInScope` / `closeTab` / `runGuestCdpSessionRestore` / `moveRecordingPointer` / `detachGuestBeforeReplacement`，115 逻辑单元）**：

- 新增 115 行，115 个候选单元 1:1 落位；逻辑区 1010 → 1125（**61.3%**）；全文件 1085 → 1200（45.7%）；声明区 75 未变。
- 判定点：录制动作的 locator 三态（click/dblclick、fill、waitFor）、locator 优先于坐标、timeout 抛普通 Error 而取消抛 `abortError`、pointer 在坐标 click 与 drag 终点同步、插值 steps 钳 1..60、每帧判 abort；`executeInScope` 的超时靠 `signal.reason.name`、`pendingDialogs` 只在 ok 时删、截图 tracker 按 identity 删；`closeTab` 先置终态后清资源、下载 waiter 用 while 重读队首、三个 scope 索引按值比对；CDP 重放先 `Page.enable`、viewport 入队避免自等死锁；`detachGuestBeforeReplacement` 的 `windowId` + `guest.id` 双校验与 `destroyed-with-cdp` 拒绝。
- 门禁：六件套全 0（`added=2022`），第七件 0 对；`zc-gate` 首遍 3 行 water（`:3275` / `:3563` / `:4979`），改写后 0。
- 本批无新缺陷。A 轮至此 689 行（177+70+141+186+115），逻辑区 61.3%；剩余 710 个逻辑单元转分层抽样判定，见批次文档 §8。

**抽样收尾（2026-11-10）**：按 `_blocks2.mjs` 口径剩余 **624** 个逻辑单元（`_region-split` 的 710 与它的 86 差额全在对象字面量属性归属），按块规模比例抽 60 条：真缺口 **1 / 60 = 1.7%**（唯一 `:4018` 删 `defaultTabByScope`，同型 `:4015`），结构行 6 条（`:3616` / `:3631` 在注入脚本字符串内，4 条为参数行）。

**补缺口与第二轮（2026-11-10）**：`:4015` / `:4018` 已补注释（`cce264eb`，2 行），逻辑区 **61.4%**。第二轮从剩余 622 个可注单元里剔除首轮 59 条、按块配比重抽 60 条：真缺口 **0 / 60**，结构行 7（3 条注入脚本、4 条参数行），已覆盖 53。两轮合计 **1 / 120 = 0.8%**（1 例已闭合），95% 上界约 **4.3%**，按预登记规则 ≤3/120 **定格 61.4%**；表述为「120 条分层抽样、累计 1 例，上界约 4.3%」，不是「做完了」。

**分母口径（权威指定）**：覆盖率与「逻辑区 X%」的权威分母是 `_region-split` 的 **708**（总逻辑区 1835）；`_blocks2` 的 **622** 是「可注单元」口径，差额 **86 个对象字面量属性**按规范豁免、不进缺口率分子。**覆盖率只除 1835，缺口率只除 622**，同时引用必须写明 708 = 622 + 86。详见批次文档 §8.1 / §9。













