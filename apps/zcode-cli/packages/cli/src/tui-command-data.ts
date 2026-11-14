// TUI 数据读取适配层：为命令面板/历史列表提供 custom command、skill 与 session 三类只读数据。
// 全部通过 deps 注入并懒加载 bootstrap，保证测试可替换、且不在启动期加载整个 bootstrap。
import type { TuiSessionMetadata } from "@zcode/tui";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";

// 能提供会话元数据的最小接口；getSessionMetadata 缺失表示该实现不支持。
type TuiMetadataSource = {
  // 返回会话元数据；实现可返回空对象表示"暂无信息"。
  getSessionMetadata?: () => Promise<TuiSessionMetadata>;
};

// 列出可用的自定义命令。
// 输入：deps.env/cwd 决定搜索范围，deps.listCustomCommands 可覆盖实现。
// 输出：bootstrap listZCodeCustomCommands 的结果（无命令时为列表/空集合，不是错误）。
// 副作用：读取命令目录（磁盘 IO），可能写 logger；不修改任何文件。
export async function listCustomCommandsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.listCustomCommands) {
    return await deps.listCustomCommands({ env, logger: deps.logger, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.listZCodeCustomCommands({ env, logger: deps.logger, workingDirectory });
}

// 按名字加载单个自定义命令的内容。
// 输入：name 为用户输入的命令名（不做大小写/前缀归一，交由 bootstrap 解析）。
// 输出：命令定义；不存在时由 bootstrap 抛错，TUI 负责提示。
// 副作用：只读对应命令文件。
export async function loadCustomCommandForTui(deps: RunDependencies, name: string) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.loadCustomCommand) {
    return await deps.loadCustomCommand({ env, logger: deps.logger, name, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.loadZCodeCustomCommand({
    env,
    logger: deps.logger,
    name,
    workingDirectory,
  });
}

// 列出可见 Skills 供 TUI 命令面板使用。
// 输入：deps 提供 cwd/env/logger 与可替换的 listSkills。
// 输出：与 `zcode skills list` 同源的列表结果（含 diagnostics），空集合表示未发现 skill。
// 副作用：读取工作区与插件目录。
export async function listSkillsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const listZCodeSkillsForTui = deps.listSkills ?? (await loadBootstrapModule()).listZCodeSkills;
  return await listZCodeSkillsForTui({
    env,
    logger: deps.logger,
    workingDirectory,
  });
}

// 列出当前工作目录最近的历史会话，供 TUI 的 resume 列表使用。
// 输入：deps.env/cwd；deps.listSessions 可覆盖实现。
// 输出：最多 50 条的扁平结构（字段改名：parentID→parentId、time.updated→updatedAt），只含列表展示所需信息。
// 副作用：读取 session 存储；数量上限避免长历史拖慢首屏。
// 口径：limit 固定 50 是展示层约定，不是数据层默认值。
export async function listSessionsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const listZCodeSessionsForTui =
    deps.listSessions ?? (await loadBootstrapModule()).listZCodeSessions;
  const sessions = await listZCodeSessionsForTui({
    directory: workingDirectory,
    env,
    limit: 50,
  });
  return sessions.map((session) => ({
    directory: session.directory,
    id: session.id,
    parentId: session.parentID,
    title: session.title,
    updatedAt: session.time.updated,
  }));
}

// 读取 TUI 启动时的会话元数据。
// 输入：promptHandler 只要求可选的 getSessionMetadata。
// 输出：元数据对象；实现缺失或普通失败时返回空对象 {}，保证 TUI 仍能正常渲染。
// 副作用：调用一次 getSessionMetadata，可能触发 DB 读取。
// 例外：数据库迁移失败（SqliteSessionMigrationError）必须上抛 —— 这是启动门禁，静默后会读到错误数据。
export async function loadInitialTuiSessionMetadata(
  promptHandler: TuiMetadataSource,
): Promise<TuiSessionMetadata> {
  try {
    return (await promptHandler.getSessionMetadata?.()) ?? {};
  } catch (error) {
    // 迁移类错误属于启动门禁，必须让上层感知；其它错误降级为空元数据，不阻断界面启动。
    if (isStartupGateError(error)) {
      throw error;
    }
    return {};
  }
}

// 判断是否为"必须阻断启动"的错误：目前仅识别 sqlite 迁移失败（按 error.name 判定，避免耦合具体类）。
function isStartupGateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "SqliteSessionMigrationError";
}
