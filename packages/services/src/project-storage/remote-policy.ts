// 远端项目目录约束：在写入前集中校验单根、根不可变与 cwd 归属三条规则。
// 边界：assertRemoteProjectRoots 与 assertRemoteTaskDirectories 都是纯校验函数，无 IO、无副作用；通过只表示路径合法，不能替代调用方的落库时机控制。
// INV：豁免条件只看持库宿主——ownerHostId 为空或 local 时跳过，其余情况一律收紧。
// 改错后果：任一判断被放宽，远端会话就可能引用宿主上不存在的目录或悄悄换根。
import type { VirtualProject } from "#src/project-storage/contract.js";

/** 远端限制必须依据持库宿主，不能让请求中的 hostId 或 addMissingRoot 绕过。 */
export function assertRemoteProjectRoots(
  ownerHostId: string | undefined,
  roots: readonly string[],
  previous?: VirtualProject,
): void {
  // 豁免只看持库宿主 ownerHostId：请求体里的 hostId 不参与判断，否则客户端可自称 local 绕过全部远端约束。
  if (!ownerHostId || ownerHostId === "local") return;
// 远端只允许单根：多根需要跨目录一致性同步，目前没有对应模型，因此直接拒绝。
  if (roots.length !== 1) throw new Error("project.remote-single-root-required");
  // 根不可变：上一版根与本次不一致即拒绝，允许换根等于让远端会话引用旧机器上不存在的目录。
  if (previous && (previous.roots.length !== 1 || previous.roots[0]?.rootPath !== roots[0]))
    throw new Error("project.remote-root-immutable");
}

/** 新建、移动和恢复共用约束；固定执行配置也不能给远端会话增加第二个目录。 */
export function assertRemoteTaskDirectories(
  ownerHostId: string | undefined,
  project: VirtualProject | null | undefined,
  workspacePath: string,
  additionalDirectories: readonly string[] = [],
): void {
  // 任务入口再判一次同样的豁免：两个导出函数可被独立调用，不能假设上游已经校验过持库宿主。
  if (!ownerHostId || ownerHostId === "local") return;
// 新建任务必须已有项目：否则 cwd 与根目录的归属校验失去基准，只能拒绝。
  if (!project) throw new Error("project.remote-project-required");
  // 这里只校验根的数量与单根约束，不传 previous：新建任务没有历史根可比较，null 会让「根不可变」误报。
  assertRemoteProjectRoots(
    ownerHostId,
    project.roots.map((root) => root.rootPath),
  );
  // 附加目录对远端一律拒绝：多根模型不存在，放开后 cwd 会落到未同步到宿主的本地目录上。
  if (additionalDirectories.length) throw new Error("project.remote-single-root-required");
  // cwd 必须等于唯一根：否则任务会在根之外启动，文件操作与索引基准不在同一目录。
  if (project.roots[0]?.rootPath !== workspacePath) throw new Error("project.cwd-not-in-roots");
}
