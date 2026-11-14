import { join, resolve } from "node:path";

import type { FileSystemPort, Logger, TraceContext } from "@zcode/contracts";

import { ensureMemoryDirectoryExists } from "../memory/directory.js";
import type { MemoryRuntimeConfig } from "../runtime/types.js";
import type { AgentDefinitionsSnapshot } from "./definitions.js";
import type { AgentProfile, AgentMemoryScope } from "./profile.js";
import { buildPersistentAgentMemoryPrompt } from "./persistent-memory-prompt.js";

// 记忆读写所需的最小工具集：写入新文件与更新既有记忆都只用到这两个。
const PERSISTENT_MEMORY_TOOLS = ["Write", "Edit"] as const;

// 把 agent 名转成可安全用作目录名的 key：非 [a-zA-Z0-9_-] 一律替换为 "-"。
// 空结果（原名全是非法字符）回退为 "unknown"，保证目录路径始终可创建。
// 纯字符串处理，不做路径规范化，也不访问文件系统。
export function sanitizePersistentAgentMemoryKey(agentName: string): string {
  const key = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return key === "" ? "unknown" : key;
}

// 解析某 agent 的记忆根目录，按 scope 分流：
// user → <storageRoot>/agent-memory/<key>（跨项目共享，不依赖 workspace）；
// project → <workspace>/.zcode/agent-memory/<key>（可入库、团队共享）；
// local → <workspace>/.zcode/agent-memory-local/<key>（本机专用，不入库）。
// 仅做路径拼接，不创建目录、不校验存在性；workspaceRoot 会先 resolve 成绝对路径。
export function resolvePersistentAgentMemoryRoot(input: {
  agentName: string;
  scope: AgentMemoryScope;
  storageRoot: string;
  workspaceRoot: string;
}): string {
  const agentKey = sanitizePersistentAgentMemoryKey(input.agentName);
  // user scope 以全局存储根为基准，避免同一 agent 在不同项目各自积累一份记忆。
  if (input.scope === "user") {
    return join(input.storageRoot, "agent-memory", agentKey);
  }
  const workspace = resolve(input.workspaceRoot);
  return input.scope === "project"
    ? join(workspace, ".zcode", "agent-memory", agentKey)
    : join(workspace, ".zcode", "agent-memory-local", agentKey);
}

// 判断持久记忆是否可用：需 enabled=true、未被 use=false 关闭，且存在 storageRoot。
// 该谓词同时作为类型守卫，使后续代码可以安全使用 memory.storageRoot。
// undefined 配置一律视为关闭（默认不启用），不抛出错误。
function isPersistentAgentMemoryEnabled(
  memory: MemoryRuntimeConfig | undefined,
): memory is MemoryRuntimeConfig & { storageRoot: string } {
  return memory?.enabled === true && memory.use !== false && Boolean(memory.storageRoot);
}

// 为启用记忆的 profile 补齐 Write/Edit 工具；只在 profile 已显式声明 tools 时生效。
// 返回原对象（未新增工具）或浅拷贝（有新增），保证下游可用引用相等判断是否有变更。
// tools 为 undefined 表示“未限制/全量工具”，此时无需追加。
function withPersistentAgentMemoryTools(profile: AgentProfile): AgentProfile {
  if (!profile.memory || profile.tools === undefined) return profile;

  const tools = [...profile.tools];
  for (const tool of PERSISTENT_MEMORY_TOOLS) {
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools.length === profile.tools.length ? profile : { ...profile, tools };
}

// 按记忆配置投影 agent 定义的工具面：启用记忆时为相关 profile 追加 Write/Edit。
// 输出快照语义：无需变更时原样返回入参（引用相等），有变更才浅拷贝并替换 activeAgents。
// 无 IO；不修改入参 profile，也不改动未启用 memory 的 profile。
export function projectPersistentAgentMemoryTools(
  definitions: AgentDefinitionsSnapshot,
  memory: MemoryRuntimeConfig | undefined,
): AgentDefinitionsSnapshot {
  // 记忆未启用时保持原快照，避免无谓的对象重建导致下游缓存失效。
  if (!isPersistentAgentMemoryEnabled(memory)) return definitions;
  const profiles = definitions.activeAgents;

  const projected = profiles.map(withPersistentAgentMemoryTools);
  // 逐项比对引用：全部未变则返回原快照，保持幂等与引用稳定性。
  if (projected.every((profile, index) => profile === profiles[index])) return definitions;
  return {
    ...definitions,
    activeAgents: projected,
  };
}

// 已就绪的持久记忆上下文，供子 agent 注入 system 段。
export interface PersistentAgentMemory {
  // 记忆根目录绝对路径（已确保存在），提示词中作为 `<MEMORY_ROOT>` 使用。
  rootDir: string;
  // 完整记忆段提示词（含 scope 指引与 MEMORY.md 索引），非空。
  prompt: string;
}

// 加载某个 profile 的持久记忆：解析目录 → 确保目录存在 → 读取 MEMORY.md → 生成提示词。
// 输入 fileSystemPort 为 undefined（如无文件系统能力的环境）或记忆未启用时返回 undefined，
// 调用方据此省略该 system 段；函数不会因此抛错。
// 副作用：创建记忆目录（幂等）、读取 MEMORY.md（只读），并按需写日志/trace。
// 降级：MEMORY.md 不存在或不可读时不视为失败，使用空索引文案继续。
export async function loadPersistentAgentMemory(input: {
  fileSystemPort: FileSystemPort | undefined;
  memory: MemoryRuntimeConfig | undefined;
  logger?: Logger;
  profile: AgentProfile;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<PersistentAgentMemory | undefined> {
  // profile 未声明 memory scope 时该 agent 不参与持久记忆，直接跳过。
  if (!input.profile.memory || !input.fileSystemPort) return undefined;
  if (!isPersistentAgentMemoryEnabled(input.memory)) return undefined;

  const rootDir = resolvePersistentAgentMemoryRoot({
    agentName: input.profile.name,
    scope: input.profile.memory,
    storageRoot: input.memory.storageRoot,
    workspaceRoot: input.workspaceRoot,
  });
  // 目录创建幂等：已存在时只做探测；失败会向上抛出，由调用方决定是否降级。
  await ensureMemoryDirectoryExists(
    input.fileSystemPort,
    rootDir,
    input.traceContext,
    input.logger,
  );

  // 索引读取失败（不存在/无权限）统一落到空索引，不阻断子 agent 启动。
  let indexContent = "";
  try {
    indexContent = (await input.fileSystemPort.readTextFile({ path: join(rootDir, "MEMORY.md") }))
      .content;
  } catch {
    // 不存在或不可读的 MEMORY.md 都使用基线的 empty index 文案。
  }

  return {
    rootDir,
    prompt: buildPersistentAgentMemoryPrompt({
      indexContent,
      rootDir,
      scope: input.profile.memory,
    }),
  };
}
