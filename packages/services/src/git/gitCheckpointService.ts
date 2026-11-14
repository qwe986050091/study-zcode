// Checkpoint 服务层：只做身份校验与调用编排，git 快照操作归 repo，元数据落盘归 store。
// INV-01：任何读写都必须先 loadCheckpoint，保证元数据存在且属于当前 workspace。
// INV-02：diff/restore 的两个 checkpoint 必须同 repoRoot、同 scope、同 workspaceInRepoPath。
// INV-03：删除顺序固定为 repo 清理快照 → store 删除元数据，反之会留下无法定位的孤儿快照。
// INV-04：校验失败一律 throw，不返回部分结果，调用方据此中止后续 git 写操作。
// 破坏后果：跨 workspace 比较会得到错误 diff，restore 会把内容写回别人的目录。
// [权衡] 本层不直接访问文件系统也不解析 git 输出，便于测试注入假 repo/store。
// 服务无内部可变状态，依赖由参数注入，避免同一份 checkpoint 出现多条写入路径。
import { randomUUID } from "node:crypto";
import type {
  GitCheckpointDiff,
  GitCheckpointDiffQuery,
  GitCheckpointMeta,
  GitCheckpointRequest,
  GitCheckpointRestoreQuery,
  GitCheckpointRestoreResult,
  GitRepositoryRequest,
} from "@zcode/shared";
import type { IGitCheckpointService } from "./gitCheckpoint.js";
import { createGitCheckpointRepo, type GitCheckpointRepo } from "./repo/gitCheckpointRepo.js";
import { GitCheckpointStore } from "./repo/gitCheckpointStore.js";

// [失败路径] 元数据缺失视为调用时序错误并抛错，而不是返回空 checkpoint：
// 上层若拿到空 meta，会向 git 传入不存在的引用，产生难以归因的失败。
function ensureCheckpointExists(
  meta: GitCheckpointMeta | null,
  checkpointId: string,
): GitCheckpointMeta {
// 显式判 null 而不做可选链兜底：需要把“不存在”与“存在但字段为空”分开处理。
  if (!meta) {
    throw new Error(`Checkpoint does not exist: ${checkpointId}`);
  }
  return meta;
}

// 归属校验独立于存在性校验：store 的 key 可能被伪造或迁移过，
// 仅凭“能按 id 读到”不足以证明该 checkpoint 属于本次请求的 workspace。
function ensureSameWorkspace(meta: GitCheckpointMeta, workspacePath: string): void {
  if (meta.workspacePath !== workspacePath) {
    throw new Error(`Checkpoint workspace mismatch: ${meta.checkpointId}`);
  }
}

// 三个维度全部相等才允许比较：repoRoot 决定仓库，scope 与 workspaceInRepoPath
// 共同决定快照覆盖的子树；缺一项就可能把不同子树的快照拼成一个 diff。
function ensureComparableCheckpoints(left: GitCheckpointMeta, right: GitCheckpointMeta): void {
// repoRoot 不同意味着不是同一个 git 仓库，跨仓库取对象得到的差异没有意义。
  if (left.repoRoot !== right.repoRoot) {
    throw new Error("Checkpoint repoRoot mismatch.");
  }
// scope 不同（整仓 vs 子目录）时，同一路径在两个快照里指向不同内容。
  if (left.scope !== right.scope) {
    throw new Error("Checkpoint scope mismatch.");
  }
// 同一仓库内的不同工作目录不能互相 restore，否则会把 A 目录的文件写进 B 目录。
  if (left.workspaceInRepoPath !== right.workspaceInRepoPath) {
    throw new Error("Checkpoint workspace scope mismatch.");
  }
}

// 工厂注入：仅在缺省时创建真实实现，测试可传内存版以避开触盘与跑 git。
export function createGitCheckpointService(options?: {
  store?: GitCheckpointStore;
  repo?: GitCheckpointRepo;
}): IGitCheckpointService {
  const store = options?.store ?? new GitCheckpointStore();
  const repo = options?.repo ?? createGitCheckpointRepo();

  async function loadCheckpoint(
    workspacePath: string,
    checkpointId: string,
  ): Promise<GitCheckpointMeta> {
    const meta = ensureCheckpointExists(
      await store.load(workspacePath, checkpointId),
      checkpointId,
    );
// 归属校验在返回前完成，确保调用方拿到的 meta 一定属于传入的 workspace。
    ensureSameWorkspace(meta, workspacePath);
    return meta;
  }

// 返回对象实现 IGitCheckpointService：每个方法都先完成元数据校验再触达 repo，
// 保证非法请求不会在 git 侧留下半成品状态。
  return {
// [事务] 顺序是 repo 先建快照、store 再落元数据：反过来的话快照失败会留下指向空快照的记录，
// 当前顺序下最坏只是快照无记录，属于可安全忽略的孤儿。
    async createCheckpoint(params: GitRepositoryRequest): Promise<GitCheckpointMeta> {
// id 在服务层生成并同时交给 repo 与 store，保证两边指向同一份快照，避免回读产生第二份。
      const checkpointId = randomUUID();
      const meta = await repo.createCheckpoint({
        workspacePath: params.workspacePath,
        checkpointId,
      });
// [失败路径] 落元数据失败直接抛给调用方：无记录的快照无法被后续引用，重试由上层决定。
      await store.save(meta);
      return meta;
    },

// [并发] 两个 checkpoint 并行加载：互不依赖，串行等待只会放大 IO 延迟；
// 但加载完成后必须先做可比性校验再交给 repo，顺序不能颠倒。
    async diffCheckpoints(params: GitCheckpointDiffQuery): Promise<GitCheckpointDiff> {
      const [from, to] = await Promise.all([
        loadCheckpoint(params.workspacePath, params.fromCheckpointId),
        loadCheckpoint(params.workspacePath, params.toCheckpointId),
      ]);
      ensureComparableCheckpoints(from, to);
// 校验必须在 repo 调用之前：git 侧一旦开始计算就无法回滚，无效组合应在入口拦下。
      return await repo.diffCheckpoints({
        workspacePath: params.workspacePath,
        from,
        to,
      });
    },

// restore 是唯一会修改工作区的路径，复用同样的加载与可比性校验，并原样透传 force。
    async restoreBetweenCheckpoints(
      params: GitCheckpointRestoreQuery,
    ): Promise<GitCheckpointRestoreResult> {
      const [from, to] = await Promise.all([
        loadCheckpoint(params.workspacePath, params.fromCheckpointId),
        loadCheckpoint(params.workspacePath, params.toCheckpointId),
      ]);
      ensureComparableCheckpoints(from, to);
// [失败路径] repo 的失败直接上抛：中途失败不能吞错重试，否则会叠加两次部分回滚。
      return await repo.restoreBetweenCheckpoints({
        workspacePath: params.workspacePath,
        from,
        to,
        force: params.force,
      });
    },

// 删除同样先校验：不存在的 id 直接抛错，避免对未知快照执行 git 清理。
    async deleteCheckpoint(params: GitCheckpointRequest): Promise<void> {
      const checkpoint = await loadCheckpoint(params.workspacePath, params.checkpointId);
      await repo.deleteCheckpoint({
        workspacePath: params.workspacePath,
        checkpoint,
      });
// [资源] 先删快照再删元数据：若元数据先被删而 git 清理失败，该快照将永久失去定位信息。
      await store.delete(params.workspacePath, params.checkpointId);
    },
  };
}
