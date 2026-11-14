/**
 * MCP 用户目录模块 - Claude CLI 特殊处理
 */

// Claude CLI MCP 适配层：把 CLI 原生配置文件与 state 文件里的 mcpServers、projects 片段映射为统一的 NativeMcpServerRecord
// 读取分两类：user 作用域合并原生配置与 state 顶层的 mcpServers，workspace 作用域合并项目原生配置与 projects 中该工作区的 mcpServers
// 写回只替换 mcpServers 与 projects 字段，其余键必须原样保留，避免抹掉用户在 ~/.claude.json 里维护的其它设置
// 本文件不能解析 MCP 协议、不能启动进程，只做文件层面的模型转换与持久化
// INV-01 同名服务器在两个来源同时存在时由后者覆盖，user 取 state、workspace 取 projects 片段；守住位置：readClaudeUserServers 与 readClaudeWorkspaceServers 的第二次 set；改错故障：用户在 CLI 里改过的配置被旧文件回滚，列表显示过时的启动命令
// INV-02 项目路径比较必须经 normalizePathForLookup，Windows 大小写与分隔符差异不能影响匹配；守住位置：findClaudeProjectState 与 shouldWriteClaudeServerToState；改错故障：同一工作区读不到禁用列表，已停用的服务器重新显示为启用
// INV-03 配置文件解析失败视为不存在而不是抛错，写回前用空对象补位；守住位置：两个写回函数的 root 初始化；改错故障：用户手工改坏 JSON 后任何保存都直接失败，界面无法自愈
// INV-04 mcpServers 的值必须收敛为对象记录，数组与标量条目在校验层丢弃；守住位置：normalizeServerMap 的调用点；改错故障：脏条目进入渲染层，MCP 列表渲染崩溃或保存出非法结构
// INV-05 启用状态由 projects 中该工作区的 disabledMcpServers 取反得出，缺失即视为启用；守住位置：两个读函数的禁用名集合构造；改错故障：未配置禁用项时所有服务器被误判为停用
// INV-06 workspace 读取缺路径时返回空数组，不猜测默认项目；守住位置：readClaudeWorkspaceServers 的首个判断；改错故障：启动早期把用户级配置混入工作区分组，出现重复条目
// INV-07 upsert 的目标文件由同名条目的既有 filePath 决定，路径归一化等于 state 文件才写 state；守住位置：两个写回函数的 upsert 分支；改错故障：条目在 state 与原生配置之间反复漂移，同一服务器出现两份副本
// INV-08 写入一侧时必须从另一侧删除同名键，两侧不允许同时持有同一服务器；守住位置：upsert 分支里配对出现的 delete；改错故障：界面改一处而实际生效的是另一处，用户反复保存仍不生效
// INV-09 upsert 缺少 config 时在落盘前抛错，不写入空条目；守住位置：两个写回函数的 upsert 校验；改错故障：用户保存成功后得到一个既无命令也无地址的服务器
// INV-10 删除动作同时清除两侧同名键，不存在的键静默忽略；守住位置：写回函数的删除分支；改错故障：删除后残留条目在下次启动时复活
// INV-11 写回以展开原 root 再覆盖目标字段的方式保留未知顶层键；守住位置：两处 JSON 序列化前的对象构造；改错故障：保存 MCP 后 hooks、env 等配置被抹掉，CLI 整体行为改变
// INV-12 workspace 写回只替换 projects 中当前工作区的节点，其它工作区节点原样透传；守住位置：nextProjectsRoot 的构造；改错故障：切换项目后另一个项目丢失全部 MCP 配置与禁用状态
// INV-13 项目状态允许缺失，先补空对象再挂 mcpServers，绝不把 null 写入 projects；守住位置：nextProjectState 的 isRecord 判断；改错故障：首次为某工作区添加服务器时写入空值，后续读取直接丢弃项目状态
// INV-14 写盘格式固定为两空格缩进并补一个尾随换行，与 CLI 自身风格一致；守住位置：writeTextAtomic 的序列化参数；改错故障：每次保存都产生整文件 diff，配置仓库出现无意义变更
// INV-15 所有落盘必须经 writeTextAtomic 先写临时文件再改名，不允许直接覆盖目标路径；守住位置：四个写回点；改错故障：写入过程中崩溃留下半截 JSON，整份 CLI 配置不可读
// INV-16 记录中的 filePath 必须等于实际落盘位置，归属判断依赖它而非推断；守住位置：mapNativeServers 与两个读函数的 file 字段；改错故障：下次写入路由到错误文件，用户改动看起来被静默忽略
// INV-17 路径只由 source 描述符的目录段与文件名拼出，未注册的 source 立即抛错；守住位置：buildNativeConfigPath；改错故障：配置写到错误目录，界面显示保存成功但 CLI 读不到
// INV-18 user 作用域基目录固定为用户主目录，workspace 作用域必须使用传入路径，两者不可混用；守住位置：buildNativeConfigPath 与 buildClaudeLocation 的 baseDir；改错故障：工作区配置被写进主目录，所有项目共享同一份错误配置
// INV-19 对外 location 的 scope 只有 user 与 project，projectPath 仅在传入工作区路径时出现；守住位置：buildClaudeLocation 的返回值；改错故障：设置在界面上归错分组，用户找不到也删不掉对应文件
// INV-20 两个读函数相互独立且幂等，各自解析失败互不影响，多次调用不改变磁盘；守住位置：readClaudeUserServers 与 readClaudeWorkspaceServers 的独立读取；改错故障：state 文件损坏时连原生配置里的服务器一起消失
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CliMcpSource,
  McpFileFormat,
  McpScope,
  SettingsDirectoryLocation,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import { getSourceDescriptor } from "./types.js";
