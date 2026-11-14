/**
 * 环境预检：汇总宿主系统、SDK、命令行工具、Java、Gradle、模拟器加速、AVD 与 adb 设备的可用性。
 *
 * 职责边界：只做只读探测与结论生成，不安装工具、不创建 AVD、不启动模拟器。
 * 副作用：会执行 adb/emulator/sdkmanager/java 等探测命令，可能触发 adb server，但不改变项目与设备。
 * 失败语义：单个探测失败被降级为一条 ok=false 的 check，不让整体抛错；
 * 最终 ok 由 preflightOk 汇总，某些缺失项在已有就绪设备时可豁免。
 * 返回口径：{ ok, backend, checks }，checks 每项含 name/ok/detail/fix，fix 用于指导用户补齐环境。
 */
import path from "node:path";
import { brief, ok, run } from "../lib/run.js";
import { listAvds } from "./avd.js";
import {
  androidApiLevel,
  androidBuildToolsVersion,
  androidSystemImageAbi,
  androidSystemImageVariant,
  javaMajorVersion,
} from "./config.js";
import { type Device, listDevices } from "./device.js";
import { discover } from "./project.js";
import { androidEnv, checkTool, findTool, javaHome, sdkRoot } from "./sdk.js";

/**
 * 单条预检结果。
 * name 作为稳定标识被豁免逻辑引用，不宜随文案改动；detail 是证据（路径/版本/错误），fix 是修复建议。
 */
export type Check = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
};

const ADB_DEVICES_CHECK = "ADB devices";
// 这些检查项只与「新建模拟器」有关；已有就绪设备时缺失也不影响安装/启动/截图等主流程。
const READY_TARGET_OPTIONAL_CHECKS = new Set([
  "emulator",
  "avdmanager",
  "Android Virtual Devices",
  "Emulator acceleration",
]);

/**
 * 汇总预检是否整体通过。
 *
 * 规则：所有 check 必须 ok；ADB devices 检查永远豁免（它描述当前是否有设备，而非环境是否可用）；
 * 当已检测到就绪设备时，emulator/avdmanager/AVD/加速这几项也可豁免，因为可以复用现有设备继续工作。
 * 纯函数、无副作用。
 */
export function preflightOk(checks: Check[], input: { hasReadyTarget: boolean }): boolean {
  return checks.every(
    (item) =>
      item.ok ||
      item.name === ADB_DEVICES_CHECK ||
      (input.hasReadyTarget && READY_TARGET_OPTIONAL_CHECKS.has(item.name)),
  );
}

/**
 * 执行完整预检并返回结构化报告。
 *
 * 流程：宿主 OS → SDK 根目录 → 插件默认参数 → 四个命令行工具 → Java → Gradle → Windows 加速 → AVD → adb 设备。
 * 副作用：运行多个只读探测子进程；对 SDK/工具缺失不抛错，而是记录 check。
 * 失败语义：AVD 与设备列表查询失败时把错误对象放进 detail（用 catch 转值），保证报告仍能返回；
 * 仅 sdkRoot/androidEnv 等基础解析异常会直接上抛。
 * 跨平台：Windows 额外做 emulator -accel-check（对应 WHPX/Hyper-V），macOS 无此步骤；java 可执行名按平台区分。
 */
