// INV-01 日志只读用户目录下固定子路径：守住位置 常量拼接；改错故障 可读取任意目录。
// INV-02 尾部读取上限两兆：守住位置 常量；改错故障 大日志全量入内存。
// INV-03 默认记录数三百：守住位置 常量；改错故障 首页返回过多记录。
// INV-04 虚拟模块标识带零前缀：守住位置 模板拼接；改错故障 与真实路径冲突。
// INV-05 图谱源固定在仓库内：守住位置 路径解析；改错故障 构建读取错误文件。
// INV-06 指针文件只接受同目录 ndjson：守住位置 三重判断；改错故障 路径穿越读到外部文件。
// INV-07 指针缺失返回空：守住位置 空值分支；改错故障 抛出异常中断扫描。
// INV-08 指针失效退化为目录扫描：守住位置 候选为空分支；改错故障 无最新文件可展示。
// INV-09 候选按修改时间降序：守住位置 排序比较；改错故障 展示最旧流量。
// INV-10 根目录缺失视为空态：守住位置 早退返回；改错故障 查看器收到 500。
// INV-11 子目录只扫一级：守住位置 目录判断；改错故障 递归过深拖慢请求。
// INV-12 截断时丢弃残行：守住位置 换行查找；改错故障 首条记录 JSON 解析失败。
// INV-13 尾部最多保留请求条数：守住位置 切片取值；改错故障 返回条数不受控。
// INV-14 空文件返回空数组：守住位置 长度判断；改错故障 空文件读取抛错。
// INV-15 文件句柄必在 finally 关闭：守住位置 收尾块；改错故障 句柄泄漏。
// INV-16 图谱构建不做缓存：守住位置 纯函数边界；改错故障 调用方拿到过期图谱。
// INV-17 插件在构建开始填充缓存：守住位置 钩子顺序；改错故障 首次加载为空模块。
// INV-18 热更新只在源文件命中时重算：守住位置 路径比较；改错故障 任意文件变更都重建。
//
// 模块职责：dev-docs 的 Vite 配置，含 stdio 流量 API 与特性边界图谱虚拟模块。
// 状态所有权：图谱模块源码缓存在插件闭包内，其余均为请求期局部状态。
// 阅读顺序：先看常量与文件定位，再看尾部读取与解析，最后看两个插件与导出配置。
import { readdir, readFile, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { parse as parseYaml } from "yaml";
import { normalizeFeatureBoundaryGraph } from "./src/data/featureBoundaryGraphSource.js";

// stdio traffic 查看器的服务端常量：API 路径、日志根目录（用户 home 下，按 workspaceHash 分目录）、
// 尾部最多读取 2MiB（避免大文件全量入内存）和默认返回记录数；只影响 dev server 读取行为。
const STDIO_TRAFFIC_API_PATH = "/api/dev/stdio-traffic";
const STDIO_TRAFFIC_LOG_DIR = join(homedir(), ".zcode", "v2", "dev", "stdio-traffic");
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_RECORD_LIMIT = 300;
// 虚拟模块 id 与真实 YAML 源路径：YAML 位于仓库 .agents 技能目录，构建期读取并规范化。
// RESOLVED_ID 的 \0 前缀是 Vite 虚拟模块约定，用于与真实文件路径区分。
const FEATURE_BOUNDARY_GRAPH_MODULE_ID = "virtual:zcode-feature-boundary-graph";
const FEATURE_BOUNDARY_GRAPH_RESOLVED_ID = `\0${FEATURE_BOUNDARY_GRAPH_MODULE_ID}`;
const FEATURE_BOUNDARY_GRAPH_SOURCE_PATH = resolve(
  __dirname,
  "../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml",
);

// 候选 traffic 文件的定位信息：mtimeMs 仅用于"最新"排序，workspaceHash 用于回传给查看器展示。
// StdioTrafficFile 的 filePath 与 workspaceHash 都取自文件系统扫描结果。
// mtimeMs 只参与“最新”排序，不参与内容解析。
// workspaceHash 只回传给查看器展示，不用于过滤候选。
// 该接口声明为只读语义，扫描后不再写回这些字段。
interface StdioTrafficFile {
  filePath: string;
  mtimeMs: number;
  workspaceHash: string;
}

// 最小 JSON 响应助手：只设 Content-Type 并一次性 end，不设置状态码/CORS；
// 调用方保证 body 可 JSON 序列化（records 均为纯对象）。
function sendJson(
  response: { setHeader: (name: string, value: string) => void; end: (body: string) => void },
  body: unknown,
) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

// 用 stat 探测存在性：任何错误（不存在/权限不足）都按 false 处理，调用方据此走降级分支。
async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// 读取 workspace 目录下 latest.txt 的首行作为当前 traffic 文件路径。
// 只接受位于本目录内的 .ndjson：防止 latest.txt 被写坏后读到任意文件（越权读取/路径穿越）。
// 文件缺失、内容为空或路径不合规时返回 null，由调用方回退到目录扫描。
async function readLatestPointer(workspaceDir: string) {
  const latestPath = join(workspaceDir, "latest.txt");
  if (!(await fileExists(latestPath))) {
    return null;
  }

  const filePath = (await readFile(latestPath, "utf-8")).trim().split(/\r?\n/u)[0] ?? "";
  if (!filePath || extname(filePath) !== ".ndjson" || dirname(filePath) !== workspaceDir) {
    return null;
  }

  return filePath;
}

// 在一个 workspace 目录内挑选最新文件：优先 latest.txt 指向且存在的文件；
// 指针失效时退化为扫描目录内所有 .ndjson 并按 mtime 降序取第一条。
// 目录不可读时抛错，由 API handler 统一兜底为 error 状态。
async function findWorkspaceLatestFile(logDir: string, workspaceHash: string) {
  const workspaceDir = join(logDir, workspaceHash);
  const latestFilePath = await readLatestPointer(workspaceDir);
  const candidates: StdioTrafficFile[] = [];

  if (latestFilePath && (await fileExists(latestFilePath))) {
    const fileStat = await stat(latestFilePath);
    candidates.push({ filePath: latestFilePath, mtimeMs: fileStat.mtimeMs, workspaceHash });
  }

  if (candidates.length === 0) {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ndjson")) {
        continue;
      }
      const filePath = join(workspaceDir, entry.name);
      const fileStat = await stat(filePath);
      candidates.push({ filePath, mtimeMs: fileStat.mtimeMs, workspaceHash });
    }
  }

  return candidates.sort((first, second) => second.mtimeMs - first.mtimeMs)[0] ?? null;
}

