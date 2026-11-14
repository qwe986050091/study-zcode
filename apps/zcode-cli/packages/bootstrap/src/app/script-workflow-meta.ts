// INV-01 脚本读取设字节上限：守住位置 读取参数；改错故障 超大脚本拖垮宿主。
// INV-02 截断即报错：守住位置 结果判断；改错故障 半份脚本被当成完整内容执行。
// INV-03 缺少元数据导出直接拒绝：守住位置 匹配判断；改错故障 无元数据脚本进入执行。
// INV-04 元数据必须是对象字面量：守住位置 首字符判断；改错故障 表达式引用在宿主求值。
// INV-05 求值放独立子进程：守住位置 进程启动；改错故障 脚本可污染宿主全局。
// INV-06 求值设超时：守住位置 定时器；改错故障 死循环脚本永久占住调用方。
// INV-07 子进程输出设上限：守住位置 累计判断；改错故障 恶意脚本写爆内存。
// INV-08 非零退出转为错误：守住位置 退出码判断；改错故障 失败被当成空元数据。
// INV-09 子进程错误也向上抛：守住位置 错误监听；改错故障 启动失败被误判为成功。
// INV-10 结果先校验再返回：守住位置 模式解析；改错故障 非法元数据流入下游。
// INV-11 正文从元数据之后开始：守住位置 切片位置；改错故障 子进程重复执行声明。
// INV-12 吃掉可选分号：守住位置 单字符判断；改错故障 正文以分号开头导致语法错误。
// INV-13 哈希基于整份原文：守住位置 摘要入参；改错故障 仅改元数据时缓存不失效。
// INV-14 稳定序列化对键排序：守住位置 排序调用；改错故障 同语义对象得到不同哈希。
// INV-15 数组保持原序：守住位置 映射实现；改错故障 顺序变化被误判为内容变化。
// INV-16 括号扫描跳过字符串与注释：守住位置 扫描分支；改错故障 引号里的花括号破坏深度。
// INV-17 未闭合一律报错：守住位置 循环结束；改错故障 坏脚本被当作无元数据。
// INV-18 求值源码不拼接用户输入：守住位置 传参方式；改错故障 表达式注入宿主命令。
//
// 模块职责：工作流脚本的读取、元数据提取求值与内容哈希。
// 状态所有权：无状态；每个脚本各自解析，不缓存跨调用结果。
// 阅读顺序：先看主读取流程，再看稳定哈希，最后看求值与扫描器。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  WorkflowScriptMetaSchema,
  type FileSystemPort,
  type TraceContext,
  type WorkflowScriptMeta,
} from "@zcode/contracts";

const META_EXPORT_PATTERN = /export\s+const\s+meta\s*=/;
const META_EVAL_TIMEOUT_MS = 5_000;
const MAX_META_EVAL_OUTPUT_BYTES = 1024 * 1024;
const SCRIPT_READ_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 脚本文件读取后的完整文档：原文、去掉 meta 后的 body、内容 hash 与已校验 meta。
 *
 * `content` 与 `body` 是两份派生物：前者用于 hash / 缓存身份，后者才是交给子进程执行的脚本
 * （meta 必须在宿主侧先校验，不能在子进程里 `export const meta`）。
 */
export interface WorkflowScriptDocument {
  body: string;
  content: string;
  hash: string;
  meta: WorkflowScriptMeta;
  path: string;
}

/**
 * 读脚本并拆出 meta：读文件（2 MiB 上限，超限即截断并抛错）→ 定位 `export const meta = {...}`
 * 对象字面量 → 在独立 Node 子进程里 eval 该表达式（5 s 超时）→ zod 校验 → 计算整份文件的
 * sha256 与去掉 meta 的 body。
 * 失败语义：读失败、截断、缺 meta、非对象字面量、求值超时 / 非零退出、schema 不符都直接抛；
 * 不返回部分文档，避免调用方拿着坏 body 去执行。
 */
// 用 resolve 先转成绝对路径，后续读取与报错都用这个绝对路径。
// readTextFile 传入 maxBytes: SCRIPT_READ_MAX_BYTES（2 MiB）作为硬上限。
// script.truncated 为真时直接 throw，不返回被截断的部分文档。
// hash 取 stableHash(script.content) 对整份原文做 sha256，body 不参与。
export async function readWorkflowScriptDocument(input: {
  fileSystemPort: FileSystemPort;
  scriptPath: string;
  traceContext: TraceContext;
}): Promise<WorkflowScriptDocument> {
  const scriptPath = resolve(input.scriptPath);
  const script = await input.fileSystemPort.readTextFile({
    maxBytes: SCRIPT_READ_MAX_BYTES,
    path: scriptPath,
    trace: input.traceContext,
  });
  if (script.truncated) {
    throw new Error(`Workflow script is too large: ${scriptPath}`);
  }
  const parts = extractWorkflowScriptParts(script.content);
  const expression = parts.metaExpression;
  const rawMeta = await evaluateMetaExpression(expression);
  const meta = WorkflowScriptMetaSchema.parse(rawMeta);
  return {
    body: parts.body,
    content: script.content,
    hash: stableHash(script.content),
    meta,
    path: scriptPath,
  };
}

