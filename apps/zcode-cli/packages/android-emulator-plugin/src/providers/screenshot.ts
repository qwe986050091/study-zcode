/**
 * 截图能力：通过 adb exec-out screencap -p 抓取 PNG，落盘后以 base64 返回给 MCP。
 *
 * 职责边界：只负责取图、存图与编码；设备选择交给 ensureDevice，UI 元素解析在 ui.ts。
 * 副作用：启动 adb 子进程、写 PNG 文件（默认写插件数据目录 screenshots/）。
 * 失败语义：screencap 非零退出/超时/启动失败都会抛 Error，并优先带 stderr，便于区分权限与设备离线问题。
 * 口径：返回 path 为相对 cwd 的路径，bytes 为原始字节数，data 为 base64（供 MCP image content 使用）。
 * 注意：PNG 二进制不能走 run() 的文本收集，这里单独用 Buffer 管道，避免编码损坏。
 */
import { spawn as spawnChild } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { data, inside, rel } from "../lib/path.js";
import { ensureDevice } from "./avd.js";
import { androidEnv, requireTool } from "./sdk.js";

/**
 * 截图入参：path 给定时必须位于工作区内（经 inside 校验），否则写入插件数据目录；
 * timeoutMs 约束单次 screencap。
 */
type Shot = {
  serial?: string;
  avd?: string;
  path?: string;
  timeoutMs?: number;
};

/**
 * 抓取目标设备屏幕并保存为 PNG。
 *
 * 流程：ensureDevice 选设备 → 决定输出路径（用户指定或默认临时目录）→ screencap 取字节 → 写盘。
 * 副作用：写文件并拉起 adb；文件已存在时会被覆盖。
 * 失败语义：路径越界抛 Error（来自 inside）；screencap 失败/超时抛 Error；写盘失败抛出原始 fs 错误。
 * 不变式：先拿到截图字节再写盘，避免失败时留下 0 字节图片误导调用方。
 */
export async function shot(input: Shot = {}) {
  const device = await ensureDevice(input);
  const file = input.path
    ? inside(process.cwd(), input.path)
    : path.join(await data("screenshots"), `${stamp()}-${device.serial}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = await screencap(device.serial, input.timeoutMs ?? 30_000);
  await writeFile(file, bytes);
  return {
    device,
    path: rel(file),
    bytes: bytes.byteLength,
    data: Buffer.from(bytes).toString("base64"),
  };
}

/**
 * 执行 screencap 并返回 PNG 原始字节。
 *
 * 用 exec-out 而不是 shell，避免换行/编码转换污染二进制；stdout 按 Buffer 收集，stderr 单独转文本。
 * 副作用：仅读取设备画面。失败语义：超时发 SIGTERM 并置 timed，随后统一抛错；
 * 启动失败映射为 127；错误信息优先使用 stderr，空时给出退出码/超时说明。
 */
async function screencap(serial: string, timeoutMs: number): Promise<Buffer> {
  const adb = await requireTool("adb");
  const env = await androidEnv();
  const child = spawnChild(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (item): item is [string, string] => typeof item[1] === "string",
      ),
    ),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timed = false;
  let spawnError: Error | undefined;
  const timer = setTimeout(() => {
    timed = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const out = collectBuffer(child.stdout);
  const err = collectText(child.stderr);
  const code = await new Promise<number>((resolve) => {
    let settled = false;
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exitCode);
    };
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
      settle(127);
    });
    child.once("close", (exitCode) => settle(exitCode ?? 1));
  });
  // 二进制场景不能只看退出码：超时被杀时也可能收到部分数据，必须把 timed 一并视为失败。
  if (code !== 0 || timed) {
    const stderr = [await err, spawnError?.message].filter(Boolean).join("\n").trim();
    throw new Error(stderr || `screencap failed with exit ${code}${timed ? " after timeout" : ""}`);
  }
  return out;
}

/**
 * 把可读流完整收集为 Buffer，用于接收 PNG 二进制。
 * 不做 utf8 解码，避免破坏图像字节；stream 为空时返回空 Buffer。
 */
async function collectBuffer(stream: NodeJS.ReadableStream | null): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

/**
 * 把可读流收集为 utf8 文本，仅用于 stderr 错误信息。
 */
async function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
  return (await collectBuffer(stream)).toString("utf8");
}

/**
 * 生成默认截图文件名的时间戳部分；替换冒号与点以兼容 Windows 文件名规则。
 */
function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}