// 遍历日志根目录下每个 workspace 子目录，取各自最新文件后再全局取 mtime 最大者。
// 根目录缺失返回 null（查看器展示 missing），不抛错；单个子目录读取失败会使整次调用失败。
async function findLatestTrafficFile(logDir: string) {
  if (!(await fileExists(logDir))) {
    return null;
  }

  const entries = await readdir(logDir, { withFileTypes: true });
  const candidates: StdioTrafficFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const latestFile = await findWorkspaceLatestFile(logDir, entry.name);
    if (latestFile) {
      candidates.push(latestFile);
    }
  }

  return candidates.sort((first, second) => second.mtimeMs - first.mtimeMs)[0] ?? null;
}

// 从文件尾部最多读取 MAX_TAIL_BYTES 字节，并只保留最后 limit 行，避免大日志全量载入。
// 截断点位于行中时丢弃第一个残行，保证返回的每行都是完整记录。
// 空文件返回空数组；打开/读取/关闭失败抛给调用方（API handler 统一兜底）。
async function readTailLines(filePath: string, limit: number) {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) {
    return [];
  }

  const start = Math.max(0, fileStat.size - MAX_TAIL_BYTES);
  const length = fileStat.size - start;
  const buffer = Buffer.alloc(length);
  const file = await open(filePath, "r");
  try {
    await file.read(buffer, 0, length, start);
  } finally {
    await file.close();
  }

  let text = buffer.toString("utf-8");
  if (start > 0) {
    // 尾部截断可能把首行切成两半，丢弃残行只保留完整记录。
    const firstLineBreak = text.indexOf("\n");
    text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
  }

  return text.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

// 读取 YAML、规范化并序列化为 ESM 源码（export default <json>）。
// 文件缺失、YAML 语法错误或顶层缺 nodes/edges 都直接抛错，由 Vite 启动/HMR 暴露给开发者。
// 不做缓存：调用方负责在 buildStart/HMR 时重算并持有 moduleSource。
async function buildFeatureBoundaryGraphModule() {
  const source = await readFile(FEATURE_BOUNDARY_GRAPH_SOURCE_PATH, "utf-8");
  const graph = normalizeFeatureBoundaryGraph(parseYaml(source));
  return `export default ${JSON.stringify(graph)};`;
}

