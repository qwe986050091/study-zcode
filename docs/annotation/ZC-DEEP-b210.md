# ZC-DEEP-B210（4 文件，+120 行）

> 范围：轨迹查找条、首页主题 Hero 调色板、保留中的远程项目连接、项目侧边栏新增入口（合计 398 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b210\orig`；清单：`ZC-deep-b210-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.91%。

## 1. 验收输出

```text
[ok] packages/ui/src/ModelTrajectorySearchBar.tsx: 15 blocks, 30 lines
[ok] packages/ui/src/openWorkspacePageThemeHero.tsx: 15 blocks, 30 lines
[ok] packages/ui/src/project-sidebar/remote-project-connection.ts: 15 blocks, 30 lines
[ok] packages/ui/src/project-sidebar/RemoteProjectMenu.tsx: 15 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/ui/src/ModelTrajectorySearchBar.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/openWorkspacePageThemeHero.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/project-sidebar/remote-project-connection.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/project-sidebar/RemoteProjectMenu.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=96 comment=30 packages/ui/src/openWorkspacePageThemeHero.tsx
31.58% code=114 comment=36 packages/ui/src/project-sidebar/remote-project-connection.ts
31.91% code=94 comment=30 packages/ui/src/ModelTrajectorySearchBar.tsx
31.91% code=94 comment=30 packages/ui/src/project-sidebar/RemoteProjectMenu.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/ModelTrajectorySearchBar.tsx` | 轨迹查找条 | 挂载即聚焦并全选、空匹配禁用跳转、Esc/Enter 方向语义、计数三元、三按钮文案与可用性差异 | 30 |
| `ui/src/openWorkspacePageThemeHero.tsx` | 首页 Hero 配色 | 四主题穷举映射、system 解析、panel 与两团光晕、装饰层不拦截点击、外部类名追加 | 30 |
| `ui/src/project-sidebar/remote-project-connection.ts` | 保留连接解析 | 最近目录唯一定位、roots 与 legacyWorkspace 双读、Direct Server 提前返回、两次 stillRetained 复验 | 30 |
| `ui/src/project-sidebar/RemoteProjectMenu.tsx` | 侧边栏新增入口 | 远程子菜单可选、逐设备展示态、连接中禁用、profile 优先、分隔线条件、新建不带偏好 | 30 |

## 3. 说明

- `ModelTrajectorySearchBar.tsx` 原 0.00%，块锚定 ref 与挂载副作用、disabled 判定、data 属性、受控 value、两处键盘分支、占位文案与三个按钮；
  重点标注「关闭按钮不受匹配数影响」，避免把可访问性修复误删成「统一 disabled」。
- `openWorkspacePageThemeHero.tsx` 原 0.00%，块锚定调色板接口、映射函数、四个 case、system 解析、palette 取用、panel 拼接与两团光晕、children 三元；
  `default:` 与 `case "system":` 相邻，只对 `case "system":` 单点锚定，兜底注释落在 `default:` 上。
- `remote-project-connection.ts` 原 5.26%（文件内已有 6 行主题注释），块锚定两个导出、候选过滤、唯一定位、路径反查、三要素抛错、Direct Server 分支、复验闭包与末尾复验；
  把「动副作用前先验成员仍在」与「打开向导前再验一次」写成两条独立不变量。
- `RemoteProjectMenu.tsx` 原 0.00%，块锚定两个可选 prop、菜单根、测试标识、本地入口、远程三元、设备 map、展示输入、禁用条件、profile 三元、状态图标、分隔线与新建项；
  `<DropdownMenu>` 与 `<DropdownMenuItem ...>` 的锚点必须带闭合尖括号，否则 trim 全等匹配为 0 命中（本批首次插入即因此失败，修正后重跑，未落盘）。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1882 needLines=26938 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1878 needLines=22346
```

累计 1,346 文件 / 126,007 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b210 | 提交 a8784b7e | numstat 113 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=30 / 113）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=113 waterLines=30 waterRate=26.55% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=113
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=179 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=6 missing=0
```

- 结论：**六件套未全通过**。waterLines=30 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
