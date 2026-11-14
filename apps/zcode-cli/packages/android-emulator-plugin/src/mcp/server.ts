#!/usr/bin/env node
// INV-01 仅暴露工具注册层：守住位置 各 provider 调用；改错故障 业务逻辑回流入口文件。
// INV-02 每个 handler 都过守卫：守住位置 注册回调；改错故障 异常打断 MCP 连接。
// INV-03 异常只保留消息：守住位置 守卫分支；改错故障 堆栈与内部路径泄露给模型。
// INV-04 非 Error 统一字符串化：守住位置 兜底分支；改错故障 抛出物变成未定义文案。
// INV-05 设备参数三件套：守住位置 共享对象；改错故障 各工具参数语义漂移。
// INV-06 启动参数不复用：守住位置 独立对象；改错故障 误把 serial 当成新开模拟器。
// INV-07 构建参数可覆盖：守住位置 合并对象；改错故障 调用方被迫硬编码模块名。
// INV-08 服务名即命名空间：守住位置 实例构造；改错故障 宿主侧工具命名冲突。
// INV-09 只读工具不写盘：守住位置 预检与发现；改错故障 探测动作产生副作用。
// INV-10 写盘工具声明覆盖位：守住位置 创建工具；改错故障 存量文件被静默覆盖。
// INV-11 组合流程失败即停：守住位置 构建并运行；改错故障 失败后继续安装旧产物。
// INV-12 停止模拟器 serial 必填：守住位置 输入 schema；改错故障 误杀真实设备。
// INV-13 打开链接限长：守住位置 长度上限；改错故障 超长输入撑爆设备命令。
// INV-14 截图走图像内容：守住位置 返回构造；改错故障 大图以文本回灌模型上下文。
// INV-15 日志双预算分离：守住位置 行数与字符数；改错故障 两个上限互相顶替。
// INV-16 解析失败不猜坐标：守住位置 UI 解析；改错故障 点击落到错误控件。
// INV-17 按键集合固定：守住位置 枚举声明；改错故障 任意输入事件可注入。
// INV-18 入口阻塞在传输层：守住位置 main；改错故障 进程提前退出导致宿主失联。
//
// 模块职责：注册 Android 工具集，声明参数 schema 并包装结果。
// 状态所有权：无状态；设备与工程状态都在 provider 与外部进程。
// 阅读顺序：先看共享参数，再看服务实例与工具注册，最后看错误守卫。
/**
 * Android 模拟器 MCP 服务入口：向 MCP 客户端暴露 Android 工具集（预检、项目发现/创建、构建、设备与 AVD 管理、
 * 安装/启动/停止应用、截图、日志、UI 自动化），并统一把异常转换为 isError 结果。
 *
 * 职责边界：只做工具注册、参数 schema 声明与结果包装，不做业务实现；具体能力全部落在 providers/*。
 * 副作用：工具被调用后会真实启动子进程、写盘（APK/截图/生成项目）或操作设备，属于强副作用工具集。
 * 失败语义：所有 handler 经 guard 包裹，异常转为 fail() 文本结果，不让异常打断 MCP 连接。
 * 传输方式：仅 stdio，入口为 main()，由宿主进程按 MCP 协议拉起。
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { json, fail, image } from "../lib/result.js";
import { preflight } from "../providers/preflight.js";
import { discover, create } from "../providers/project.js";
import { buildApp, buildAndRun } from "../providers/build.js";
import { listDevices } from "../providers/device.js";
import { createAvd, listAvds, startEmulator, stopEmulator } from "../providers/avd.js";
import { install, launch, openUrl, terminate } from "../providers/app.js";
import { shot } from "../providers/screenshot.js";
import { logs } from "../providers/logs.js";
import * as ui from "../providers/ui.js";

/**
 * 通用目标设备参数：serial 缺省时交给 provider 选择就绪设备或按需启动模拟器；
 * avd 只在需要新建模拟器时生效；timeoutMs 透传到外层操作等待，不约束单条 adb 命令。
 * 本对象被十余个工具以 {...target} 复用，增删字段会同时改变这些工具的入参，改前先核对 providers 的消费点。
 */
