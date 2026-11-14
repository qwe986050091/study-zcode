# ZC-DEEP-b89

> 批次：B89（6 文件，按 31.4% 口径计算目标 320 行，实际 +320）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b89\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b89
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=320

node check-batch.mjs ZC-deep-b89 ZC-deep-b89-files.txt
TOTAL added=320 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.15  244  183  57  53  packages/ui/src/settings/model-provider-section/ProviderModelReasoningLevelEditor.tsx
31.28  290  211  66  53  packages/ui/src/settings/settingsPageConfig.ts
31.28  238  179  56  53  packages/shared/src/marketingTouch.ts
31.43  335  245  77  54  packages/ui/src/settings/WorkspaceFileSearchSection.tsx
31.44  275  194  61  53  packages/shared/src/streaming-tool-input-preview.ts
31.63  268  196  62  54  packages/shared/src/zcode-protocol-v4/wire-reassembly.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.15 median=31.36 newComments=320
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/settings/settingsPageConfig.ts` | 设置页分组与分区配置合成 | INV-01~18；基线不裁剪；平台与灰度双门禁；空组剔除；回退链三级 | 53 |
| `ui/src/settings/WorkspaceFileSearchSection.tsx` | `.zcodeignore` 编辑页 | INV-01~18；无 workspace 早退；版本防竞态；分区变换；模板态可保存 | 54 |
| `ui/src/settings/model-provider-section/ProviderModelReasoningLevelEditor.tsx` | 推理档位编辑器 | INV-01~18；空值与重名不落盘；原样失焦不覆盖；顺序即时提交；高度一致 | 53 |
| `shared/src/marketingTouch.ts` | 营销投放 schema 与响应解析 | INV-01~18；协议白名单；strict 分支；资源位判别同步；单条容错 | 53 |
| `shared/src/streaming-tool-input-preview.ts` | 流式工具输入半截预览 | INV-01~18；首块立即物化；文件类专用窗口；双门控；悬空转义清理 | 53 |
| `shared/src/zcode-protocol-v4/wire-reassembly.ts` | 协议物理分片重组 | INV-01~18；全链路校验；逐片计费；缺片可重试；严格 UTF-8 与信封复核 | 54 |

合计 **320**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 分区基线不能在定义里裁剪

`settingsPageConfig.ts` 的 `BASE_SETTINGS_SECTIONS` 保留全部条目，平台与灰度都在消费时过滤。
把 `isDesktop` 判断写进基线，会让 `createSettingsPageConfig` 的动态平台能力失效。

### 2. 保存门控必须承认模板态

`WorkspaceFileSearchSection.tsx` 在规则文件尚未创建时允许原样保存。
只按「内容有差异」门控，用户第一次进入页面就永远无法创建文件。

### 3. 原样失焦不等于用户覆盖

`ProviderModelReasoningLevelEditor.tsx` 对未改动的值直接取消编辑。
否则仅点开档位看一眼，就会把整组档位写成个人配置。

### 4. 投放判别值必须与内容字段同步

`marketingTouch.ts` 的 `resource_position` 判别值与 banner/popup 字段一一对应。
服务端改名后只改判别值，会让有效投放整条被判失败并计入拒绝数。

### 5. 文件类工具的节流窗口更宽

`streaming-tool-input-preview.ts` 为 write/edit 单独走一秒窗口。
沿用通用路径会让大参数每个 chunk 都触发全量恢复与行级 diff。

### 6. 装配上限要逐片计费

`wire-reassembly.ts` 每接纳一片就累加并检查上限，而不是收齐后再统计。
收齐后才检查，暂存内存会先被恶意分片撑爆。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 平台门禁写进基线 | Web 视图出现 Computer Use |
| 空分组不过滤 | 侧栏出现只有标题的分组 |
| 回退链缺末级兜底 | 空列表返回 undefined，页面空白 |
| 读取不加版本号 | 切换 workspace 后显示上一份规则 |
| 保存只按差异门控 | 首次进入无法创建规则文件 |
| 远程也展示打开位置 | 弹出本地文件管理器失败提示 |
| 档位不去重 | 两个同名档位无法区分 |
| 原样失焦也写回 | 仅查看就把档位写成个人配置 |
| 删除不设下限 | 档位可被删空 |
| 地址不校验协议 | javascript 协议被当作可打开链接 |
| 单条投放直接 parse | 一条坏数据导致整批失败 |
| 信封错误当成功 | 空结果掩盖服务端错误 |
| 后台模式也物化 | 非活跃任务争抢主线程 |
| 未闭合片段不裁转义 | 半截字符串解析必失败 |
| 完整帧绕过装配上限 | 单片大帧突破权威状态上限 |
| 分片数不设硬上限 | 恶意元数据制造千万级缺失下标 |
| 收齐后才统计字节 | 暂存内存先被撑爆 |
| 校验和早算 | 只覆盖部分字节仍判通过 |
| UTF-8 非严格解码 | 非法字节被替换字符掩盖 |

## 断点报告（续跑基线）

- 最后完成批次：**B89**（6 文件 / +320 行 / 全绿）；`added=320`、硬校验全 0。
- 累计（core+apps）：**806 文件 / 103,766 行**。
- 半插入残留：无（6 份 spec 均一次插入到目标行）。
- 剩余缺口：按基线推导 **2,418 个 coreBelow30 / 37,824 行**，完成度 **73.3%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.15%~31.63%，`suspicious=0`。
