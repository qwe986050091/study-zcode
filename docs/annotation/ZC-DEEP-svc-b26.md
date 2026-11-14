# SVC-B26 深度注释索引（收口批：barrel / 模块描述符 / 缓存索引）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的最后 10 个文件（第 256~265 个）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。
> 本批完成后 services 全部 467 个文件均达标：`coreBelow30=0`、`needLines=0`。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `gen-ui/node.ts` | 1 | 0 → 1 | 100.00% | 1 |
| `gen-ui/index.ts` | 2 | 0 → 1 | 50.00% | 1 |
| `hooks/index.ts` | 2 | 0 → 1 | 50.00% | 1 |
| `output-style/index.ts` | 2 | 0 → 1 | 50.00% | 1 |
| `task-facts/contract.example.ts` | 4 | 1 → 2 | 50.00% | 1 |
| `project-workspace-navigation/module.ts` | 6 | 1 → 2 | 33.33% | 1 |
| `runtime-tools/nodeEnv.ts` | 13 | 3 → 4 | 30.77% | 1 |
| `oauth/runtimeConfig.ts` | 24 | 7 → 8 | 33.33% | 1 |
| `client-scenes/clientScenes.ts` | 46 | 12 → 14 | 30.43% | 2 |
| `plugins/officialPluginCache.ts` | 50 | 13 → 16 | 32.00% | 3 |
| **合计** | **150** | — | — | **13** |

> `gen-ui/node.ts` 仅 1 行代码，1 行注释即 100%；这类 barrel 只写「唯一导出契约 + 导入零副作用」一句，不做无意义的凑行。

## 2. 分段

b26a（四个 barrel 与 task-facts 示例，各 +1）、b26b（导航模块描述符 / nodeEnv / oauth runtimeConfig 各 +1，clientScenes +2，officialPluginCache +3）。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b26
SUMMARY files=10 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=13
```

逐文件密度复测（`--only`，10 次全部 `PASS`）。

全 services 终态复测：

```text
SUMMARY files=467 coreBelow30=0 needLines=0 min=30.05 median=32.00 newComments=29676
```

## 4. 本批锚定的不变量

- `gen-ui/node.ts` / `gen-ui/index.ts` / `hooks/index.ts` / `output-style/index.ts`：barrel 只做 re-export，导入零副作用、不实例化。
- `task-facts/contract.example.ts`：示例不得在装配链路中被 import。
- `project-workspace-navigation/module.ts`：requires 必须与 architecture-policy 声明的依赖方向逐项一致。
- `runtime-tools/nodeEnv.ts`：只认显式注入的 ZCODE_RUNTIME_ENV，不回退 NODE_ENV。
- `oauth/runtimeConfig.ts`：appSecret 等凭据不得进入 renderer 可见返回值或整体序列化。
- `client-scenes/clientScenes.ts`：options key 必须与后端 namespace/scene 下的 option 标识逐字对应，新增字段保持可选。
- `plugins/officialPluginCache.ts`：默认启用集合必须与 bootstrap 侧定义逐项一致；版本目录按语义版本而非字典序比较。

## 5. 看似该改、其实不能改

- 四个 barrel 不能在此实例化：所有引用方都会被拖入初始化。
- `contract.example` 不能被 import：会把示例当实现。
- `module.ts` 不能多写/漏写 requires：架构检查与真实调用图会分叉。
- `nodeEnv` 不能回退 NODE_ENV：登录 shell 变量会让生产误开 debug 日志。
- `runtimeConfig` 不能整份序列化给 renderer：凭据直接外泄。
- `clientScenes` 不能把新增字段改成必填：旧客户端会整块渲染失败。
- `officialPluginCache` 不能改成字典序排序：1.10 会被误判早于 1.9。