const target = {
  serial: z
    .string()
    .optional()
    .describe(
      "Android device or emulator serial number. When omitted, the plugin uses a ready device/emulator or starts one when needed.",
    ),
  avd: z
    .string()
    .optional()
    .describe("Android Virtual Device name, used when an emulator needs to be started."),
  timeoutMs: z.number().int().positive().optional().describe("Operation timeout in milliseconds."),
};

/**
 * 启动模拟器参数：只允许指定 AVD 名与启动等待超时，不复用既有设备参数，
 * 因为该工具语义是「新开一个 GUI 模拟器」，复用设备应把 serial 传给其它工具。
 */
const emulatorStart = {
  avd: z.string().optional().describe("Android Virtual Device name to start."),
  timeoutMs: z.number().int().positive().optional().describe("Startup timeout in milliseconds."),
};

/**
 * 构建类工具共享参数：在 target 之上追加 projectDir；module/variant/applicationId 留空时由 provider
 * 按 Gradle 项目实际发现结果补齐，避免调用方硬编码模块名。android_build_and_run 还会在此之上追加启动参数。
 */
const build = {
  ...target,
  projectDir: z.string().optional().describe("Android Gradle project root as a relative path."),
  module: z.string().optional().describe("Gradle module. Defaults to the discovered app module."),
  variant: z.string().optional().describe("Build variant. Defaults to debug."),
  applicationId: z
    .string()
    .optional()
    .describe("applicationId override to use when automatic discovery cannot resolve the app ID."),
};

/**
 * MCP 服务实例：名称与版本即客户端看到的插件标识，改动会影响宿主侧的工具命名空间，需同步文档。
 */
const server = new McpServer({
  name: "android-emulator",
  version: "0.1.0",
});

