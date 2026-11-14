// Git checkpoint 的纯逻辑层：负责引用命名、git porcelain 解析、diff 合并与临时索引清理。
// 所有函数都不直接执行 git，只能把命令输出转成结构化结果，命令调用集中在 checkpoint 服务里。
// INV-gitcp#01：checkpoint 引用必须落在 refs/zcode/checkpoints/<workspaceHash>/ 下，
//   与用户分支、标签命名空间隔离（守住位置：getCheckpointRefName；破坏后会污染 git branch -a，且可能被 gc 误删）。
// INV-gitcp#02：同一 workspacePath + checkpointId 必须得到同一 ref 名（守住位置：getWorkspaceHash）；
//   破坏后重复快照会写出两个引用，列表出现幽灵项且清理时漏删。
// INV-gitcp#03：解析 git -z 输出时记录以 NUL 分隔、路径不做引号反转义（守住位置：parseNameStatus / parseNumstat / parseLsTree）。
// INV-gitcp#04：临时索引只通过 GIT_INDEX_FILE 指向，绝不触碰真实 index（守住位置：buildCheckpointEnv）。
import { rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { GitCheckpointDiff, GitCheckpointFileDiff } from "@zcode/shared";
import { normalizeGitPath, toWorkspaceRelativeGitPath } from "../config.js";
import { getWorkspaceHash } from "../../paths.js";

// name-status 的中间形状；originalPath 仅在 rename/copy 时非空，其余为 null 以保证序列化稳定。
interface GitCheckpointNameStatusEntry {
  kind: GitCheckpointFileDiff["kind"];
  path: string;
  originalPath: string | null;
}

// ls-tree 的中间形状；objectId 是 blob 的 SHA，按内容比对时可不必读取工作区文件。
interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

// 仓库相对路径可能来自 git 输出（POSIX 分隔符），统一按 "/" 切分再 resolve，避免 Windows 上把整串当文件名。
// toAbsolutePath 不做存在性校验：调用方需要的是路径映射，是否存在由读取方决定。
export function toAbsolutePath(repoRoot: string, repoRelativePath: string): string {
  return resolve(repoRoot, ...normalizeGitPath(repoRelativePath).split("/"));
}

// "." 必须原样保留：git 中它表示整个仓库，改写成空串会被当成「未指定路径」而静默扩大 diff 范围。
export function getWorkspacePathspec(workspaceInRepoPath: string): string {
  return workspaceInRepoPath === "." ? "." : workspaceInRepoPath;
}

// 引用名只用 hash + checkpointId，不能含原始路径：ref 名不允许空格、冒号、上标等字符，
// 直接拼路径会让含特殊字符的 workspace 触发 git check-ref-format 失败。
export function getCheckpointRefName(workspacePath: string, checkpointId: string): string {
// hash 对路径做稳定映射：同一 workspace 跨 Host 重启仍指向同一命名空间，旧 checkpoint 才能被发现与清理。
  const workspaceHash = getWorkspaceHash(workspacePath);
  return `refs/zcode/checkpoints/${workspaceHash}/${checkpointId}`;
}

// git 状态码可能带相似度后缀（R100/C75），必须只看首字符；未知状态一律归为 modified，
// 因为上层用它决定是否展示 diff，宁可多算也不要丢文件。
function mapNameStatusKind(status: string): GitCheckpointFileDiff["kind"] {
  // 空字符串会让 status[0] 得到 undefined，回落 M 避免整条记录被误判为新增或删除
  const normalized = status[0] ?? "M";
  if (normalized === "A") {
    return "added";
  }
  // D 必须映射为 deleted，错标成 modified 会让已删除文件继续出现在 diff 列表
  if (normalized === "D") {
    return "deleted";
  }
// 重命名与复制都要多消费两个字段，二者在 -z 输出里的记录形状相同，因此合并成一个 switch 分支。
  if (normalized === "R" || normalized === "C") {
    // 重命名与复制都归为 renamed，原始路径由 originalPath 字段单独携带
    return "renamed";
  }
  // 未知状态码落到 modified 而不是丢弃，宁可多展示一个文件也不要让改动消失
  return "modified";
}

// 输入必须是 git diff --name-status -z 的原始输出：-z 把每条记录变成「字段 + NUL + 字段 + NUL」，
// 从而避开 git 对含空格、中文路径的 C 风格引号转义，本函数不做任何反转义。
// 顺序推进而非固定步长：记录长度取决于状态码，重命名占 3 段，其余占 2 段。
export function parseNameStatus(stdout: string): GitCheckpointNameStatusEntry[] {
  // 先按 NUL 切段并丢掉空段，每个非空段才是一条记录的首字段
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries: GitCheckpointNameStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    // 非空断言依赖上面的 filter，缺它会让后续 kind 计算读到 undefined
    const status = records[index]!;
// 先算 kind 再决定消费几段；直接用 status[0] 判断会让 R/C 的相似度数字无法参与分支。
    // 先算出 kind 再决定推进几步，越界风险集中在一次判断里
    const kind = mapNameStatusKind(status);
    if (kind === "renamed") {
// 越界用 ?? null 而不是断言：截断输出（进程被杀、管道提前关闭）不应让解析抛异常，
// 跳过该条记录即可，后续 record 仍然有效。
      // R/C 记录的原始路径在下一段，用 ?? null 兜住被截断的尾部
      const originalPath = records[index + 1] ?? null;
      const path = records[index + 2] ?? null;
      // 重命名已消费三段，index 加 2 让循环末尾的自增正好跳过整条记录
      index += 2;
// 任一侧缺失视为无效记录：只写一半会让 diff 中的 rename 指向不存在的路径。
      if (!originalPath || !path) {
        continue;
      }
      // 两侧路径都齐才入表，缺一侧的 rename 会让 UI 打开一个不存在的文件
      entries.push({
        kind,
        originalPath: normalizeGitPath(originalPath),
        path: normalizeGitPath(path),
      });
      continue;
    }

    // 普通记录只有两段，path 缺失时必须放弃以免空串写进 diff
    const path = records[index + 1] ?? null;
    // 普通记录只消费一段路径，索引加 1 后循环末尾还会自增一次
    index += 1;
    if (!path) {
      continue;
    }
    entries.push({
      kind,
      originalPath: null,
      path: normalizeGitPath(path),
    });
  }

  // 按原始顺序返回，行数合并留给 mergeCheckpointDiff 统一处理
  return entries;
}