/**
 * 内容身份 hash：字符串直接摘要；对象先做稳定序列化（键排序、数组保序）再 sha256。
 * 用于脚本 / args / 缓存键——同一语义内容必须得到同一 hash，不依赖运行时键插入顺序。
 */
// string 分支直接取原值摘要，不走 stableStringify。
// 对象分支先经 stableStringify 稳定序列化，再交给 createHash。
// stableStringify 对 Object.keys 排序、对 Array 保持原序。
// 同一语义内容必须得到同一 hash，不依赖运行时键插入顺序。
export function stableHash(value: unknown): string {
  const content = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(content).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractWorkflowScriptParts(source: string): {
  body: string;
  metaExpression: string;
} {
  const match = META_EXPORT_PATTERN.exec(source);
  if (!match) {
    throw new Error("Workflow script must begin with `export const meta = {...}`.");
  }
  let index = match.index + match[0].length;
  while (/\s/.test(source[index] ?? "")) index += 1;
  if (source[index] !== "{") {
    throw new Error("Workflow meta must be an object literal.");
  }

  const end = findObjectLiteralEnd(source, index);
  let bodyStart = end + 1;
  while (/\s/.test(source[bodyStart] ?? "")) bodyStart += 1;
  // 吃掉对象字面量后的可选分号，body 从下一条语句开始；meta 表达式单独切出供子进程求值。
  if (source[bodyStart] === ";") bodyStart += 1;
  return {
    body: source.slice(bodyStart).trimStart(),
    metaExpression: source.slice(index, end + 1),
  };
}

// evaluateMetaExpression 通过 spawn 把 expression 作为 --eval 参数交给子进程，不拼接源码字符串。
// 超时后 setTimeout 回调调用 child.kill()，子进程被立即终止。
// outputBytes 超过 MAX_META_EVAL_OUTPUT_BYTES 后，后续 chunk 不再 push。
async function evaluateMetaExpression(expression: string): Promise<unknown> {
  // 用独立 `--input-type=module --eval` 子进程求值，而不是宿主内 eval：meta 可以调用任意 JS
  // 构造常量，但宿主不能因此被污染；5 s 超时 + 1 MiB 输出上限封住失控脚本。
  const child = spawn(process.execPath, ["--input-type=module", "--eval", META_EVAL_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let outputBytes = 0;

  const timeout = setTimeout(() => child.kill(), META_EVAL_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes <= MAX_META_EVAL_OUTPUT_BYTES) output.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors.push(chunk);
  });
  child.stdin.end(JSON.stringify({ expression }));

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  });
  clearTimeout(timeout);

  const stdout = Buffer.concat(output).toString("utf8");
  const stderr = Buffer.concat(errors).toString("utf8").trim();
  if (exitCode !== 0) {
    throw new Error(stderr || `Workflow meta evaluation failed with exit code ${exitCode}`);
  }
  const result = JSON.parse(stdout) as { error?: string; ok: boolean; value?: unknown };
  if (!result.ok) throw new Error(result.error || "Workflow meta evaluation failed");
  return result.value;
}

function findObjectLiteralEnd(source: string, start: number): number {
  // 手写扫描器而不是正则：必须跳过字符串 / 行注释 / 块注释里的花括号，否则 meta 里的
  // `"{"` 或注释就能让括号深度失真；模板字符串按同类字符串处理（不求值插值）。
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === "`") {
      index = scanString(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = scanLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = scanBlockComment(source, index + 2);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Workflow meta object literal is not closed.");
}

function scanString(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  throw new Error("Workflow meta string literal is not closed.");
}

function scanLineComment(source: string, start: number): number {
  const index = source.indexOf("\n", start);
  return index === -1 ? source.length - 1 : index;
}

function scanBlockComment(source: string, start: number): number {
  const index = source.indexOf("*/", start);
  if (index === -1) throw new Error("Workflow meta block comment is not closed.");
  return index + 1;
}

const META_EVAL_SOURCE = `
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const { expression } = JSON.parse(input);
  const value = (0, eval)(\`(\${expression})\`);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}
`;
