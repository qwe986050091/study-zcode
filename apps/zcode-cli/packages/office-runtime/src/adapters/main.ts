// 插件服务端入口：组装文件适配器、解析器与文档所有者，然后通过 stdio 启动 MCP server。
// 边界：所有路径以 ZCODE_WORKSPACE_ROOT（缺省 cwd）为根；静态资源取自本文件旁的 ui/ 目录。
// 副作用：占用 stdin/stdout、注册 SIGTERM/SIGINT/stdin end 关闭钩子；启动失败直接向上抛给宿主。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OfficeError } from "#office/contract.ts";
import { createDocumentOwner } from "#office/app/documents.ts";
import { createWorkspaceFiles, createDocumentImporter } from "#office/adapters/files.ts";
import { createOfficeServer } from "#office/adapters/server.ts";
import { PARSERS } from "#office/adapters/parsers.ts";

// 官方插件宿主通过导出的 main 启动；导入时直接连接会被宿主判定为无效入口。
// 副作用：注册 SIGTERM/SIGINT/stdin end 的关闭钩子，并占用 stdio 传输直到 server 关闭。
// 失败时异常向上抛出，由宿主决定是否重试；资源目录与工作区根目录都由环境决定。
export async function main(): Promise<void> {
  const dist = dirname(fileURLToPath(import.meta.url));
  // 静态资源目录：构建产物旁的 ui 目录，pdf.js 的 cmaps 与标准字体也放在这里。
  const assetRoot = join(dist, "ui");
  // pdf.js 资源路径必须以斜杠结尾，否则 pdf.js 会拼接出错误 URL。
  const pdfAssets = {
    cMapUrl: `${join(assetRoot, "pdfjs/cmaps")}/`,
    standardFontDataUrl: `${join(assetRoot, "pdfjs/standard_fonts")}/`,
  };
  // 工作区根目录：优先取环境变量，其次为当前目录；所有路径校验都以它为边界。
  const workspace = process.env.ZCODE_WORKSPACE_ROOT || process.cwd();

  // 文档所有者：把工作区文件读取与格式解析组合成“打开/读取”能力，解析器缺失视为不支持类型。
  const owner = createDocumentOwner({
    files: createWorkspaceFiles(workspace),
    async parse(file) {
      const parse = PARSERS[file.kind];
      if (!parse) throw new OfficeError("unsupported_type", `Unsupported file: ${file.path}`);
      return parse(file.bytes, file.path, pdfAssets);
    },
  });

  // 清理失败只写 stderr：不能让残留导入文件阻断插件启动或退出。
  const reportCleanupError = (error: unknown) =>
    process.stderr.write(`Document import cleanup: ${String(error)}\n`);
  // 导入器：仅接收系统选择器的文件字节，导入副本落在工作区内供复用。
  const importer = createDocumentImporter(workspace, { onCleanupError: reportCleanupError });
  // 启动清扫失败已在内部吞掉，不会阻止后续连接。
  await importer.initialize();
  const server = createOfficeServer({ owner, assetRoot, importer });
  // stopping 保证关闭逻辑幂等：多个钩子同时触发时只执行一次。
  let stopping = false;
  // 关闭顺序：先停 server 再关 importer；importer 关闭失败不掩盖 server 的错误。
  async function close() {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      await importer.close();
    }
  }
  process.once("SIGTERM", () => void close().catch(reportCleanupError));
  process.once("SIGINT", () => void close().catch(reportCleanupError));
  process.stdin.once("end", () => void close().catch(reportCleanupError));
  await server.connect(new StdioServerTransport());
}

// 保留独立 Node 进程直接启动的用法。
// 仅当本文件是 argv[1] 指向的入口时自动运行；被宿主 import 时条件不成立，避免重复建立 stdio 连接。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