import {
  buildClaudeStateFilePath,
  isRecord,
  normalizePathForLookup,
  normalizeServerMap,
  normalizeStringArray,
  readJsonObject,
  writeTextAtomic,
} from "./utils.js";

// 【不变量】项目状态只能从 root.projects 里按键匹配取得，缺失或非对象一律返回 null
// 【失败路径】workspacePath 为空或 root 为 null 时提前返回，避免把“没有路径”误判成“匹配到默认项目”
// 【权衡】遍历全部 projects 逐项归一化比较而非用原始键直接查表，换取 Windows 路径大小写与分隔符容错
// 【不变量】projects 必须是对象记录，数组或字符串直接放弃而不是逐下标当作项目
function findClaudeProjectState(
  root: Record<string, unknown> | null,
  workspacePath?: string,
): Record<string, unknown> | null {
  // 【失败路径】缺工作区路径时按“无项目状态”处理，禁用列表退化为空集
  // 【权衡】此处返回 null 而不抛错，让上层决定是否继续，读取不会因缺少路径而中断
  if (!workspacePath || !root) {
    return null;
  }

  const projects = root.projects;
  if (!isRecord(projects)) {
    return null;
  }

  const targetPath = normalizePathForLookup(workspacePath);
  for (const [projectPath, value] of Object.entries(projects)) {
    if (normalizePathForLookup(projectPath) === targetPath && isRecord(value)) {
      return value;
    }
  }

  return null;
}

// 【不变量】映射前必须再走一次 normalizeServerMap，即使调用方已过滤，防止脏值从这里漏进记录
// 【不变量】每条记录带上 file.format 与 file.filePath，后续写回靠它们判断条目归属
// 【不变量】enabled 只由调用方给出的 enabledByName 决定，未提供时保持 undefined 而不是默认 true
// 【权衡】用 Object.entries 配合 map 保留配置键顺序，代价是记录顺序依赖文件内键序
function mapNativeServers(params: {
  source: CliMcpSource;
  scope: Exclude<McpScope, "common">;
  serverMap: Record<string, unknown>;
  filePath: string;
  format: McpFileFormat;
  projectPath?: string;
  enabledByName?: Record<string, boolean>;
}): NativeMcpServerRecord[] {
  const serverMap = normalizeServerMap(params.serverMap);
  return Object.entries(serverMap).map(([name, config]) => ({
    source: params.source,
    scope: params.scope,
    name,
    config,
    enabled: params.enabledByName?.[name],
    projectPath: params.projectPath,
    location: buildClaudeLocation(params.scope, params.projectPath),
    file: {
      format: params.format,
      filePath: params.filePath,
    },
  }));
}

