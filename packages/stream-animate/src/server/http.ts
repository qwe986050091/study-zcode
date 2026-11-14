// stream-animate 的本地 HTTP 服务层：对外暴露 /api/config、/api/runs 与静态资源三类入口
// 边界：只监听 127.0.0.1，不做鉴权与多用户隔离，运行态数据由 dataStore 与 deepseekRunner 负责落盘
// 设计：开发态把请求交给 Vite 中间件，生产态回落到 dist 目录，两条链路共用同一个请求分派函数
// INV-01 监听地址固定 127.0.0.1，拒绝绑定外部网卡；守住位置：startStreamAnimateServer 的 listen 调用；改错故障：本机开发服务被局域网访问并暴露接口
// INV-02 /api/ 前缀请求必须在静态资源分派之前截获并直接返回；守住位置：createServer 回调的首个分支；改错故障：接口请求被 Vite 或 dist 兜底成 index.html，前端拿到 HTML 而非 JSON
// INV-03 请求处理异常统一翻译为 500 JSON，不得逃逸到进程层；守住位置：createServer 回调的 catch 分支；改错故障：一次畸形请求产生未捕获异常并中断服务
// INV-04 activeRuns 是运行中任务的唯一内存事实源，写入与删除必须成对；守住位置：POST /api/runs 分支与执行器结束回调；改错故障：任务列表残留僵尸记录或运行中任务消失
// INV-05 新任务必须先落 summary 再启动执行器，保证磁盘与内存一致；守住位置：POST /api/runs 的 writeRunSummary 顺序；改错故障：进程崩溃后重启查不到该 run，前端列表丢任务
// INV-06 任务执行器以 fire-and-forget 方式启动，不得阻塞 202 响应；守住位置：void executeDeepseekRun 调用点；改错故障：长文本生成期间新建任务请求超时
// INV-07 单次 raw 读取的行数被钳制在 1 到 2000 之间；守住位置：/api/runs/:id/raw 的 limit 计算；改错故障：构造超大 limit 触发全量读文件并拖垮服务
// INV-08 运行中任务的读取优先命中 activeRuns，未命中才回落磁盘；守住位置：GET /api/runs/:id 的分支；改错故障：前端轮询拿到过期进度，进度条倒退或卡住
// INV-09 静态资源路径必须经 resolve 后再校验是否仍位于 dist 之内；守住位置：serveStatic 的 candidate 判定；改错故障：路径穿越读取到仓库外的任意文件
// INV-10 静态资源不存在或不是普通文件时统一回落 index.html；守住位置：resolveStaticPath；改错故障：SPA 深链刷新返回 404 而不是前端路由页面
// INV-11 扩展名到 Content-Type 的映射是白名单，未知类型给 octet-stream；守住位置：contentTypeFor；改错故障：浏览器把未知文件当 HTML 或脚本执行，扩大注入面
// INV-12 请求体必须按 utf-8 拼接完整再解析，空体视为空对象；守住位置：readJsonBody；改错故障：多字节字符被截断导致解析失败并返回 500
// INV-13 入参归一化是白名单，未识别的字段不会进入 RunRequestInput；守住位置：normalizeRunInput；改错故障：调用方额外字段被持久化并污染下游请求
// INV-14 model 与 baseUrl 缺省时回落到常量，不直接透传空串；守住位置：normalizeRunInput 的 readString 组合；改错故障：上游收到空 URL 或空模型名并返回 4xx，用户只看到模糊报错
// INV-15 数值类入参必须钳制到声明区间，非有限数回落默认值；守住位置：readBoundedNumber；改错故障：temperature 或 maxTokens 越界导致上游拒绝请求
// INV-16 消息数组中的非法项被丢弃，全部为空时才使用默认对话；守住位置：normalizeMessages；改错故障：脏消息让整次请求失败，或空请求被上游判为无效
// INV-17 运行列表以 id 为键去重，内存态覆盖磁盘态，并按 createdAt 倒序；守住位置：mergeActiveRuns；改错故障：同一任务出现两条且排序错乱，前端列表抖动
// INV-18 Vite 只在 dev 模式懒加载，生产路径不引入 vite 运行时；守住位置：createViteServer 与 startStreamAnimateServer 的条件调用；改错故障：生产环境因缺少 vite 依赖启动失败
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import type { ChatMessageInput, RunRequestInput, RunSummary } from "../shared/types.js";
import { DATA_DIR_NAME, createRunId, listRuns, readRawLines, readRun, writeRunSummary } from "./dataStore.js";
import { executeDeepseekRun } from "./deepseekRunner.js";