// Vite 插件：把仓库内 feature-boundary YAML 暴露为虚拟模块，并在开发期监听源文件变更。
// moduleSource 是进程内缓存：buildStart 填充，load 懒加载兜底，HMR 命中 YAML 时重算。
// 若模块尚未进入 moduleGraph（getModuleById 为空），只更新缓存，下次 load 直接返回新内容。
// watcher.add 是必需步骤：源文件在 Vite root 之外，默认不会被监听。
// moduleSource 缓存在 featureBoundaryGraphPlugin 的闭包内。
// configureServer 里通过 server.watcher.add 补加源文件监听。
// buildStart 先调 buildFeatureBoundaryGraphModule 预填充 moduleSource。
// load 发现 moduleSource 为空时再算一次，避免 dev 首次请求拿空串。
function featureBoundaryGraphPlugin(): Plugin {
  let moduleSource = "";
  return {
    name: "zcode-dev-docs-feature-boundary-graph",
    configureServer(server) {
      server.watcher.add(FEATURE_BOUNDARY_GRAPH_SOURCE_PATH);
    },
    async buildStart() {
      moduleSource = await buildFeatureBoundaryGraphModule();
    },
    resolveId(id) {
      return id === FEATURE_BOUNDARY_GRAPH_MODULE_ID
        ? FEATURE_BOUNDARY_GRAPH_RESOLVED_ID
        : undefined;
    },
    async load(id) {
      if (id !== FEATURE_BOUNDARY_GRAPH_RESOLVED_ID) {
        return undefined;
      }
      if (!moduleSource) {
        moduleSource = await buildFeatureBoundaryGraphModule();
      }
      return moduleSource;
    },
    async handleHotUpdate({ file, server }) {
      if (resolve(file) !== FEATURE_BOUNDARY_GRAPH_SOURCE_PATH) {
        return undefined;
      }
      moduleSource = await buildFeatureBoundaryGraphModule();
      const module = server.moduleGraph.getModuleById(FEATURE_BOUNDARY_GRAPH_RESOLVED_ID);
      if (module) {
        server.moduleGraph.invalidateModule(module);
        return [module];
      }
      return undefined;
    },
  };
}

// 逐行 JSON.parse 成查看器记录；坏行降级为 agent-stderr 记录并附 parseError，
// 保证行号与原始内容仍可定位，而不是整行丢弃。
// 返回的 index 是本次 tail 结果内的序号，不是文件全局行号。
function parseRecordLines(lines: string[]) {
  return lines.flatMap((line, index) => {
    try {
      return [{ index, record: JSON.parse(line) as unknown }];
    } catch (error) {
      return [
        {
          index,
          record: {
            ts: new Date().toISOString(),
            direction: "agent-stderr",
            bytes: Buffer.byteLength(line),
            raw: line,
            parseError: error instanceof Error ? error.message : String(error),
          },
        },
      ];
    }
  });
}

// 开发服务器 API：GET /api/dev/stdio-traffic?limit=N 返回最新 workspace 的尾部 traffic 记录。
// limit 非法时回退默认 300，上限钳制 1000，防止单次请求拉取过多记录。
// 无日志返回 status=missing；读取异常返回 status=error；HTTP 始终 200，查看器按 status 分支。
// 注册固定 API 路径。
// 参数不可信先钳制。
// 三种状态都由查询结果决定。
function stdioTrafficApiPlugin(): Plugin {
  return {
    name: "zcode-dev-docs-stdio-traffic-api",
    configureServer(server) {
      server.middlewares.use(STDIO_TRAFFIC_API_PATH, async (request, response) => {
        try {
          const requestUrl = new URL(request.url ?? "", "http://localhost");
          // 查询参数不可信：非数字回退默认值，超大值必须钳制，避免内存与序列化开销失控。
          const limit = Math.min(
            Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10) || DEFAULT_RECORD_LIMIT,
            1000,
          );
          const latestFile = await findLatestTrafficFile(STDIO_TRAFFIC_LOG_DIR);
          // 目录缺失属于正常空态：返回空记录让查看器提示"暂无流量"，而不是 500。
          if (!latestFile) {
            sendJson(response, {
              status: "missing",
              logDir: STDIO_TRAFFIC_LOG_DIR,
              records: [],
            });
            return;
          }

          const lines = await readTailLines(latestFile.filePath, limit);
          sendJson(response, {
            status: lines.length > 0 ? "ready" : "empty",
            logDir: STDIO_TRAFFIC_LOG_DIR,
            workspaceHash: latestFile.workspaceHash,
            filePath: latestFile.filePath,
            updatedAt: new Date(latestFile.mtimeMs).toISOString(),
            records: parseRecordLines(lines),
          });
        } catch (error) {
          sendJson(response, {
            status: "error",
            logDir: STDIO_TRAFFIC_LOG_DIR,
            records: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

// dev-docs 的 Vite 配置：先挂 traffic API 与图谱虚拟模块插件，再挂 React/Tailwind。
// 别名 "@" 指向 src，与 tsconfig/vitest 保持一致；端口固定 5186，便于本地书签与文档引用。
export default defineConfig({
  plugins: [stdioTrafficApiPlugin(), featureBoundaryGraphPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5186,
  },
});