// 解析 --numstat -z：普通记录为「added、removed、path 三段以制表符分隔」，重命名则把两侧路径追加成两个独立 NUL 段。
// added/removed 为 "-" 表示二进制文件，记 0 而不跳过，保证文件仍出现在 diff 列表里。
// 同一路径可能被多次写入（rename 同时登记新旧路径），后写覆盖前写，语义是「取最后一次统计」。
export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  // numstat 与 name-status 共用同一套 NUL 分段规则，空段同样直接丢弃
  const records = stdout.split("\0").filter((record) => record.length > 0);
  // Map 以归一化路径为键，同一路径多次出现时后写覆盖前写
  const stats = new Map<string, { added: number; removed: number }>();

  for (let index = 0; index < records.length; index += 1) {
    // records 已过滤空段，此处断言安全且 record 仍是制表符分隔的多字段行
    const record = records[index]!;
    const fields = record.split("\t");
    // 少于三段说明既没有路径也不是合法 rename 记录，跳过比抛错更能容忍截断输出
    if (fields.length < 3) {
      continue;
    }

// parseInt 得到 NaN 时用 || 0 兜底，避免损坏输出把 NaN 传染到汇总统计。
    // 二进制文件的 added 与 removed 用 - 表示，落成 0 才能让该文件仍留在统计表里
    const added = fields[0] === "-" ? 0 : Number.parseInt(fields[0] ?? "0", 10) || 0;
    const removed = fields[1] === "-" ? 0 : Number.parseInt(fields[1] ?? "0", 10) || 0;
// 用 slice(2) 而不是 fields[2]：文件名本身可能含制表符，直接取会把路径截断。
    // 文件名含制表符时 slice(2) 能还原完整路径，直接取 fields[2] 会静默截断
    const pathField = fields.slice(2).join("\t");
    // 路径非空就是普通 numstat 记录，登记后进入下一条且不消费额外 NUL 段
    if (pathField.length > 0) {
      stats.set(normalizeGitPath(pathField), { added, removed });
      continue;
    }

// 走到这里说明 path 字段为空，按 rename 格式向后取两个路径段；两段都缺才放弃该记录。
    // 路径段为空才走到这里，按 rename 布局再取两个 NUL 段，缺失的用空串占位
    const originalPath = records[index + 1] ?? "";
    const renamedPath = records[index + 2] ?? "";
    index += 2;
    if (!renamedPath) {
      continue;
    }
    // 统计挂到新路径，UI 按新路径查找 diff 时才能拿到行数
    stats.set(normalizeGitPath(renamedPath), { added, removed });
    if (originalPath) {
      // 旧路径也登记同一组数字，否则重命名前的文件在列表里显示 0/0
      stats.set(normalizeGitPath(originalPath), { added, removed });
    }
  }

  return stats;
}

