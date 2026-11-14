import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@zcode/contracts";
import {
  createWorkspaceHookSourceInput,
  discoverWorkspaceHookConfigPaths,
  workspaceHooksConfigSchema,
  type WorkspaceHookSourceInput,
} from "@zcode/shared/workspace-hook-discovery";
import { loadFileConfig, type LoadedConfig } from "./file-config.adapter.js";

/*
 * ============================================================
 * config / project-config.adapter.ts —— 项目级配置发现与归一化
 *
 * 定位：从工作目录向上发现 .zcode 配置（经 shared discoverWorkspaceHookConfigPaths
 * canonical 去重），加载并归一化（相对 cwd 转绝对、Project hooks 移入旁路候选）。
 *
 * 输入输出：loadProjectConfigs 返回 ProjectConfigDiscovery（files/diagnostics/
 * hookCandidates/paths/mcpServerNames）；loadProjectConfigFile 返回单文件结果。
 *
 * 副作用：读取配置文件（不写入）；Project hooks 只生成 hookCandidate，不进入可执行配置。
 *
 * 失败语义：单文件加载失败由 loadFileConfig 产生 diagnostics 并 loaded=false，不中断；
 * hooks schema 校验失败会抛出（由上层捕获为 diagnostic）。
 *
 * 不变量：Project 配置永远不带 hooks 执行面；stdio MCP 的 cwd 一律归一为绝对路径。
 * ============================================================
 */

const CURRENT_DIRECTORY = ".";

export interface ProjectConfigFile {
  /** shell/MCP 相对路径的解析基准：配置文件所在目录（.zcode 目录则取其父目录）。 */
  baseDir: string;
  /** 归一化后的项目配置；未加载成功时为空对象。 */
  config: RuntimeConfigPatch;
  /** 该文件的加载/校验诊断（含 hooks 待信任 warning）。 */
  diagnostics: LoadedConfig["diagnostics"];
  /** Project hooks 的只读候选，进入 snapshot 旁路而非运行时配置。 */
  hookCandidate?: WorkspaceHookSourceInput;
  /** 文件是否成功解析；false 时 config 为空且不参与合并。 */
  loaded: boolean;
  /** 解析后的绝对路径。 */
  path: string;
}

export interface ProjectConfigDiscovery {
  /** 成功加载的文件列表（按发现顺序）。 */
  files: ProjectConfigFile[];
  /** 所有候选文件诊断的汇总（含未加载成功者）。 */
  diagnostics: LoadedConfig["diagnostics"];
  /** 供 hook bundle 使用的候选源，顺序与发现顺序一致。 */
  hookCandidates: WorkspaceHookSourceInput[];
  /** 至少一个文件加载成功时为 true。 */
  loaded: boolean;
  /** 成功加载文件的绝对路径，供审计/展示。 */
  paths: string[];
  /** 所有成功文件声明的 MCP server 名字（去重后）。 */
  mcpServerNames: string[];
}

/**
 * 发现并加载工作目录下全部项目配置。
 *
 * 不传 workingDirectory 时用 process.cwd()。发现结果按 canonical path 去重，显式
 * projectConfigPath 也会进入同一序列（不再手工追加），避免同一文件进入 snapshot 两次。
 * 副作用仅限读文件。
 */
export function loadProjectConfigs(
  workingDirectory?: string,
  explicitProjectConfigPath?: string,
): ProjectConfigDiscovery {
  const resolvedWorkingDirectory = resolve(workingDirectory ?? process.cwd());
  const files = discoverWorkspaceHookConfigPaths({
    workingDirectory: resolvedWorkingDirectory,
    ...(explicitProjectConfigPath ? { explicitProjectConfigPath } : {}),
  }).map((ref, discoveryOrder) =>
    loadProjectConfigFile(ref.path, {
      discoveryOrder,
      explicitProjectConfig: ref.explicitProjectConfig,
      workingDirectory: resolvedWorkingDirectory,
    }),
  );

  return summarizeProjectConfigs(files);
}

/**
 * 加载单个项目配置文件并做归一化。
 *
 * 读文件（loadFileConfig）→ 计算 baseDir → 若声明 hooks，追加“待信任”诊断并生成
 * hookCandidate（schema 校验后）→ 把 config 中的 hooks 剔除、stdio cwd 绝对化。
 *
 * 失败语义：解析失败时 loaded=false、config={}，诊断由 loadFileConfig 提供；
 * hooks schema 不合法会抛错，调用方应转为诊断。
 */
