/**
 * adb 设备与 shell 能力：列举设备、选择目标、执行设备侧 shell 命令、判断 boot 状态。
 *
 * 职责边界：只封装 adb 的设备查询与 shell 调用；模拟器启动/AVD 管理在 avd.ts，应用操作在 app.ts。
 * 副作用：listDevices 会拉起 adb（可能触发 adb server 启动）；adbShell 会在设备上执行任意传入命令。
 * 失败语义：命令非零退出/超时抛 Error(brief)；isBootComplete 把失败降级为 false，避免启动轮询被单次错误打断。
 * 安全约束：serial 与 shell 参数都必须经过白名单/引号处理，防止值被解释成额外参数或 shell 语法。
 * 跨平台：adb 可执行文件由 sdk.ts 解析（Windows 带 .exe），本文件不硬编码路径。
 */
import { brief, ok, run } from "../lib/run.js";
import { androidEnv, requireTool } from "./sdk.js";

/**
 * adb devices -l 的单条设备信息。
 * kind 由 serial 前缀推导（emulator- 开头视为模拟器），model/product/device 可能缺失；
 * raw 保留原始行，便于错误信息与调试时对照 adb 真实输出。
 */
export type Device = {
  serial: string;
  state: string;
  kind: "emulator" | "device";
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  raw: string;
};

// serial 白名单：仅允许字母数字与 . _ : -，覆盖 emulator-5554、IP:port 与真机序列号形态。
const SERIAL = /^[A-Za-z0-9._:-]+$/;
// 设备侧 shell 安全 token：不含空白与 shell 元字符的参数可原样传递，减少不必要的引号。
const SAFE_DEVICE_SHELL_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * 校验 adb serial 是否可安全地作为 -s 参数。
 * 返回布尔值而不抛错，供调用方选择报错或跳过。
 */
export function validSerial(serial: string): boolean {
  return SERIAL.test(serial);
}

/**
 * 列出 adb 可见的全部设备（含 offline/unauthorized）。
 *
 * 副作用：调用 adb devices -l，必要时 adb 会拉起本地 server；只读设备状态。
 * 失败语义：adb 缺失、命令失败或超时抛 Error(brief)，调用方需自行决定是否降级为空列表。
 */
export async function listDevices(): Promise<Device[]> {
  const adb = await requireTool("adb");
  const out = await run([adb, "devices", "-l"], { timeout: 20_000, env: await androidEnv() });
  if (!ok(out)) throw new Error(brief(out));
  return parseAdbDevices(out.stdout);
}

/**
 * 解析 adb devices -l 的文本输出。
 *
 * 兼容 CRLF/LF；跳过标题行与空行。每行格式为 serial state key:value...，
 * key:value 用首个冒号切分，兼顾 model:Pixel_7 这类含下划线但无冒号的值。
 * 纯函数、无副作用；kind 仅按前缀推断，不发起额外查询。
 */
export function parseAdbDevices(value: string): Device[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0] ?? "";
      const state = parts[1] ?? "unknown";
      const attrs = new Map<string, string>();
      for (const part of parts.slice(2)) {
        const split = part.indexOf(":");
        if (split > 0) attrs.set(part.slice(0, split), part.slice(split + 1));
      }
      return {
        serial,
        state,
        kind: serial.startsWith("emulator-") ? "emulator" : "device",
        model: attrs.get("model"),
        product: attrs.get("product"),
        device: attrs.get("device"),
        transportId: attrs.get("transport_id"),
        raw: line,
      } satisfies Device;
    })
    .filter((item) => item.serial.length > 0);
}

/**
 * 选择目标设备。
 *
 * 指定 serial 时要求存在且 state=device，否则抛出带原因的错误（未找到/未就绪），便于用户区分；
 * 未指定时优先模拟器，其次任意在线设备，保证开发场景优先落到可重启、可截图的模拟器上。
 * 副作用：读取 adb 设备列表；无匹配时抛错而不是返回 undefined。
 */
export async function pickDevice(input: { serial?: string } = {}): Promise<Device> {
  const devices = await listDevices();
  if (input.serial) {
    if (!validSerial(input.serial))
      throw new Error(`Invalid Android device serial: ${input.serial}`);
    const hit = devices.find((item) => item.serial === input.serial);
    if (!hit) throw new Error(`Android device not found: ${input.serial}`);
    if (hit.state !== "device")
      throw new Error(`Android device is not ready: ${input.serial} (${hit.state})`);
    return hit;
  }
  const online = devices.filter((item) => item.state === "device");
  const emulator = online.find((item) => item.kind === "emulator");
  if (emulator) return emulator;
  const first = online[0];
  if (first) return first;
  throw new Error("No ready Android device or emulator found.");
}

/**
 * 在指定设备上执行 adb shell 命令。
 *
 * args 按设备侧 shell 规则逐项加引号后拼接成单条命令（adb shell 只接受一个命令字符串）；
 * 副作用：在设备上真实执行命令，可能改变设备状态。
 * 失败语义：serial 非法、adb 缺失、命令非零退出或超时都会抛 Error，调用方需自行处理；
 * 返回完整 Run，便于调用方读取 stdout（如 getprop）。
 */
export async function adbShell(serial: string, args: string[], timeout = 30_000) {
  if (!validSerial(serial)) throw new Error(`Invalid Android device serial: ${serial}`);
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", serial, "shell", adbShellCommand(args)], {
    timeout,
    env: await androidEnv(),
  });
  if (!ok(out)) throw new Error(brief(out));
  return out;
}

/**
 * 把 argv 数组拼成设备侧 shell 能安全执行的单条命令字符串。
 *
 * 空参数抛错，避免拼出残缺命令；每个参数按需单引号包裹并转义内部单引号（POSIX 设备 shell 规则）。
 */
export function adbShellCommand(args: string[]): string {
  if (args.length === 0) throw new Error("Missing adb shell command.");
  return args.map(deviceShellQuote).join(" ");
}

/**
 * 判断设备是否已完成 boot（sys.boot_completed == 1）。
 *
 * 查询失败（设备刚出现、adb 短暂不可用、命令超时）一律降级为 false，让调用方继续轮询，
 * 而不是把一次瞬时故障当成「启动失败」终止整个等待流程。
 */
export async function isBootComplete(serial: string): Promise<boolean> {
  const out = await adbShell(serial, ["getprop", "sys.boot_completed"], 10_000).catch(
    () => undefined,
  );
  return out?.stdout.trim() === "1";
}

/**
 * 为设备侧 POSIX shell 转义单个参数：安全字符原样返回，否则单引号包裹，
 * 内部单引号用 '\'' 形式拼接，确保参数不会被解释为命令分隔符或重定向。
 */
function deviceShellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (SAFE_DEVICE_SHELL_TOKEN.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