// 解析 ls-tree -z：头部是「<mode> <type> <objectId>」空格分隔，路径必须在第一个制表符之后切出，可含空格。
// 只按首个制表符切分，不要 split 整行，否则含空格的路径会被拆散。
// 无效记录直接跳过：diff 只需比对存在项，缺一条不会破坏整体正确性。
export function parseLsTree(stdout: string): Map<string, GitTreeEntry> {
  // ls-tree -z 同样以 NUL 为记录边界，结尾分隔符产生的空段直接丢弃
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries = new Map<string, GitTreeEntry>();
  for (const record of records) {
    // 只认第一个制表符作为 tabIndex 分界，路径本身可以含任意空白
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) {
      continue;
    }
    // 头部三段由单空格分隔，拆开后分别对应 mode 与 type 以及 objectId
    const header = record.slice(0, tabIndex).split(" ");
    // header 少于三段说明输出被截断，跳过该条不会影响其余文件的比对
    if (header.length < 3) {
      continue;
    }
    const path = normalizeGitPath(record.slice(tabIndex + 1));
    // 以归一化路径为键，后续与 name-status 比对时两侧路径形态一致
    entries.set(path, {
// 缺字段时给保守默认值 100644 + blob，避免在截断输出上因括号断言抛 TypeError。
      // 缺 mode 时给 100644，避免在截断输出上因 undefined 参与类型比较而崩
      mode: header[0] ?? "100644",
      type: header[1] ?? "blob",
      // objectId 缺失填空串，调用方据此跳过内容比对而不是抛异常
      objectId: header[2] ?? "",
      path,
    });
  }
  return entries;
}

// 合并 name-status（有哪些文件、何种变更）与 numstat（增删行数），产出 UI 可直接消费的文件列表。
// 同时给出仓库相对与 workspace 相对路径：前者用于 git 命令，后者用于展示与打开文件，二者不能互相推导。
// 纯函数，不访问文件系统，因此不会因 rename、删除等边界产生副作用，可直接补单测。
export function mergeCheckpointDiff(params: {
  repoRoot: string;
  workspaceInRepoPath: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  nameStatusEntries: GitCheckpointNameStatusEntry[];
  numstat: Map<string, { added: number; removed: number }>;
}): GitCheckpointDiff {
  // 以 name-status 为文件全集，numstat 只补充行数，反向合并会漏掉纯重命名条目
  const files: GitCheckpointFileDiff[] = params.nameStatusEntries.map((entry) => {
// 先按新路径查，再退回原路径：git 对 rename 的 numstat 可能只登记其中一侧，两个键都试才不会丢统计。
// 查不到时补 0/0 而不是省略字段，UI 需要稳定的数字类型。
    const stat = params.numstat.get(entry.path) ??
      // 新路径查不到再退旧路径，git 对 rename 两侧的行数登记并不固定
      params.numstat.get(entry.originalPath ?? "") ?? {
        added: 0,
        removed: 0,
      };
    return {
      // 仓库相对路径转绝对路径供打开文件，混用相对路径会把动作落到进程 cwd
      path: toAbsolutePath(params.repoRoot, entry.path),
      repoRelativePath: entry.path,
      // workspace 相对路径无法由绝对路径反推，必须显式再算一次供展示层使用
      workspaceRelativePath: toWorkspaceRelativeGitPath(entry.path, params.workspaceInRepoPath),
// 原始路径同样转绝对路径：调用方据此定位重命名前的文件，混用相对/绝对会让打开动作落到错误目录。
      // originalPath 同样转绝对路径，重命名前后的定位保持同一形态
      originalPath: entry.originalPath ? toAbsolutePath(params.repoRoot, entry.originalPath) : null,
      kind: entry.kind,
      added: stat.added,
      removed: stat.removed,
    };
  });

  return {
    fromCheckpointId: params.fromCheckpointId,
    toCheckpointId: params.toCheckpointId,
    files,
  };
}

