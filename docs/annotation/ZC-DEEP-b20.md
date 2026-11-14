# ZC-DEEP B20 索引（core & apps）

日期：2026-11-07
基线快照：`d:\code\_annot_baseline\ZC-deep-b20\orig`
范围：`apps/zcode-cli` + `packages/{shared,ui,web}`（不含 `packages/services`）
装箱说明：本批 9 文件，超出常规 3~8，按 5+4 两段并行执行。

## 1. 批次数据

| 指标 | 值 |
| --- | --- |
| 文件数 | 9 |
| 计划缺口 | 1,921 |
| 实际新增注释行（`added`） | 2,251 |
| 最低密度 | 31.19%（`bots.ts`） |
| 最高密度 | 34.19%（`product-projection.ts`） |
| 校验 | `deletedNonZero=0` / `nonCommentAdded=0` / `starSlash=0` / `syntaxErrorFiles=0` |

累计：94 文件 / 37,348 行，相对基线 141,590 行完成度 26.4%，剩余缺口 104,242 行。

## 2. 文件清单（路径｜职责｜注释主题｜+行数）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/adapters/src/fs/index.ts` | CLI 文件系统适配器（读写、原子写、错误归一） | 公开方法入口必须经 `resolveAbsoluteRequestPath`；catch 统一经 `toFileSystemError`；`writeTextFile` 的 CAS 必须在 mkdir 与落盘之前；`atomicWrite` 先 `lstat` 拒绝符号链接 | +243 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` | v4 协议产物投影（live/cold 共用 reduce、索引、revision） | live 与 cold 共用同一次 reduce；行结构变化必须同一次 materialization 产出 row 与 actions/target；所有索引都是 snapshot 派生；revision 只在 `deltaBumpsRevision` 为真时 +1 并内联进最后一条 delta | +431 |
| `packages/shared/src/bots.ts` | Bot 配置 schema 与 provider 白名单 | botProviders 只增不删；所有 schema 保持 `.strict()`；`version` 与 `z.literal(3)` 必须同步；legacy schema 只做历史值归一、不做合法性拒绝 | +227 |
| `packages/ui/src/settings/PluginStorePage.tsx` | 插件商店页（安装/卸载、跨工作域去重） | 服务实例只从 `useServices/usePlatform` 获取；跨域去重键统一为 `workspaceIdentity?.trim() \|\| workspacePath`；initialize 必须带完整依赖数组；页面状态只来自 scoped store selector | +225 |
| `packages/web/src/share/ConversationShareLandingPage.tsx` | 分享落地页（loader 取预览、匿名态错误映射） | 只有 loader 调 `client.getPreview`；公开分享允许匿名首次请求；带 token 仍 `authentication_required` 时先 onLogout 再展示；匿名态 `not_found` 与 `authentication_required` 都转 `login_required` | +225 |
| `packages/ui/src/store/zcodeSessionStoreTaskSlice.ts` | 会话 store 的任务切片（usage/runtime/contextWindow/权限） | usage 五子树等价必须返回原 state；终态清空 `activeInputId` 与 `activeTurnKind`；写 contextWindow 不得重建 usage 对象；权限请求按 requestId 去重 | +222 |
| `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx` | 内联可编辑 Provider 卡的草稿与保存 | 保存成功仅在 revision 未变时展示；删除进行中不得补保存草稿；内部保存触发的卸载跳过 cleanup；每次草稿修改递增 revision | +221 |
| `packages/ui/src/RemoteConnectionDialogContent.tsx` | 远程连接对话框（介绍确认、边界确认） | 介绍状态读写失败不得伪装成连接失败；全局确认框被占用必须走 onBlocked；版本 1 直接放行；每次 await 后复核 isCurrent | +222 |
| `packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts` | 工作区配置快照（configOptions 归一） | thought_level 空值回落首个选项；只归一 select 类型；所有写入先过 `normalizeConfigOptions`；克隆必须深拷贝 options | +235 |

## 3. 本批发现的关键不变量

- **FS 适配器**：`writeTextFile` 的 CAS 必须在 mkdir 之前执行；顺序颠倒后即使检测到版本冲突，目录已被创建，留下空目录副作用。
- **产物投影**：live 与 cold 必须共用同一次 reduce；在 hydration 里另写规则会让冷启动与实时增量产出不同的行结构。
- **Bot schema**：`version` 与 `z.literal(3)` 必须同步，只改一处会让所有旧配置文件解析失败。
- **插件商店**：跨域去重键必须统一为 `workspaceIdentity?.trim() || workspacePath`，两处写法不一致会导致同一插件出现两条。
- **分享落地页**：匿名态 `not_found` 与 `authentication_required` 都映射为 `login_required`，否则未登录用户会看到「链接已删除」。
- **任务切片**：等价时必须返回原 state，流式重复事件才不会唤醒全部订阅者。
- **Provider 卡**：删除进行中不得补保存草稿，否则已删除的 Provider 会被 save 重新创建。
- **工作区切片**：所有 configOptions 写入必须先归一，未归一值进入快照会让工具栏 Select 进入空选中态。

## 4. 故障模式（改错会出现什么）

| 错误改法 | 现象 |
| --- | --- |
| `atomicWrite` 省略 lstat 预检 | 顺着符号链接写到工作区外任意目标 |
| hydration 分支自写行结构规则 | 冷启动与实时增量的消息行不一致，刷新后错位 |
| Bot schema 放松 `.strict()` | 配置里留下无人读取的字段，升级后静默丢失 |
| 插件去重键两种写法混用 | 同一插件在列表出现两次，安装状态互相矛盾 |
| 匿名态 `not_found` 直出 | 未登录用户看到「分享已删除」而不是登录引导 |
| usage 等价时不返回原 state | 每个流式 token 唤醒全部订阅者，长会话掉帧 |
| 删除中仍保存草稿 | 已删除 Provider 被复活 |
| configOptions 未归一写入 | 工具栏档位 Select 空白，用户以为模型不支持档位 |

## 5. 阻塞与需要决定的事项

- 无阻塞。
- `product-projection.ts` 34.19%、`zcodeSessionStoreWorkspaceSlice.ts` 33.10%，略高于 31%~32.5% 的软目标区间，
  但仍满足 ≥30% 硬线；受「只增不删」约束未回调。
- 累计第 4 批提出：超密文件（B17 `V4ComposerToolbar.tsx` 42.48%、B18 `remoteAssetInstaller.ts` 36.07%）
  是否统一瘦身，仍待用户确认。

## 6. 校验输出

```
deep-density (9 files, mode=code)
31.39  adapters/src/fs/index.ts
34.19  product-projection.ts
31.19  bots.ts
31.30  PluginStorePage.tsx
31.66  ConversationShareLandingPage.tsx
31.40  zcodeSessionStoreTaskSlice.ts
31.42  InlineEditableProviderCard.tsx
31.79  RemoteConnectionDialogContent.tsx
33.10  zcodeSessionStoreWorkspaceSlice.ts

zc-verify ZC-deep-b20
deletedNonZero=0  nonCommentAdded=0  starSlash=0  syntaxErrorFiles=0  added=2251
```
