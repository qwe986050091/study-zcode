# ZC-DEEP-B161（4 文件，+154 行）

> 范围：已保存工作流的基本信息表单与运行历史、Web 远程控制失败页、CLI 产物存储适配器（合计 856 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b161\orig`；清单：`ZC-deep-b161-files.txt`。
> 目标密度 31.4%，实际落点 31.09%~31.58%。

## 1. 验收输出

```text
[ok] packages/ui/src/settings/saved-workflows/SavedWorkflowMetaForm.tsx: 5 blocks, 38 lines
[ok] packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx: 5 blocks, 38 lines
[ok] packages/web/src/web-remote-control/ui/webRemoteControlFailureScreen.tsx: 4 blocks, 37 lines
[ok] apps/zcode-cli/packages/adapters/src/storage/index.ts: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=154
TOTAL added=154 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.58% code=133 comment=42 packages/ui/src/settings/saved-workflows/SavedWorkflowMetaForm.tsx
31.36% code=169 comment=53 packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx
31.09% code=119 comment=37 packages/web/src/web-remote-control/ui/webRemoteControlFailureScreen.tsx
31.49% code=435 comment=137 apps/zcode-cli/packages/adapters/src/storage/index.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowMetaForm.tsx` | 工作流详情页基本信息区（说明 / 何时使用 / 参数表） | 只渲染不持状态、脏态与保存禁用、必填错误路径、行错误按 key 索引 | 38 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx` | 运行 journal 历史列表 | 空态、状态徽标与配色分支、查看实例与产物两种入口门槛、老行缺键降级 | 38 |
| `packages/web/src/web-remote-control/ui/webRemoteControlFailureScreen.tsx` | 远程控制失败整页兜底 | 色调映射、文案解析来源、设备不属主时换账号分支、主次按钮可选性 | 37 |
| `apps/zcode-cli/packages/adapters/src/storage/index.ts` | 本地 FS 的工具产物存储与派生媒体物化 | 路径白名单、随机产物标识、文本/二进制分流、URI 定位、singleflight 与临时文件改名 | 41 |

## 3. 说明

- `SavedWorkflowMetaForm.tsx` 的注释只落在接口、函数签名与错误分支之前，未进入 JSX 属性列表。
- `SavedWorkflowRunHistoryPanel.tsx` 的入口门槛块锚定 `const openable =`，不改动三元表达式本身的结构。
- `webRemoteControlFailureScreen.tsx` 的第三块锚定 `const copy =` 语句层，未在 JSX children 内插入 `//` 行。
- `storage/index.ts` 首行是重复的分节线，文件头使用 `firstNth: 1` 定位；私有方法块均插在类体层。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2078 needLines=33207 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2074 needLines=28615
```

累计 1,150 文件 / 119,375 行。