// 汇总受影响路径时把 rename 的原路径也纳入：提交后旧路径同样需要刷新与失效缓存，
// 否则 UI 会继续展示已不存在的文件。
export function buildAffectedRepoPaths(files: GitCheckpointFileDiff[]): string[] {
  const values = new Set<string>();
  for (const file of files) {
    // 每个改动文件都先登记仓库相对路径，它是刷新缓存与执行 git 命令的键
    values.add(file.repoRelativePath);
    if (file.originalPath) {
      // 重命名前的旧路径也失效，否则 UI 会继续展示已不存在的文件
      values.add(file.originalPath);
    }
  }
// Set 去重后再展开：同一文件可能出现在多条记录里（rename 加内容修改），重复路径会让下游重复执行 git 命令。
  // 用 Set 去重后再展开，同一路径重复会让下游重复执行 git 命令
  return [...values];
}

// checkpoint 的提交必须使用独立索引：GIT_INDEX_FILE 指向临时文件，
// 这样 add/commit 不会把用户暂存区（真实 index）改写成快照内容。
// 固定 author/committer 身份，避免依赖用户 git config —— 未配置 user.email 时 commit 会直接失败。
// 调用方必须在 commit 收口后删除 GIT_INDEX_FILE 指向的临时索引；复用同一路径会把上一次快照的暂存内容串进下一次 diff。
export function buildCheckpointEnv(tempIndexPath: string): NodeJS.ProcessEnv {
  return {
// 只覆盖索引路径，其余环境继承调用方：hooks、凭证助手与代理配置仍需沿用用户环境。
    GIT_INDEX_FILE: tempIndexPath,
    // 固定作者身份，用户未配置 user.email 时 commit 不会因缺少身份直接失败
    GIT_AUTHOR_NAME: "ZCode Checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@zcode.local",
    GIT_COMMITTER_NAME: "ZCode Checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@zcode.local",
  };
}

// 清理临时索引或临时目录：force 让文件不存在时也成功，recursive 兼容目录形态的临时索引。
// 幂等是 checkpoint 重试的前提——创建失败后的回滚可能已经把同一路径删掉。
// 不吞其他错误（如权限不足）：调用方需要知道残留文件，否则下次快照会读到脏索引。
export async function removeFileIfExists(path: string): Promise<void> {
// [资源] 不做存在性预检：预检与删除之间存在竞态，force 已覆盖「不存在」的场景。
  // force 与 recursive 一起传，文件或目录两种临时产物都能被同一条删除路径清掉
  await rm(path, {
    force: true,
    recursive: true,
  });
}

// 只剥离开头的 repoRoot + 分隔符：用字符串 replace 而非正则，避免 root 中的反斜杠被当成转义。
// 路径不在 root 下时替换不生效，normalizeGitPath 仍返回原串，由调用方决定是否报错。
function toRepoRelativePathFromAbsolute(repoRoot: string, absolutePath: string): string {
  return normalizeGitPath(absolutePath.replace(`${repoRoot}${sep}`, ""));
}

// 统一出口：绝对路径转仓库相对，相对路径只做分隔符归一，保证下游拿到的 key 一致。
// 不靠字符串特征猜来源：Windows 盘符路径与 /tmp 形式都要按平台语义判断。
export function normalizeAffectedRepoPath(repoRoot: string, path: string): string {
// 两分支都过 normalizeGitPath：剥前缀后可能残留 "./" 或重复分隔符，统一清洗才能与 git 输出对齐。
  return normalizeGitPath(isAbsolute(path) ? toRepoRelativePathFromAbsolute(repoRoot, path) : path);
}