export async function preflight() {
  const checks: Check[] = [];
  // 该插件依赖桌面版模拟器能力，Linux 无官方 GUI 模拟器支持，因此直接判定不通过。
  checks.push({
    name: "Host OS",
    ok: process.platform === "darwin" || process.platform === "win32",
    detail: process.platform,
    fix: "Run this plugin on macOS or Windows for the desktop Android Emulator workflow.",
  });

  const root = await sdkRoot();
  checks.push({
    name: "Android SDK root",
    ok: Boolean(root),
    detail: root || "not found",
    fix: "Install Android Studio or set ANDROID_HOME/ANDROID_SDK_ROOT/ANDROID_PLUGIN_SDK_PATH.",
  });
  checks.push({
    name: "Android plugin defaults",
    ok: true,
    detail: [
      `apiLevel=${androidApiLevel()}`,
      `buildTools=${androidBuildToolsVersion()}`,
      `systemImage=${androidSystemImageVariant()}/${androidSystemImageAbi()}`,
      `jdkMajor=${javaMajorVersion()}`,
    ].join("\n"),
  });

  for (const item of [
    ["adb", ["version"]],
    ["emulator", ["-version"]],
    ["sdkmanager", ["--version"]],
    ["avdmanager", ["list", "avd"]],
  ] as const) {
    const check = await checkTool(item[0], [...item[1]]);
    checks.push({
      name: item[0],
      ok: check.ok,
      detail: check.path ? `${check.path}\n${check.detail}` : check.detail,
      fix: `Install Android SDK ${item[0]} support with Android Studio SDK Manager or command-line tools.`,
    });
  }

  const env = await androidEnv();
  const home = await javaHome();
  const javaCmd = home
    ? path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  const java = await run([javaCmd, "-version"], { timeout: 10_000, env });
  checks.push({
    name: "Java",
    ok: ok(java),
    detail: home
      ? `${home}\n${brief(java, 1000) || "available"}`
      : brief(java, 1000) || "not found",
    fix: "Install a JDK compatible with the Android Gradle Plugin.",
  });

  const project = await discover().catch(() => undefined);
  const gradle = await findTool("gradle");
  checks.push({
    name: "Gradle",
    ok: Boolean(project?.hasWrapper || gradle),
    detail: project?.hasWrapper
      ? "Gradle wrapper found"
      : gradle
        ? `gradle at ${gradle}`
        : "not found",
    fix: "Install Gradle or generate a Gradle wrapper in the Android project root.",
  });

  const emulator = await findTool("emulator");
  // 加速检查只在 Windows 有意义（WHPX/Hyper-V），且 emulator 缺失时无处可查，故双条件守卫。
  if (process.platform === "win32" && emulator) {
    const accel = await run([emulator, "-accel-check"], { timeout: 10_000, env });
    checks.push({
      name: "Emulator acceleration",
      ok: ok(accel),
      detail: brief(accel, 1000) || "available",
      fix: "Enable CPU virtualization/WHPX or finish Android Emulator driver setup in Android Studio Device Manager.",
    });
  }

  // 用 catch 把异常转成值：探测失败要作为「检查未通过」的证据展示，而不是让整份报告失败。
  const avds = await listAvds().catch((err) => err);
  checks.push({
    name: "Android Virtual Devices",
    ok: Array.isArray(avds) && avds.length > 0,
    detail: Array.isArray(avds)
      ? `${avds.length} AVD(s): ${avds.map((item) => item.name).join(", ")}`
      : String(avds),
    fix:
      "Create an emulator in Android Studio Device Manager or call android_create_avd " +
      "only when no ready USB device target is available.",
  });

  // 同上：设备列表失败也要保留错误文本，并让 hasReadyTarget 为 false 参与豁免判断。
  const devices = await listDevices().catch((err) => err);
  const hasReadyTarget = readyDevices(devices).length > 0;
  checks.push({
    name: ADB_DEVICES_CHECK,
    ok: hasReadyTarget,
    detail: Array.isArray(devices)
      ? `${devices.length} device(s): ${devices.map((item) => `${item.serial}:${item.state}`).join(", ")}`
      : String(devices),
    fix: "Start an Android Emulator or connect a device with USB debugging enabled.",
  });

  return {
    ok: preflightOk(checks, { hasReadyTarget }),
    backend: "sdk",
    checks,
  };
}

/**
 * 从设备列表中筛出 state=device 的可用目标；非数组（探测失败）时返回空数组。
 */
function readyDevices(value: Device[] | unknown): Device[] {
  return Array.isArray(value) ? value.filter((item) => item.state === "device") : [];
}