export function loadProjectConfigFile(
  path: string,
  options: {
    /** 发现顺序，写入 hookCandidate 用于稳定排序。 */
    discoveryOrder?: number;
    /** 是否为显式 --config 指定（影响去重/信任语义）。 */
    explicitProjectConfig?: boolean;
    /** hook 相对路径的工作目录基准；缺省用 baseDir。 */
    workingDirectory?: string;
  } = {},
): ProjectConfigFile {
  const result = loadFileConfig(path);
  const baseDir = getProjectConfigBaseDir(result.path);
  const diagnostics = [...result.diagnostics];
  const hooks = result.loaded ? result.config.hooks : undefined;

  if (hooks) {
    // Project hooks 必须先经 workspace trust 才可执行；此处只提示，不进入运行配置。
    diagnostics.push({
      code: "config_project_hooks_pending_trust",
      filePath: result.path,
      message: "Project hooks are pending workspace trust and remain blocked",
      path: "hooks",
      severity: "warning",
    });
  }

  return {
    baseDir,
    config: result.loaded ? normalizeProjectConfig(result.config, baseDir) : {},
    diagnostics,
    ...(hooks
      ? {
          hookCandidate: createWorkspaceHookSourceInput({
            path: result.path,
            workingDirectory: resolve(options.workingDirectory ?? baseDir),
            // hooks 字段已由 loadFileConfig 经 ZCodeConfigFileSchema（shared 单源
            // schema）完成运行时校验；这里的 parse 仅做类型桥接——HooksRuntimeConfigPatch
            // 与 WorkspaceHooksConfig 是两个领域类型（执行 side vs 配置 side，字段语义有
            // 微差），不共享 TS 结构。禁止改成 as 断言绕过校验。
            hooks: workspaceHooksConfigSchema.parse(hooks),
            discoveryOrder: options.discoveryOrder ?? 0,
            explicitProjectConfig: options.explicitProjectConfig,
          }),
        }
      : {}),
    loaded: result.loaded,
    path: result.path,
  };
}

/**
 * 汇总多文件结果：只保留加载成功的文件进入 merged/hookCandidates，但诊断保留全部。
 * mcpServerNames 用 Set 去重，顺序按首次出现。
 */
export function summarizeProjectConfigs(files: ProjectConfigFile[]): ProjectConfigDiscovery {
  const loadedFiles = files.filter((file) => file.loaded);
  const mcpServerNames = new Set<string>();

  for (const file of loadedFiles) {
    for (const name of Object.keys(file.config.mcp?.servers ?? {})) {
      mcpServerNames.add(name);
    }
  }

  return {
    diagnostics: files.flatMap((file) => file.diagnostics),
    files: loadedFiles,
    hookCandidates: loadedFiles.flatMap((file) => (file.hookCandidate ? [file.hookCandidate] : [])),
    loaded: loadedFiles.length > 0,
    paths: loadedFiles.map((file) => file.path),
    mcpServerNames: [...mcpServerNames],
  };
}

/** 配置放在 `.zcode` 目录时，相对路径的基准应是项目根（其父目录），而不是 .zcode 自身。 */
function getProjectConfigBaseDir(path: string): string {
  const configDirectory = dirname(path);
  return basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory;
}

/**
 * 归一化项目配置：剥离 hooks 执行面（仅保留旁路候选），并把 MCP server 归一化。
 * 先解构剔除 hooks 再返回，确保 merged RuntimeConfig 中不含 Project hook 事件。
 */
function normalizeProjectConfig(config: RuntimeConfigPatch, baseDir: string): RuntimeConfigPatch {
  const normalized: RuntimeConfigPatch = config.hooks
    ? (() => {
        const { hooks: _hooks, ...safeConfig } = config;
        // Project Hook declarations are retained only in the immutable candidate side-channel.
        // The executable RuntimeConfigPatch remains hook-free until a later admission phase.
        return safeConfig;
      })()
    : { ...config };

  if (!normalized.mcp?.servers) return normalized;

  return {
    ...normalized,
    mcp: {
      ...normalized.mcp,
      servers: Object.fromEntries(
        Object.entries(normalized.mcp.servers).map(([name, server]) => [
          name,
          normalizeProjectMcpServer(server, baseDir),
        ]),
      ),
    },
  };
}

/** stdio MCP 的相对 cwd 以项目 baseDir 为基准转绝对；http/sse 等类型原样返回。 */
function normalizeProjectMcpServer(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;

  const cwd = server.cwd ?? CURRENT_DIRECTORY;
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}
