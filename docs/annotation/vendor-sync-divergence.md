# 本地 vs `origin/main`：注解分支分叉快照

> 用途：以后有人问「为什么不跟上游同步」，读这一份就够，不必重查。
> 生成：2026-11-11 ｜ 初版本地 `main` @ `df539966`（b274 台账补提交）｜ 上游 `origin/main` @ `a9fe401e`
> 最近复核：2026-11-11 ｜ 本地 `main` @ `1542b6e0`（b276 台账）｜ 见 §0
> 复跑：`node scripts/check-workspace-freshness.mjs`（会打印同样三项计数）

## 0. 当前复核快照（2026-11-11，b276 台账后）

```text
state            = diverged-expected
commits_ahead    = 257        ← 校验基准：git rev-list --count origin/main..1542b6e0 必须等于此值
commits_behind   = 2
merge_base       = 3c5b2276
上游最后 sync    = a9fe401ee（2026-11-03 17:30:55 +08:00）
上游触及文件数   = 5,315
上游净行数       = +226,212 / −613,001
```

与初版（`df539966`，ahead 251）相比，ahead 只增加本线提交（`f43c07b2`、`a417facb`、`3e82f2b6`、
`1ca9a75f`、`622952e8`、`1542b6e0`），`commits_behind` 与上游面未变。§1 保留初版口径。

## 1. 结论（初版，ahead 251）

```text
state            = diverged-expected
commits_ahead    = 251        （本地注解提交，origin/main 没有）
commits_behind   = 2          （origin/main 的 vendor sync，本地没有）
merge_base       = 3c5b2276
上游最后 sync    = a9fe401ee（2026-11-03 17:30:55 +08:00）
上游触及文件数   = 5,315
上游净行数       = +226,212 / −613,001
```

- 判定：**注解分支不跟 vendor sync 是长期例外**，`diverged-expected` 不是红灯。
- 本线只允许 `git commit`；**禁止** `merge` / `rebase` / `push --force`。
- 将来真要同步，先单独上报，并给出两个数：**注解提交数 251** 与 **上游触及文件数 5,315**；
  两数一旦倒挂（上游改动量 ≫ 注解量），任何自动合并都会静默吞掉注解。

## 2. 上游新增的两个提交

| sha | 时间（+08:00） | subject |
| --- | --- | --- |
| `a9fe401eede6` | 2026-11-03 17:30:55 | `chore: sync ZCode source v3.17.2` |
| `a60ba6a7e5a0` | 2026-10-30 11:47:07 | `chore: sync ZCode source` |

两条 subject 都匹配 `sync ZCode source`，因此 `check-workspace-freshness` 落
`diverged-expected`（判据：本分支注解提交数 > 0 且上游新增提交全部匹配该 subject）。

## 3. 复现命令

```bash
git fetch origin --prune

# 三态 + 三项计数（脚本自己打印，见 §1）
node scripts/check-workspace-freshness.mjs

# 分叉计数
git rev-list --count origin/main..HEAD     # commits_ahead
git rev-list --count HEAD..origin/main     # commits_behind
git merge-base HEAD origin/main

# 上游新增提交（sha / 时间 / subject）
git log --format='%H%x09%cI%x09%s' HEAD..origin/main

# 上游触及面
git diff --shortstat HEAD...origin/main
git diff --name-only HEAD...origin/main | wc -l
```

## 4. 为什么不能自动合并

1. 上游两个 sync 相对本分支**删除 613,001 行、新增 226,212 行**，覆盖 5,315 个文件；
   本分支的 251 个注解提交几乎全部落在这些文件里。
2. 本分支 `main` 与 `origin/main` 已分叉，`git merge --ff-only origin/main` 必然失败；
   真做 merge，冲突解决会把「注解改写」与「上游重写」混在同一次提交里，无法复核。
3. 因此：注解分支保持分叉，`diverged-expected` 由脚本豁免；同步是**独立决策**，不是开工前置。

## 5. 维护约定

- 每次 `origin/main` 新增 sync 提交，`commits_behind` 会变；`check-workspace-freshness` 每次开工都会打印
  最新三项计数，本文件的数字只在需要「可复核存档」时更新。
- 若 `origin/main` 出现**非** `sync ZCode source` 的提交，脚本落 `diverged-unexpected` 并逐条列出 subject，
  由人决断（那可能是真实代码变更，不再是单纯 vendor sync）。