// 【不变量】路径由 getSourceDescriptor 的目录段与文件名拼出，本文件不硬编码任何 Claude 路径
// 【失败路径】未注册的 source 在描述符查找处抛错，不会静默回退到默认目录
// 【失败路径】workspace 作用域缺路径时抛错，宁可失败也不写到家目录
// 【不变量】user 作用域以用户主目录 homedir 为基准，路径与具体账户绑定
function buildNativeConfigPath(
  source: CliMcpSource,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const descriptor = getSourceDescriptor(source);
  const baseDir = scope === "user" ? homedir() : workspacePath;

  if (!baseDir) {
    throw new Error(`Missing workspace path for ${source} workspace MCP config`);
  }

  return join(baseDir, ...descriptor.configDirSegments, descriptor.fileName);
}

// 【不变量】原生配置文件路径只经这一个出口产出，读写两侧必须复用同一函数
// 【权衡】薄封装固定 source 为 claudeclimcp，避免调用点各自拼装导致读写路径不一致
function buildClaudeSettingsFilePath(scope: Exclude<McpScope, "common">, workspacePath?: string): string {
  return buildNativeConfigPath("claudeclimcp", scope, workspacePath);
}

// 【不变量】对外的 scope 只有 user 与 project 两种，workspace 在此被翻译为 project
// 【不变量】只有传入 workspacePath 时才输出 projectPath 字段，避免用户级配置带上项目标识
// 【失败路径】缺基准目录时抛错，防止 location 指向不可解析的相对路径
function buildClaudeLocation(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const baseDir = scope === "user" ? homedir() : workspacePath;
  if (!baseDir) {
    throw new Error("Missing workspace path for Claude workspace MCP config");
  }
  return {
    source: "claude",
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: join(baseDir, ".claude"),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

// 【不变量】同名服务器不存在或没有 file 信息时默认写入 state，即优先让 CLI 状态文件承载新条目
// 【不变量】只有已有条目的文件路径与 state 文件路径归一化相等才继续写 state，否则退回原生配置
// 【权衡】以“上次写在哪”而非“哪种格式更优先”做路由，保证同一条目不会在两个文件间来回跳
function shouldWriteClaudeServerToState(
  existingServers: NativeMcpServerRecord[],
  name: string,
  stateFilePath: string,
): boolean {
  const existing = existingServers.find((server) => server.name === name);
  if (!existing?.file?.filePath) {
    return true;
  }
  return normalizePathForLookup(existing.file.filePath) === normalizePathForLookup(stateFilePath);
}

// 【不变量】先铺原生配置再铺 state，同名键由 state 覆盖，这是 user 作用域的唯一优先级规则
// 【不变量】记录里的 filePath 标明该条目最终来源文件，用于后续写回时的归属判断
// 【失败路径】任一文件缺失或 JSON 损坏都只贡献空映射，另一个文件仍照常返回
// 【不变量】enabled 取反自 projects 中该工作区的 disabledMcpServers，与 mcpServers 的来源无关
// 【权衡】合并用 Map 而非对象展开，保留首次插入顺序且避免原型链键名污染
export async function readClaudeUserServers(workspacePath?: string): Promise<NativeMcpServerRecord[]> {
  const legacyFilePath = buildNativeConfigPath("claudeclimcp", "user");
  const legacyRoot = await readJsonObject(legacyFilePath);
  const settingsServers = normalizeServerMap(legacyRoot?.mcpServers);

  const stateFilePath = buildClaudeStateFilePath();
  const stateRoot = await readJsonObject(stateFilePath);
  const stateServers = normalizeServerMap(stateRoot?.mcpServers);

  const merged = new Map<string, { config: unknown; filePath: string }>();
  for (const [name, config] of Object.entries(settingsServers)) {
    merged.set(name, { config, filePath: legacyFilePath });
  }
  for (const [name, config] of Object.entries(stateServers)) {
    merged.set(name, { config, filePath: stateFilePath });
  }

  // 【生命周期】合并结果为空时提前返回，不构造任何记录也不读取项目禁用信息
  // 【权衡】merged.size === 0 走快路径，省掉为一个不存在的配置构造临时结构
  if (merged.size === 0) {
    return [];
  }

  const projectState = findClaudeProjectState(stateRoot, workspacePath);
  const disabledNames = new Set(normalizeStringArray(projectState?.disabledMcpServers));

  const result: NativeMcpServerRecord[] = [];
  for (const [name, { config, filePath }] of merged.entries()) {
    result.push({
      source: "claudeclimcp",
      scope: "user",
      name,
      config: config as Record<string, unknown>,
      enabled: !disabledNames.has(name),
      location: buildClaudeLocation("user"),
      file: {
        format: "json",
        filePath,
      },
    });
  }

  return result;
}

// 【不变量】先铺项目原生配置文件，再铺 state 里的项目片段，后者覆盖前者
// 【不变量】state 中的服务器 enabled 由该项目 disabledMcpServers 统一决定，同一名字只判断一次
// 【不变量】返回顺序为 Map 插入顺序：原生文件条目在前，state 独有条目在后
// 【失败路径】项目原生配置文件不存在时只保留 state 条目，不视作错误
// 【权衡】用 enabledByName 预计算启用状态，换掉逐条查 Set 的重复归一化开销
// 【不变量】两个来源都以 workspace 作用域与同一 projectPath 落记录，界面上不会串到 user 分组
export async function readClaudeWorkspaceServers(workspacePath?: string): Promise<NativeMcpServerRecord[]> {
  if (!workspacePath) {
    return [];
  }

  const merged = new Map<string, NativeMcpServerRecord>();
  const workspaceFilePath = buildNativeConfigPath("claudeclimcp", "workspace", workspacePath);
  const workspaceRoot = await readJsonObject(workspaceFilePath);
  const workspaceServers = normalizeServerMap(workspaceRoot?.mcpServers);
  for (const server of mapNativeServers({
    source: "claudeclimcp",
    scope: "workspace",
    serverMap: workspaceServers,
    filePath: workspaceFilePath,
    format: "json",
    projectPath: workspacePath,
  })) {
    merged.set(server.name, server);
  }

  const stateFilePath = buildClaudeStateFilePath();
  const stateRoot = await readJsonObject(stateFilePath);
  const projectState = findClaudeProjectState(stateRoot, workspacePath);
  const projectServers = normalizeServerMap(projectState?.mcpServers);
  const disabledNames = new Set(normalizeStringArray(projectState?.disabledMcpServers));
  const enabledByName = Object.fromEntries(
    Object.keys(projectServers).map((name) => [name, !disabledNames.has(name)]),
  );

  for (const server of mapNativeServers({
    source: "claudeclimcp",
    scope: "workspace",
    serverMap: projectServers,
    filePath: stateFilePath,
    format: "json",
    projectPath: workspacePath,
    enabledByName,
  })) {
    merged.set(server.name, server);
  }

  return Array.from(merged.values());
}

// 【不变量】写前先读两侧现有内容，缺文件以空对象补位，保证只做增量合并
// 【不变量】upsert 与删除都同时操作 settingsServers 与 stateServers，单侧改动视为不完整
// 【生命周期】两次落盘各自独立，先原生配置后 state，中途失败留下可被下次读取纠正的中间态
// 【失败路径】缺 config 的 upsert 在写盘前抛错，磁盘保持原样
// 【不变量】写回展开 settingsRoot 与 stateRoot 的其余键，只替换 mcpServers
async function writeClaudeUserServers(
  servers: NativeMcpServerRecord[],
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  const settingsFilePath = buildClaudeSettingsFilePath("user");
  const stateFilePath = buildClaudeStateFilePath();
  const settingsRoot = (await readJsonObject(settingsFilePath)) ?? {};
  const stateRoot = (await readJsonObject(stateFilePath)) ?? {};
  const settingsServers = normalizeServerMap(settingsRoot.mcpServers);
  const stateServers = normalizeServerMap(stateRoot.mcpServers);

  // 【不变量】只有 upsert 才需要 config，其余 action 必须一律按删除处理，不做部分更新
  // 【失败路径】空 config 在此分支拦截，避免写入既无 command 也无 url 的条目
  // 【权衡】以 shouldWriteClaudeServerToState 给出的既有位置决定目标文件，而不是每次一律写 state
  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    if (shouldWriteClaudeServerToState(servers, payload.name, stateFilePath)) {
      stateServers[payload.name] = payload.config;
      delete settingsServers[payload.name];
    } else {
      settingsServers[payload.name] = payload.config;
    }
  } else {
    delete stateServers[payload.name];
    delete settingsServers[payload.name];
  }

  await writeTextAtomic(settingsFilePath, JSON.stringify({ ...settingsRoot, mcpServers: settingsServers }, null, 2) + "\n");
  await writeTextAtomic(stateFilePath, JSON.stringify({ ...stateRoot, mcpServers: stateServers }, null, 2) + "\n");
}

// 【不变量】必须带 projectPath，缺失时抛错，绝不回退到用户级配置
// 【不变量】settings 文件只承载本项目原生条目，state 只承载 projects[projectPath] 下的条目
// 【生命周期】读取与写入顺序一致，均为先 settings 后 state，两次写入之间不是原子事务
// 【失败路径】项目状态缺失时以空对象起步，不覆盖 projects 中其它工作区的键
// 【不变量】projectsRoot 若是脏值则整体替换为空对象，其余顶层键仍从 stateRoot 展开保留
async function writeClaudeWorkspaceServers(
  servers: NativeMcpServerRecord[],
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (!payload.projectPath) {
    throw new Error("Missing workspace path for Claude workspace MCP config");
  }

  const settingsFilePath = buildClaudeSettingsFilePath("workspace", payload.projectPath);
  const stateFilePath = buildClaudeStateFilePath();
  const settingsRoot = (await readJsonObject(settingsFilePath)) ?? {};
  const stateRoot = (await readJsonObject(stateFilePath)) ?? {};
  const workspaceServers = normalizeServerMap(settingsRoot.mcpServers);
  const projectsRoot = isRecord(stateRoot.projects) ? stateRoot.projects : {};
  const projectState = findClaudeProjectState(stateRoot, payload.projectPath);
  const projectServers = normalizeServerMap(projectState?.mcpServers);

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    if (shouldWriteClaudeServerToState(servers, payload.name, stateFilePath)) {
      projectServers[payload.name] = payload.config;
      delete workspaceServers[payload.name];
    } else {
      workspaceServers[payload.name] = payload.config;
    }
  } else {
    delete projectServers[payload.name];
    delete workspaceServers[payload.name];
  }

  // 【不变量】先浅拷贝项目状态再挂 mcpServers，避免直接改动从 stateRoot 展开的对象
  // 【失败路径】projectState 为非对象时退化为空对象，防止把 null 写进 projects
  const nextProjectState = isRecord(projectState) ? { ...projectState } : {};
  nextProjectState.mcpServers = projectServers;
  const nextProjectsRoot = { ...projectsRoot, [payload.projectPath]: nextProjectState };

  await writeTextAtomic(settingsFilePath, JSON.stringify({ ...settingsRoot, mcpServers: workspaceServers }, null, 2) + "\n");
  await writeTextAtomic(stateFilePath, JSON.stringify({ ...stateRoot, projects: nextProjectsRoot }, null, 2) + "\n");
}

// 【不变量】scope 只区分 user 与其余，其余必须一律按 workspace 处理，不设第三分支
// 【权衡】仅做分发不加锁，并发保存同一 scope 时后写者覆盖前者，串行由调用方保证
export async function writeClaudeServers(
  scope: Exclude<McpScope, "common">,
  servers: NativeMcpServerRecord[],
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (scope === "user") {
    await writeClaudeUserServers(servers, payload);
    return;
  }
  await writeClaudeWorkspaceServers(servers, payload);
}