// [权衡] 默认地址与默认模型集中在此处，便于整体切换上游；调用方显式传值时以入参为准
// [失败路径] 这两个常量只为缺省兜底，不校验可达性，上游不通时错误在 runner 内收敛
const DEFAULT_BASE_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-pro";

// [边界] dev 决定是否挂 Vite 中间件，packageRoot 是静态资源与数据目录的共同基准
// [权衡] port 由调用方指定并直接绑定，不做自增重试，端口占用会在启动期直接抛错
// 字段之间无交叉校验，缺 port 或 packageRoot 时失败发生在后续 IO 而非构造期
interface ServerOptions {
  dev: boolean;
  packageRoot: string;
  port: number;
}

// [并发] 进程内唯一保存运行中 RunSummary 的注册表，只在单线程事件循环内读写，无锁
// [资源] 条目由 POST 分支写入、由执行器结束回调删除，两条路径必须成对否则泄漏
// [权衡] 不设上限也不做超时清理，依赖执行器必然结束这一前提
const activeRuns = new Map<string, RunSummary>();

// [生命周期] 先建 Vite 再建 HTTP 服务，任一失败即中断启动，不留下半启动状态
// [边界] 所有请求经同一个 createServer 回调分派，开发态与生产态只在这里分叉
// [失败路径] 回调内任何抛错都会落到统一 catch 并回 500 JSON，进程继续存活
// [资源] 返回对象只暴露 close 与 url，Vite 与 HTTP server 的释放顺序由 close 统一编排
export async function startStreamAnimateServer(options: ServerOptions) {
  const vite = options.dev ? await createViteServer(options.packageRoot) : null;
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/")) {
        await handleApiRequest(options.packageRoot, request, response);
        return;
      }
      if (vite) {
        vite.middlewares(request, response, () => sendNotFound(response));
        return;
      }
      await serveStatic(options.packageRoot, request, response);
    // [失败路径] 这是回调层的最后兜底，覆盖路由分派、Vite 中间件与静态文件三段逻辑
    // 错误信息原样回显给调用方便于本地排查，代价是该服务不适合直接对外公开
    // [权衡] 发送 500 前未检查响应是否已写出，已开始的响应只能被动中断
    // 此处不记录日志，异常可见性完全依赖调用方读取响应体
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolveServer) => server.listen(options.port, "127.0.0.1", resolveServer));
  return {
    // [资源] 同时等待 Vite 中间件与 HTTP server 关闭，任一未完成都让 Promise 挂起
    // [权衡] 未强制断开 keep-alive 连接，存在长连接时关闭可能迟迟不回调
    // 关闭期间新请求仍可能进入回调，需由上层在关闭前停止对外暴露端口
    close: async () => {
      await Promise.all([
        vite?.close(),
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      ]);
    },
    url: `http://127.0.0.1:${options.port}/`,
  };
}

// [边界] 以本文件所在目录为锚点向上两级，源码与产物目录层级必须保持一致
// [权衡] 用 import.meta.url 而非 process.cwd，避免启动目录不同导致路径漂移
// 该结果同时充当静态根与数据根，调整目录结构会同时影响两条链路
export function getPackageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