// 环境自检：只读探测 SDK/adb/emulator/Java/Gradle 与 UI 自动化后端，不修改系统状态。
server.registerTool(
  "android_preflight",
  {
    title: "Android Preflight",
    description:
      "Check whether the Android SDK, adb, emulator, AVDs, Java, Gradle project state, and ADB/UI Automator automation are available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await preflight())),
);

// 只读发现 Gradle 根、模块、variant、applicationId 与 APK 输出位置；找不到时由 provider 返回降级信息。
server.registerTool(
  "android_discover_project",
  {
    title: "Discover Android Project",
    description:
      "Find the Gradle root, modules, variants, app ID, manifest, and APK outputs in the current project.",
    inputSchema: {},
  },
  async () => guard(async () => json(await discover())),
);

// 在工作区生成最小 Kotlin + Compose 工程，属于写盘操作；overwrite=false 时不得覆盖已有文件。
server.registerTool(
  "android_create_app",
  {
    title: "Create Android App",
    description:
      "Create a minimal Kotlin and Jetpack Compose Android app in the current workspace.",
    inputSchema: {
      name: z.string().min(1),
      packageName: z.string().optional(),
      dir: z.string().optional(),
      minSdk: z.number().int().positive().optional(),
      compileSdk: z.number().int().positive().optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace existing generated files. Defaults to false."),
    },
  },
  async (args) => guard(async () => json(await create(args))),
);

// 调用 Gradle 构建 APK，耗时可达数分钟；失败时返回构建日志摘要而非抛出异常。
server.registerTool(
  "android_build_app",
  {
    title: "Build Android App",
    description: "Build the current or specified Android Gradle project.",
    inputSchema: build,
  },
  async (args) => guard(async () => json(await buildApp(args))),
);

// 构建 + 复用/启动设备 + 安装 + 启动的组合流程，是最重的一步；任一步失败即中止并返回该步上下文。
server.registerTool(
  "android_build_and_run",
  {
    title: "Build and Run Android App",
    description:
      "Build the Android app, reuse a ready device/emulator or start a GUI emulator on demand, then install and launch the app.",
    inputSchema: {
      ...build,
      launchActivity: z.string().optional(),
    },
  },
  async (args) => guard(async () => json(await buildAndRun(args))),
);

// 只读列出 adb 可见设备（含 offline/unauthorized 状态），由 provider 归一化状态字段。
server.registerTool(
  "android_list_devices",
  {
    title: "List Android Devices",
    description: "List devices and emulators visible to adb.",
    inputSchema: {},
  },
  async () => guard(async () => json(await listDevices())),
);

// 只读查询 emulator -list-avds 结果，不启动也不修改 AVD。
server.registerTool(
  "android_list_avds",
  {
    title: "List Android Emulators",
    description: "List Android Virtual Devices visible to the emulator command.",
    inputSchema: {},
  },
  async () => guard(async () => json(await listAvds())),
);

// 以 GUI 模式拉起模拟器并等待进入可用状态，属于长耗时副作用操作；已有设备请勿重复调用。
server.registerTool(
  "android_start_emulator",
  {
    title: "Start Android Emulator",
    description:
      "Start a new GUI Android emulator for the specified AVD. To reuse an existing device or emulator, pass its serial to build, install, launch, screenshot, log, or UI tools.",
    inputSchema: emulatorStart,
  },
  async (args) => guard(async () => json(await startEmulator(args))),
);

// 按 serial 停止模拟器，serial 必填以避免误杀真实设备；失败信息原样返回。
server.registerTool(
  "android_stop_emulator",
  {
    title: "Stop Android Emulator",
    description: "Stop the selected Android emulator by serial number.",
    inputSchema: {
      serial: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await stopEmulator(args))),
);

// 通过 avdmanager 创建 AVD；会触发 SDK 包与 license 检查，缺少系统镜像时由 provider 返回可操作提示。
server.registerTool(
  "android_create_avd",
  {
    title: "Create Android Emulator",
    description:
      "Create an Android Virtual Device with avdmanager. Confirm SDK package and license configuration with the user first.",
    inputSchema: {
      name: z.string().optional(),
      packageId: z.string().optional(),
      device: z.string().optional(),
      force: z.boolean().optional(),
    },
  },
  async (args) => guard(async () => json(await createAvd(args))),
);

// 通过 adb install 安装 APK，会改变设备已装应用状态；apkPath 需为可访问的本地文件。
server.registerTool(
  "android_install_app",
  {
    title: "Install Android App",
    description: "Install an APK on the selected Android device or emulator.",
    inputSchema: {
      ...target,
      apkPath: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await install(args))),
);

// 以 am start 拉起指定 applicationId；activity 缺省时由 provider 解析 launcher activity。
server.registerTool(
  "android_launch_app",
  {
    title: "Launch Android App",
    description: "Launch an installed Android app by application ID.",
    inputSchema: {
      ...target,
      applicationId: z.string().min(1),
      activity: z.string().optional(),
    },
  },
  async (args) => guard(async () => json(await launch(args))),
);

// 强制停止应用（am force-stop），会丢弃应用运行态，不清理已安装数据。
server.registerTool(
  "android_terminate_app",
  {
    title: "Stop Android App",
    description: "Force-stop an installed Android app by application ID.",
    inputSchema: {
      ...target,
      applicationId: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await terminate(args))),
);

// 在设备浏览器中打开 URL（长度上限 2048），会离开当前前台应用。
server.registerTool(
  "android_open_url",
  {
    title: "Open URL on Android",
    description: "Open a URL on the selected Android device or emulator.",
    inputSchema: {
      ...target,
      url: z.string().min(1).max(2048),
    },
  },
  async (args) => guard(async () => json(await openUrl(args))),
);

// 截图并直接以 image content 返回：文本只带 device/path/bytes 元数据，图像走 base64；
// provider 会把临时 PNG 落盘，调用方可凭 path 复用，避免重复截图。
server.registerTool(
  "android_screenshot",
  {
    title: "Capture Android Screen",
    description:
      "Capture a PNG screenshot from the selected Android device or emulator and return it as MCP image content.",
    inputSchema: {
      ...target,
      path: z.string().optional(),
    },
  },
  async (args) =>
    guard(async () => {
      const pic = await shot(args);
      return image({ device: pic.device, path: pic.path, bytes: pic.bytes }, pic.data);
    }),
);

// 读取 logcat 尾部；lines 控制设备侧取多少行，limit 控制返回给模型的字符预算，二者不可混用。
server.registerTool(
  "android_logs",
  {
    title: "Read Android Logs",
    description: "Read recent logcat output, optionally filtered by application ID.",
    inputSchema: {
      ...target,
      applicationId: z.string().optional(),
      lines: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await logs(args))),
);

// 探测 UI Automator/adb 输入后端是否可用，只读，不影响设备。
server.registerTool(
  "android_ui_status",
  {
    title: "Android UI Backend Status",
    description: "Report whether the Android UI automation backend is available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await ui.status())),
);

// 导出精简 UI 元素树（文本/描述/id/类名/坐标），供模型先看结构再决定点击目标。
server.registerTool(
  "android_ui_describe",
  {
    title: "Describe Android UI",
    description: "Return a compact UI Automator element tree for the current Android screen.",
    inputSchema: target,
  },
  async (args) => guard(async () => json(await ui.describe(args))),
);

// 把文本/描述/resource id/类名查询解析为屏幕坐标；解析不到时返回失败而非猜坐标。
server.registerTool(
  "android_ui_resolve",
  {
    title: "Resolve Android UI Element",
    description:
      "Resolve a text, content description, resource id, or class query to screen coordinates.",
    inputSchema: {
      ...target,
      query: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await ui.resolve(args))),
);

// 按绝对坐标点击，会改变设备 UI 状态；坐标应在 describe/resolve 得到的屏幕范围内。
server.registerTool(
  "android_ui_tap",
  {
    title: "Tap Android Emulator",
    description: "Tap screen coordinates using Android UI automation.",
    inputSchema: {
      ...target,
      x: z.number(),
      y: z.number(),
    },
  },
  async (args) => guard(async () => json(await ui.tap(args))),
);

// 从 (x1,y1) 滑到 (x2,y2)，durationMs 缺省由 provider 采用平稳滑动默认值。
server.registerTool(
  "android_ui_swipe",
  {
    title: "Swipe Android Emulator",
    description: "Swipe between screen coordinates using Android UI automation.",
    inputSchema: {
      ...target,
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      durationMs: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.swipe(args))),
);

// 向当前焦点控件输入文本；不会自动聚焦，调用方应先 tap 目标输入框。
server.registerTool(
  "android_ui_type_text",
  {
    title: "Type Text on Android",
    description: "Enter text into the currently focused Android control.",
    inputSchema: {
      ...target,
      text: z.string(),
    },
  },
  async (args) => guard(async () => json(await ui.typeText(args))),
);

// 发送固定集合的系统按键，枚举受 schema 限制，避免任意输入事件注入。
server.registerTool(
  "android_ui_keyevent",
  {
    title: "Press Android Key",
    description:
      "Press BACK, HOME, ENTER, APP_SWITCH, MENU, or SEARCH on the selected Android device.",
    inputSchema: {
      ...target,
      key: z.enum(["BACK", "HOME", "ENTER", "APP_SWITCH", "MENU", "SEARCH"]),
    },
  },
  async (args) => guard(async () => json(await ui.keyevent(args))),
);

/**
 * 启动 stdio MCP 服务并阻塞在传输层事件循环。
 *
 * 由宿主进程作为子进程拉起；本函数不返回，直到连接关闭或进程被终止。
 * 失败语义：端口/传输初始化失败会抛出，导致进程退出，由宿主侧看到非零退出码。
 */
export async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main();
}

/**
 * 工具执行守卫：把任意异常转成 isError 结果。
 *
 * 这是工具层唯一的错误收敛点，保证 provider 内部抛出的 fs/子进程/schema 错误不会打断 MCP 会话；
 * 只保留 message（不含堆栈），避免把内部路径与实现细节泄露给模型；Error 之外的抛出物统一 String 化。
 */
async function guard(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
