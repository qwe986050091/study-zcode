// 技能发现遍历：从给定根目录深度优先找出所有 SKILL.md 的绝对路径，惰性产出。
// 边界：只做目录遍历与路径判定，不解析 SKILL.md 内容，也不缓存结果；每次调用都必须全量重扫。
// 不变量：排除目录、最大深度与可进入判定唯一来源是 @zcode/shared；本文件必须只转出与执行，不得另加过滤。
// 任何本地私有过滤都会让桌面端与 agent 端的技能集合分叉，属于必须避免的不一致。
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

// 扫描策略来自 @zcode/shared，供桌面端（本包）与 agent 端（@zcode/adapters）共享，
// 避免两端对“该进入哪些目录”产生分歧。这里转出，保持既有导入路径不变。
export {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

// 错误采集是可选的：不传 onError 表示调用方只关心成功路径，读目录失败即视作该分支不存在。
// 传入时按路径上报，让上层能区分「无权限/损坏」与「确实没有技能定义」。
export interface WalkSkillMarkdownOptions {
  /** readdir / stat 失败时回调；不传则静默跳过该目录，调用方按需收集诊断。 */
  onError?: (path: string, error: unknown) => void;
}

// 生成器是惰性的：调用方可以提前 break，栈与已访问集合随之释放，不必扫完整棵树。
// 这使它适合「找到一个展示一个」的渐进式 UI，代价是中途退出后无法续扫，需从头再来。
/**
 * 自根目录起深度优先遍历，产出每个 SKILL.md 的绝对路径。
 *
 * 受 @zcode/shared 的扫描策略约束：
 * - 跳过 node_modules 等内容目录与（除 .system 外的）点目录；
 * - 限制最大深度（MAX_SKILL_SCAN_DEPTH），作为超深目录链的兜底刹车；
 * - 仅对软链接目录按 realpath 去重，避免 Windows junction / 环路造成重复或无限扫描，
 *   普通目录树不会成环，故热路径上不额外 realpath。
 *
 */
export async function* walkSkillMarkdownPaths(
  rootPath: string,
  options: WalkSkillMarkdownOptions = {},
): AsyncGenerator<string> {
  // 显式栈替代递归：目录深度虽由 MAX_SKILL_SCAN_DEPTH 兜底，但递归会先吃掉调用栈，栈结构让上限完全受控。
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  // 只登记软链 realpath 的去重集合：普通目录按文件系统树天然无环，全量 realpath 会为每个目录白付一次 IO。
  const visitedSymlinkTargets = new Set<string>();

  while (stack.length > 0) {
    // 后进先出实现深度优先：子目录按发现顺序压栈，pop 顺序与扫描顺序相反，但父目录始终先于子目录产出。
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const { dir, depth } = current;

    let entries;
    try {
      // withFileTypes 让 Dirent 自带类型信息，省掉每个子项的 stat；这是热路径上唯一允许的目录读取。
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // 读目录失败先回调再跳过整棵子树：权限错误或损坏目录不应中断扫描，否则一个坏目录会藏起其余技能。
      options.onError?.(dir, error);
      continue;
    }

    // hasSkillFile 只描述当前目录是否直接含 SKILL.md，与子目录结果分开，保证父级技能先被产出。
    let hasSkillFile = false;
    const childDirectories: string[] = [];
    const childSymlinks: string[] = [];
    for (const entry of entries) {
      // 普通文件或指向文件的软链命名为 SKILL.md 都视为技能定义。
      // 名字等于 SKILL_FILE_NAME 且不是目录才算技能定义：同名目录仍要递归进去，不能被提前当成文件。
      if (entry.name === SKILL_FILE_NAME && !entry.isDirectory()) {
        hasSkillFile = true;
        continue;
      }
      // 进入判定唯一来源是 shared：此处再加本地黑名单，桌面端与 agent 端的技能集合就会分叉。
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      // 先拼绝对路径再分支，避免文件与目录两条路径各拼一次；entryPath 也是后续 stat 与 realpath 的输入。
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 普通目录只入队不就地递归：当前层 entries 必须先遍历完，边遍历边扩展会改变目录处理顺序。
        childDirectories.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        // 软链延后到普通目录之后统一处理：realpath 昂贵且可能失败，集中处理才便于去重与错误上报。
        childSymlinks.push(entryPath);
      }
    }

// 先产出再入栈子目录：父级技能先于其子目录中的技能被消费，这个顺序对 UI 呈现是可感知的。
// hasSkillFile 只认名字且非目录，文件型软链也算命中；因此这里必须不额外 stat，以免热路径多一次 IO。
    if (hasSkillFile) {
      // 产出时重新 join(dir, SKILL_FILE_NAME) 而不是复用 entry 文本，保证返回的一直是绝对路径。
      yield join(dir, SKILL_FILE_NAME);
    }

    // 深度达到 MAX_SKILL_SCAN_DEPTH 即停止入栈：超深目录链会拖慢整次扫描，这个刹车优先于覆盖完整性。
    if (depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }

    for (const childDirectory of childDirectories) {
      // 普通子目录直接压栈；深度只在这里加一，绕过此处的入栈都会让 MAX_SKILL_SCAN_DEPTH 失效。
      stack.push({ dir: childDirectory, depth: depth + 1 });
    }

    // 软链目录：先确认指向目录、再按 realpath 去重，避免 junction / 环路重复或无限扫描。
    for (const childSymlink of childSymlinks) {
      let targetStat;
      try {
        // 先 stat 跟随软链确认目标是目录；断链或指向文件都跳过，避免把文件传给 readdir 抛 ENOTDIR。
        targetStat = await stat(childSymlink);
      } catch (error) {
        options.onError?.(childSymlink, error);
        continue;
      }
      // 目标不是目录时静默跳过：文件型软链已在 hasSkillFile 分支按名字命中，这里只处理目录型软链。
      if (!targetStat.isDirectory()) {
        continue;
      }
      // realpath 失败时回落到原路径：取不到真实路径仍要扫描一次，用原路径去重至少不会重复入栈同一链接。
      const canonical = await realpath(childSymlink).catch(() => childSymlink);
      // 同一 realpath 只展开一次：两个软链指向同一目录若都展开，技能会被重复产出并在 UI 里出现重复项。
      if (visitedSymlinkTargets.has(canonical)) {
        continue;
      }
      // 登记与压栈必须成对：只 add 不 push 会漏扫该目录，只 push 不 add 会让环路在下一轮再次进入。
      visitedSymlinkTargets.add(canonical);
      // 软链目录复用同一深度递增规则，链接层数也计入 MAX_SKILL_SCAN_DEPTH，环路因此最多展开受限层数。
      stack.push({ dir: childSymlink, depth: depth + 1 });
    }
  }
}