// [边界] 路由按固定顺序匹配 config、runs 集合、runs 单体，前缀更长的分支不得前置
// [失败路径] 所有未命中分支最终落到 404 JSON，不会误返回静态资源
// [并发] 每个请求独立解析 URL 与请求体，处理分支之间不共享可变状态
// 本函数只做分派与形状校验，写盘与执行分别委托给 dataStore 与 runner
async function handleApiRequest(
  packageRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/api/config") {
    sendJson(response, 200, {
      dataDir: join("packages", "stream-animate", DATA_DIR_NAME),
      // [安全] 只回传布尔值，环境变量中的真实 key 永不出现在响应体
      // [失败路径] 变量为空串或全空白时视为未配置，前端据此提示用户手填
      hasEnvApiKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/runs") {
    const runs = await listRuns(packageRoot);
    sendJson(response, 200, { runs: mergeActiveRuns(runs) });
    return;
  }

  // [事务] 先归一化入参、再生成 run、再登记内存、再建目录写 summary，顺序不可交换
  // [并发] 登记发生在写盘之前，保证执行器首次回调时注册表已有对应条目
  // [失败路径] ensureRunDir 或 writeRunSummary 抛错时 run 已进内存，只能靠外层 500 兜底
  // 202 立即返回初始快照，前端据此开始轮询而不等待生成结束
  if (request.method === "POST" && requestUrl.pathname === "/api/runs") {
    const input = normalizeRunInput(await readJsonBody(request));
    const run = createInitialRun(input);
    activeRuns.set(run.id, run);
    const runDir = await import("./dataStore.js").then(({ ensureRunDir }) =>
      ensureRunDir(packageRoot, run.id),
    );
    await writeRunSummary(runDir, run);
    // [并发] 用 void 显式丢弃 Promise，执行器与响应生命周期解耦，不阻塞 202
    // [失败路径] 未挂 catch，执行器 reject 时会成为未处理的 Promise 拒绝
    // onUpdate 每次进度都覆盖同一 id 的条目，前端轮询因此能读到最新状态
    void executeDeepseekRun({
      onUpdate: (progressRun) => activeRuns.set(progressRun.id, progressRun),
      packageRoot,
      request: input,
      run,
    }).then((finishedRun) => {
      activeRuns.delete(finishedRun.id);
    });
    sendJson(response, 202, { run });
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)(?:\/(raw))?$/u.exec(requestUrl.pathname);
  if (request.method === "GET" && runMatch) {
    const runId = runMatch[1];
    if (!runId) {
      sendNotFound(response);
      return;
    }
    const runAction = runMatch[2];
    if (runAction === "raw") {
      const limit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "400", 10);
      sendJson(response, 200, {
        lines: await readRawLines(packageRoot, runId, Math.min(Math.max(limit, 1), 2000)),
      });
      return;
    }
    // [权衡] 内存优先可避免运行中任务读盘，磁盘回落承担进程重启后的读取
    // [并发] 取用与删除之间没有锁，极端时序下可能读到刚被删除的条目
    // 两个来源的 RunSummary 形状一致，前端无需感知数据来自内存还是文件
    sendJson(response, 200, { run: activeRuns.get(runId) ?? (await readRun(packageRoot, runId)) });
    return;
  }

  sendNotFound(response);
}

// [状态] 初始快照固化输入参数并把 status 置为 running，completedAt 与 error 留空
// [权衡] files 与 metrics 先用空值占位，后续由执行器回写，避免前端多一套判空分支
// apiKeySource 只表达来源而非密钥本身，凭据不进入持久化结构
function createInitialRun(input: RunRequestInput): RunSummary {
  const now = new Date().toISOString();
  return {
    apiKeySource: input.apiKey?.trim() ? "provided" : "env",
    baseUrl: input.baseUrl,
    completedAt: null,
    createdAt: now,
    error: null,
    files: {
      raw: "",
      responseText: "",
      summary: "",
    },
    id: createRunId(new Date(now)),
    metrics: null,
    model: input.model,
    outputPreview: "",
    reasoningEffort: input.reasoningEffort,
    status: "running",
    thinkingEnabled: input.thinkingEnabled,
  };
}

