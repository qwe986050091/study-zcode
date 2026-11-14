/**
 * 应用生命周期能力：在已就绪设备上执行安装、启动、强制停止与打开 URL。
 *
 * 职责边界：只封装 adb shell / adb install 的参数与结果，不负责选设备（交给 ensureDevice），
 * 也不做 APK 构建和日志采集。
 * 副作用：每条操作都会真实改变设备状态（写入应用包、切换前台 Activity）。
 * 失败语义：安装类命令通过 ok() 判定，失败时抛 Error 且携带 brief 输出摘要；
 * 启动/停止/打开 URL 依赖 adbShell 自身的错误传播，失败由上层 guard 转为工具错误结果。
 * 输入约束：applicationId 与 URL 均按严格格式校验，避免把任意字符串拼进 adb 参数。
 */
import { inside } from "../lib/path.js";
import { brief, ok, run } from "../lib/run.js";
import { ensureDevice } from "./avd.js";
import { adbShell, validSerial } from "./device.js";
import { androidEnv, requireTool } from "./sdk.js";

/**
 * 目标设备与超时的通用入参。
 * serial 指定具体设备；avd 供 ensureDevice 在需要新起模拟器时使用；timeoutMs 透传到单条 adb 命令。
 */
type Target = {
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

/**
 * Android applicationId 校验：至少两段、每段以字母开头，只允许字母数字下划线。
 * 收紧格式是为了防止值被当作 adb shell 的额外参数，同时排除明显非法的包名。
 */
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * 安装 APK 到目标设备。
 *
 * 输入 apkPath 相对当前工作目录，会先经 inside() 限定在工作区内再转绝对路径，防止读取任意文件。
 * 副作用：调用 adb install -r，覆盖安装同签名应用并写入设备存储。
 * 失败语义：非零退出或超时统一抛 Error(brief 输出)，调用方得到命令上下文而非裸错误码。
 * 返回口径：只返回 installed/serial/apkPath/output，不承诺应用已启动。
 */
export async function install(input: Target & { apkPath: string }) {
  const device = await ensureDevice(input);
  const apk = inside(process.cwd(), input.apkPath);
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", device.serial, "install", "-r", apk], {
    timeout: input.timeoutMs ?? 120_000,
    env: await androidEnv(),
  });
  // 安装失败直接抛错，不返回半成功结构，避免上层误以为可以继续启动应用。
  if (!ok(out)) throw new Error(brief(out));
  return { installed: true, serial: device.serial, apkPath: input.apkPath, output: brief(out) };
}

/**
 * 启动已安装应用。
 *
 * 输入 activity 给定时用 am start -W 直接打开指定组件（可精确控制页面并等待启动完成）；
 * 未给定时回退到 monkey launcher intent，由系统解析默认入口，兼容不知道 Activity 名的场景。
 * 副作用：切换设备前台应用。失败语义：adbShell 抛错时原样上抛，不在此处吞掉。
 * 返回口径：launched=true 表示命令已被接受，不代表界面一定渲染成功。
 */
export async function launch(input: Target & { applicationId: string; activity?: string }) {
  const device = await ensureDevice(input);
  const app = packageName(input.applicationId);
  const out = input.activity
    ? await adbShell(
        device.serial,
        ["am", "start", "-W", "-n", `${app}/${input.activity}`],
        input.timeoutMs ?? 60_000,
      )
    : await adbShell(
        device.serial,
        ["monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"],
        input.timeoutMs ?? 60_000,
      );
  return { launched: true, serial: device.serial, applicationId: app, output: brief(out) };
}

/**
 * 强制停止应用（am force-stop）。
 *
 * 副作用：终止进程并清理运行态，但保留已安装数据与权限；不保证停止后不再被系统拉起。
 * 失败语义：adbShell 失败时抛错；超时默认 30 秒，比安装/启动更短，因为该命令本身很快。
 * 返回口径：terminated=true 仅表示命令执行完成。
 */
export async function terminate(input: Target & { applicationId: string }) {
  const device = await ensureDevice(input);
  const app = packageName(input.applicationId);
  await adbShell(device.serial, ["am", "force-stop", app], input.timeoutMs ?? 30_000);
  return { terminated: true, serial: device.serial, applicationId: app };
}

/**
 * 用系统 VIEW intent 在设备上打开 URL。
 *
 * URL 先经 url() 校验长度与 scheme，避免空串、超长串或相对路径被塞进 intent；
 * 副作用：可能切换到浏览器或目标 App，离开当前前台应用。
 * 失败语义：无浏览器/无处理器时 am start 失败，错误向上抛给工具层。
 */
export async function openUrl(input: Target & { url: string }) {
  const device = await ensureDevice(input);
  const value = url(input.url);
  await adbShell(
    device.serial,
    ["am", "start", "-a", "android.intent.action.VIEW", "-d", value],
    input.timeoutMs ?? 30_000,
  );
  return { opened: true, serial: device.serial, url: value };
}

/**
 * 校验 applicationId 并原样返回，供启动/停止等命令复用。
 * 非法时抛 Error，调用方应把它当作参数错误（而不是设备错误）呈现给用户。
 */
export function packageName(value: string): string {
  if (!PACKAGE.test(value)) throw new Error(`Invalid Android application id: ${value}`);
  return value;
}

/**
 * URL 校验：长度上限 2048，且必须带 scheme（如 https:、mailto:）。
 * 要求显式 scheme 是因为 am start -d 对无 scheme 字符串会失败，提前拦截可给出更清晰的错误。
 */
function url(value: string): string {
  if (value.length > 2048) throw new Error("URL is too long.");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw new Error(`Invalid URL: ${value}`);
  return value;
}
