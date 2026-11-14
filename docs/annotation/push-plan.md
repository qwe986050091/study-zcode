# push-plan：注解分支的远端备份方案（仅准备，**未执行**）

> 状态：**未推送**。本文件只是把「真要备份时怎么做」写成可复核的一页；任何实际 `git push`
> 都要等确认后再单独执行。
> 生成：2026-11-11 ｜ 本地 `main` @ `1542b6e0` ｜ 上游 `origin/main` @ `a9fe401e`

## 1. 风险背景

- `origin` 存在（`https://github.com/zai-org/ZCode.git`），但本线 257 个注解提交只在本地。
- 这是当前最大的单点风险：本地磁盘一坏，全部 1→1 改写与台账无法从上游恢复（上游是 vendor sync，不含量注解）。
- 推送属于对外动作，**不代为决定**；本文件只做准备。

## 2. 建议推送参数

```bash
git push origin HEAD:refs/heads/annot/zcode-deep
```

| 项 | 值 |
| --- | --- |
| 建议分支名 | `annot/zcode-deep`（不改 `main`、不改远端默认分支） |
| 推送范围 | `origin/main..HEAD`，即 257 个提交（`1542b6e0` 为头） |
| 预计对象数 | 7,840 |
| 预计体积 | ≈ 112.4 MB（本地 `pack-objects --stdout --revs` 实测压缩后大小） |
| 远端 | `https://github.com/zai-org/ZCode.git` |

复算命令（与本节同源，可逐条复核）：

```bash
git rev-list --count origin/main..HEAD                 # 257
git rev-list --objects origin/main..HEAD | wc -l       # 7,840
git rev-list origin/main..HEAD | git pack-objects --stdout --revs --quiet | wc -c   # 117,848,223
```

## 3. `git push --dry-run` 输出（2026-11-11 实测）

```text
$ git push --dry-run --porcelain origin HEAD:refs/heads/annot/zcode-deep
remote: Permission to zai-org/ZCode.git denied to qwe986050091.
fatal: unable to access 'https://github.com/zai-org/ZCode.git/': The requested URL returned error: 403
```

- **dry-run 未通过**：当前凭据（`qwe986050091`）对该仓库没有写权限，`403` 发生在鉴权阶段，
  没有创建任何远端引用。
- 因此真正推送前还差一步**授权决策**：换有写权限的账号/令牌，或推到自己的 fork。
  本计划不修改 remote、不切换凭据、不改默认分支。

### 3.1 阻塞原因与解锁条件（`BLOCKED`，不是待办）

**结论：当前不可执行。** `403 / Permission denied` 不是「暂不推」，而是**凭据对该远端没有写权限**；
计划本身、校验、对象与体积都已就绪，卡点全在权限侧。

| 项 | 内容 |
| --- | --- |
| 状态 | `BLOCKED`（外部条件未满足），**不计入待办** |
| 需要的权限 | `zai-org/ZCode` 的 write 权限；或对该仓库的 fork 有 write 权限（推 fork 即可） |
| 当前凭据 | `qwe986050091`（HTTPS） |
| 阻塞位置 | 鉴权阶段，未创建任何远端引用，本地仓库未改动 |

已验证的失败输出原文（2026-11-11，`--dry-run`，逐字）：

```text
$ git push --dry-run --porcelain origin HEAD:refs/heads/annot/zcode-deep
remote: Permission to zai-org/ZCode.git denied to qwe986050091.
fatal: unable to access 'https://github.com/zai-org/ZCode.git/': The requested URL returned error: 403
```

解锁后执行的命令（**唯一一条**，前提是先通过 §5 校验）：

```bash
git push origin HEAD:refs/heads/annot/zcode-deep
```

若改为推自有 fork，则把 `origin` 换成该 fork 的 URL，分支名与范围不变：

```bash
git push <fork-url> HEAD:refs/heads/annot/zcode-deep
```

解锁判据：同一命令加 `--dry-run` 后输出 `Everything up-to-date` 或不含 `Permission … denied` / `403`，
且打印出 `To <url>` 与 `* [new branch]` 计划行。在此之前不执行任何实际推送。

## 4. 三条硬约束

1. **不推 `main`**：只推 `annot/zcode-deep`；本地 `main` 与 `origin/main` 的分叉保持原样。
2. **不 force**：不带 `--force` / `--force-with-lease`；远端不存在同名分支时也只做普通创建。
3. **不改远端默认分支**：不动仓库设置，`HEAD` 指向关系保持上游原状。

## 5. 推送前置校验（必须相等）

```bash
git rev-list --count origin/main..1542b6e0   # 期望 257（快照记录的头）
```

与 `vendor-sync-divergence.md` §0 的 `commits_ahead = 257` 必须相等。校验基准是**快照记录的头**
`1542b6e0`，不是浮动 `HEAD`——快照之后再有台账/文档提交，`rev-list origin/main..HEAD` 会比 257 多出
这些文档提交（每条 +1），属预期，不代表分叉恶化。真要推送时以当时 `HEAD` 重算范围，并先更新快照。

## 6. 推送后要补的记录（预留，未执行）

- 远端分支名与首次推送的 commit sha；
- 推送时间与执行人；
- 同步更新 `vendor-sync-divergence.md` 的「最近复核」行（本地 + 远端各一份 sha）。