// [边界] 逐字段挑选用白名单方式重建对象，多余字段在入口处被丢弃
// [权衡] stream 恒为 true，调用方无法关闭流式，简化 runner 的分支
// thinkingEnabled 只在显式 false 时关闭，缺省按开启处理
function normalizeRunInput(value: unknown): RunRequestInput {
  const record = isRecord(value) ? value : {};
  return {
    apiKey: readString(record, "apiKey"),
    baseUrl: readString(record, "baseUrl") || DEFAULT_BASE_URL,
    maxTokens: readBoundedNumber(record.maxTokens, 16, 8192, 2048),
    messages: normalizeMessages(record.messages),
    model: readString(record, "model") || DEFAULT_MODEL,
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
    stream: true,
    temperature: readBoundedNumber(record.temperature, 0, 2, 0.2),
    thinkingEnabled: record.thinkingEnabled !== false,
  };
}

// [失败路径] 空数组或非数组直接替换为内置示例对话，保证上游至少收到两条消息
// 逐项过滤非对象与空白 content，非法项被静默丢弃而不是让整次请求失败
// [边界] role 只接受 system 与 assistant，其余一律归一为 user
function normalizeMessages(value: unknown): ChatMessageInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "写个 2000 字的小说关于英雄联盟" },
    ];
  }
  return value.flatMap((message) => {
    if (!isRecord(message)) {
      return [];
    }
    const role: ChatMessageInput["role"] =
      message.role === "system" || message.role === "assistant" ? message.role : "user";
    const content = readString(message, "content").trim();
    return content ? [{ role, content }] : [];
  });
}

function normalizeReasoningEffort(value: unknown) {
  return value === "low" || value === "medium" || value === "high" ? value : "high";
}

// [并发] 先以磁盘快照建表，再用内存态覆盖同 id 条目，内存代表更新的进度
// [权衡] 排序依赖 createdAt 的 ISO 字符串字典序，时间格式变化会破坏顺序
// 返回值是新数组，调用方修改不会回写内存注册表或磁盘数据
function mergeActiveRuns(storedRuns: RunSummary[]) {
  const runById = new Map(storedRuns.map((run) => [run.id, run]));
  for (const run of activeRuns.values()) {
    runById.set(run.id, run);
  }
  return [...runById.values()].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}

async function createViteServer(packageRoot: string): Promise<ViteDevServer> {
  const { createServer: createViteDevServer } = await import("vite");
  return createViteDevServer({
    appType: "spa",
    root: packageRoot,
    server: {
      middlewareMode: true,
    },
  });
}

// [边界] 静态根固定为 packageRoot 下的 dist，URL 路径只作为相对片段拼接
// [失败路径] 解码后的路径若逃出静态根，回落到 index.html 而不是直接 404
// [权衡] 命中判定用字符串前缀比较，未做符号链接真实路径的二次校验
async function serveStatic(packageRoot: string, request: IncomingMessage, response: ServerResponse) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const staticRoot = join(packageRoot, "dist");
  const candidate = resolve(staticRoot, `.${decodeURIComponent(requestUrl.pathname)}`);
  const filePath = candidate.startsWith(staticRoot) ? candidate : join(staticRoot, "index.html");
  const resolvedPath = await resolveStaticPath(filePath, staticRoot);
  if (!resolvedPath) {
    sendNotFound(response);
    return;
  }

  response.setHeader("Content-Type", contentTypeFor(resolvedPath));
  // [资源] 文件流直接 pipe 到响应，未监听客户端中断，提前断开时依赖 pipe 自身销毁
  // 未设置 Content-Length 与缓存头，每次请求都走全量传输
  createReadStream(resolvedPath).pipe(response);
}

async function resolveStaticPath(filePath: string, staticRoot: string) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      return filePath;
    }
  } catch {
    return join(staticRoot, "index.html");
  }
  return join(staticRoot, "index.html");
}

// [资源] 逐块聚合并整体拼接，请求体没有大小上限，超大 body 会全部驻留内存
// [失败路径] 非法 JSON 会让解析抛错并冒泡到统一 500，空体则返回空对象
async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.trim() ? (JSON.parse(text) as unknown) : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendNotFound(response: ServerResponse) {
  sendJson(response, 404, { error: "Not found" });
}

function contentTypeFor(filePath: string) {
  const extension = extname(filePath);
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readBoundedNumber(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numberValue));
}
