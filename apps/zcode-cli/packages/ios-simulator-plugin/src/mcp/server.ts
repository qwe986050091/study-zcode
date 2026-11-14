#!/usr/bin/env node
// INV-01 参数 schema 必须声明相对路径语义：守住位置 target 与 build；改错故障 宿主传入绝对路径越界。
// INV-02 模拟器目标三者都可省略：守住位置 target 字段；改错故障 未给目标时无法使用默认设备。
// INV-03 构建参数默认使用插件数据目录：守住位置 derivedDataPath 描述；改错故障 污染用户 DerivedData。
// INV-04 服务名与版本是客户端可见身份：守住位置 McpServer 构造；改错故障 工具命名空间变化。
// INV-05 所有工具 handler 必须经 guard 包裹：守住位置 每个 registerTool；改错故障 异常打断 MCP 会话。
// INV-06 guard 只保留错误消息，不返回堆栈：守住位置 catch；改错故障 内部路径泄露给客户端。
// INV-07 非 Error 抛出物统一字符串化：守住位置 catch 分支；改错故障 客户端收到空错误。
// INV-08 只读工具不得隐式启动模拟器：守住位置 preflight/list/discover/status；改错故障 查询操作改变系统状态。
// INV-09 安装与启动类工具必须先确保模拟器可用：守住位置 boot 调用；改错故障 对关机设备执行安装。
// INV-10 启动与打开 URL 默认打开模拟器窗口：守住位置 open 参数；改错故障 用户看不到运行界面。
// INV-11 安装路径相对值必须限定在工作区内：守住位置 file 函数；改错故障 ../ 穿越读取任意目录。
// INV-12 安装路径绝对值原样放行：守住位置 isAbsolute 分支；改错故障 无法安装 DerivedData 产物。
// INV-13 硬件按钮只接受固定枚举：守住位置 z.enum；改错故障 任意字符串注入 idb。
// INV-14 URL 长度必须受限：守住位置 max(2048)；改错故障 超长输入进入模拟器。
// INV-15 截图同时返回元数据与图像内容：守住位置 image 调用；改错故障 模型只拿到路径无法看图。
// INV-16 日志查询的时间窗口与条数必须为正整数：守住位置 seconds 与 limit；改错故障 负值导致 provider 异常。
// INV-17 主入口只建立 stdio 传输并阻塞：守住位置 main；改错故障 额外副作用污染协议输出。
// INV-18 直接执行时才启动服务：守住位置 import.meta.main 判断；改错故障 被导入时也拉起传输。
//
// 模块职责：注册 iOS 模拟器 MCP 工具，声明参数 schema，并把结果或异常包装为协议结果。
// 状态所有权：工具实现全部在 providers；本文件只持有服务实例与 schema。
// 阅读顺序：先看共享 schema 与服务实例，再按工具分组读注册，最后看 main 与 guard。
/**
 * iOS 模拟器 MCP 服务入口：向 MCP 客户端暴露 iOS 工具集（预检、模拟器管理、工程发现/创建、构建安装运行、
 * 截图、日志与 idb UI 自动化），并统一把异常转换为 isError 结果。
 *
 * 职责边界：只做工具注册、参数 schema 声明与结果包装，业务实现全部在 providers/*。
 * 副作用：工具调用后会真实执行 xcodebuild/simctl/idb、写盘（工程/截图/DerivedData）或改变模拟器状态。
 * 失败语义：所有 handler 经 guard 包裹，异常转为 fail() 文本结果，不让异常打断 MCP 连接。
 * 传输方式：仅 stdio，入口 main()，由宿主进程按 MCP 协议拉起。
 */
import path from "node:path";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { json, fail, image } from "../lib/result.js";
import { inside } from "../lib/path.js";
import { preflight } from "../providers/preflight.js";
import { list, boot, show, install, launch, terminate, url } from "../providers/sim.js";
import { discover, create } from "../providers/project.js";
import { app, runApp } from "../providers/build.js";
import { shot } from "../providers/screenshot.js";
import { logs } from "../providers/logs.js";
import * as ui from "../providers/ui.js";

/**
 * 模拟器目标参数：udid 精确指定；device/runtime 为名称片段，供 provider 在未给 udid 时匹配默认设备。
 * 三者都可省略，此时使用已启动或默认 iPhone 模拟器。
 */
// udid 精确指定目标设备。
// device 与 runtime 都按名称片段交给 provider 做包含匹配，只有 udid 是精确键；省略三者时才落到已启动或默认 iPhone。
// 三者省略时由 provider 选择已启动或默认设备。
const target = {
  udid: z
    .string()
    .optional()
    .describe(
      "Simulator UDID. When omitted, the plugin uses a booted or default iPhone simulator.",
    ),
  device: z.string().optional().describe("Simulator device name fragment, for example iPhone 16."),
  runtime: z.string().optional().describe("Runtime name fragment, for example iOS-18."),
};

/**
 * 构建类工具共享参数：project/workspace 二选一（相对路径），scheme/configuration 可自动发现或默认；
 * derivedDataPath 默认落在插件数据目录，避免污染用户 ~/Library/Developer/Xcode/DerivedData。
 */
const build = {
  ...target,
  project: z.string().optional().describe(".xcodeproj path as a relative path."),
  workspace: z.string().optional().describe(".xcworkspace path as a relative path."),
  scheme: z
    .string()
    .optional()
    .describe("Xcode scheme. Automatically selected when it can be discovered."),
  configuration: z.string().optional().describe("Xcode configuration. Defaults to Debug."),
  derivedDataPath: z
    .string()
    .optional()
    .describe("DerivedData path as a relative path. Defaults to the plugin data directory."),
  bundleId: z
    .string()
    .optional()
    .describe("Override to use when build settings cannot resolve the bundle id."),
  openSimulator: z.boolean().optional().describe("Open the macOS Simulator app."),
  timeoutMs: z.number().int().positive().optional().describe("Build timeout in milliseconds."),
};

/**
 * MCP 服务实例：名称与版本即客户端看到的插件标识，改动会影响宿主侧工具命名空间，需同步文档。
 */
// new McpServer({ name: "ios-simulator", version: "0.1.0" }) 的名称与版本就是客户端看到的插件身份，改动会同步改变宿主侧工具命名空间；实例在模块加载时创建一次，registerTool 全部挂在同一个 server 上。
const server = new McpServer({
  name: "ios-simulator",
  version: "0.1.0",
});

// 只读自检：macOS/Xcode/simctl/运行时与 UI 后端是否可用，不修改系统状态。
server.registerTool(
  "ios_preflight",
  {
    title: "iOS Preflight",
    description:
      "Check whether macOS, full Xcode, simctl, simulator runtimes, and optional UI backends are available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await preflight())),
);

// 只读列出 simctl 可见的模拟器（含关机实例），由 provider 归一化状态与运行时字段。
server.registerTool(
  "ios_list_simulators",
  {
    title: "List iOS Simulators",
    description: "List simulators visible to xcrun simctl.",
    inputSchema: {},
  },
  async () => guard(async () => json(await list())),
);

// 启动模拟器并默认打开 Simulator 窗口（openSimulator 缺省 true），会占用模拟器实例，属于副作用操作。
server.registerTool(
  "ios_boot_simulator",
  {
    title: "Boot iOS Simulator",
    description: "Boot the selected simulator and optionally open the macOS Simulator window.",
    inputSchema: {
      ...target,
      openSimulator: z.boolean().optional(),
    },
  },
  async (args) =>
    guard(async () =>
      json(
        await boot({
          udid: args.udid,
          name: args.device,
          runtime: args.runtime,
          open: args.openSimulator ?? true,
        }),
      ),
    ),
);

// 仅打开 macOS Simulator 前台并可选聚焦某个 UDID，不改变模拟器开关机状态。
server.registerTool(
  "ios_show_simulator",
  {
    title: "Show iOS Simulator",
    description: "Open the macOS Simulator app and optionally focus a specific UDID.",
    inputSchema: {
      udid: z.string().optional(),
    },
  },
  async (args) => guard(async () => json(await show(args.udid))),
);

// 只读扫描工作区，返回 .xcodeproj/.xcworkspace、scheme 与 bundle id 候选。
server.registerTool(
  "ios_discover_project",
  {
    title: "Discover iOS Project",
    description:
      "Find .xcodeproj/.xcworkspace files, schemes, and bundle identifiers in the current project.",
    inputSchema: {},
  },
  async () => guard(async () => json(await discover())),
);

// 在工作区生成最小 SwiftUI 工程，属于写盘操作；overwrite=false 时不得覆盖已有文件。
server.registerTool(
  "ios_create_app",
  {
    title: "Create SwiftUI App",
    description: "Create a minimal SwiftUI iOS app and Xcode project in the current workspace.",
    inputSchema: {
      name: z.string().min(1),
      bundleId: z.string().optional(),
      dir: z.string().optional(),
      deployment: z.string().optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace existing generated files. Defaults to false."),
    },
  },
  async (args) => guard(async () => json(await create(args))),
);

// 调用 xcodebuild 构建模拟器产物，耗时可达数分钟；失败时返回构建日志摘要而非抛出异常。
server.registerTool(
  "ios_build_app",
  {
    title: "Build iOS App",
    description: "Build the current or specified Xcode project for iOS Simulator with xcodebuild.",
    inputSchema: build,
  },
  async (args) => guard(async () => json(await app(args))),
);

// 构建 + 启动/复用模拟器 + 安装 + 启动 + 打开窗口的组合流程，任一步失败即中止并返回该步上下文。
server.registerTool(
  // ios_build_and_run 把 app(args) 构建、boot、install、launch 与开窗串成一条链，inputSchema 用 { ...build, launchArgs } 复用共享 build schema；任一步抛错由 guard 收敛，args.launchArgs 原样透传给被测应用。
  "ios_build_and_run",
  {
    title: "Build and Run iOS App",
    description: "Build, install, launch, and show an iOS app in macOS Simulator.",
    inputSchema: {
      ...build,
      launchArgs: z.array(z.string()).optional(),
    },
  },
  async (args) => guard(async () => json(await runApp(args))),
);

// 安装本地 .app：appPath 若为相对路径会经 file() 限定在工作区内，绝对路径原样放行；
// 安装前先 boot 确保模拟器处于可用状态，因此该工具隐含启动副作用。
server.registerTool(
  "ios_install_app",
  {
    title: "Install iOS App",
    description: "Install an .app bundle on the selected simulator.",
    inputSchema: {
      ...target,
      appPath: z.string().min(1),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({ udid: args.udid, name: args.device, runtime: args.runtime });
      return json(await install(sim.udid, file(args.appPath)));
    }),
);

// 按 bundleId 启动已安装应用；会先 boot 并打开 Simulator 窗口，launchArgs 原样透传给应用。
server.registerTool(
  "ios_launch_app",
  {
    title: "Launch iOS App",
    description: "Launch an installed app on the selected simulator by bundle id.",
    inputSchema: {
      ...target,
      bundleId: z.string().min(1),
      launchArgs: z.array(z.string()).optional(),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({
        udid: args.udid,
        name: args.device,
        runtime: args.runtime,
        open: true,
      });
      return json(await launch(sim.udid, args.bundleId, args.launchArgs ?? []));
    }),
);

// 按 bundleId 终止应用（simctl terminate），会丢弃应用运行态但保留安装数据。
server.registerTool(
  "ios_terminate_app",
  {
    title: "Terminate iOS App",
    description: "Terminate an installed app on the selected simulator by bundle id.",
    inputSchema: {
      ...target,
      bundleId: z.string().min(1),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({ udid: args.udid, name: args.device, runtime: args.runtime });
      return json(await terminate(sim.udid, args.bundleId));
    }),
);

// 在模拟器内打开 URL（长度 ≤2048），会切走当前前台应用并打开 Simulator 窗口。
server.registerTool(
  "ios_open_url",
  {
    title: "Open URL in Simulator",
    description: "Open a URL in the selected simulator.",
    inputSchema: {
      ...target,
      url: z.string().min(1).max(2048),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({
        udid: args.udid,
        name: args.device,
        runtime: args.runtime,
        open: true,
      });
      return json(await url(sim.udid, args.url));
    }),
);

// 截图并以 image content 返回：文本仅含 simulator/path/bytes 元数据，图像走 base64；
// PNG 会落盘（默认插件数据目录），调用方可凭 path 复用。
server.registerTool(
  // 截图默认落在插件数据目录。
  // 文本结果只带模拟器、路径与字节数。
  // 图像内容单独走 base64。
  // 调用方可凭返回路径复用同一张图。
  "ios_screenshot",
  {
    title: "Capture iOS Screen",
    description:
      "Capture a PNG screenshot from the selected simulator and return it as MCP image content.",
    inputSchema: {
      ...target,
      path: z.string().optional(),
      openSimulator: z.boolean().optional(),
    },
  },
  async (args) =>
    guard(async () => {
      const pic = await shot(args);
      return image({ simulator: pic.simulator, path: pic.path, bytes: pic.bytes }, pic.data);
    }),
);

// 读取模拟器日志：seconds 限定时间窗口，bundleId 可选过滤，limit 限制返回字符数。
server.registerTool(
  "ios_logs",
  {
    title: "Read iOS Simulator Logs",
    description: "Read recent simulator logs, optionally filtered by bundle id.",
    inputSchema: {
      ...target,
      bundleId: z.string().optional(),
      seconds: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await logs(args))),
);

// 探测可选 UI 自动化后端（当前基于 idb）是否可用，只读，不影响模拟器。
server.registerTool(
  "ios_ui_status",
  {
    title: "iOS UI Backend Status",
    description:
      "Report whether the optional UI automation backend is available. P0 uses idb when available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await ui.status())),
);

// 通过 idb 在坐标处点击；duration 可控制按压时长，会真实改变模拟器 UI。
server.registerTool(
  "ios_ui_tap",
  {
    title: "Tap iOS Simulator",
    description: "Tap screen coordinates using the optional idb UI backend.",
    inputSchema: {
      ...target,
      x: z.number(),
      y: z.number(),
      duration: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.tap(args))),
);

// 通过 idb 从 (x1,y1) 滑到 (x2,y2)，delta 控制滑动步长/速度，会改变界面滚动状态。
server.registerTool(
  "ios_ui_swipe",
  {
    title: "Swipe iOS Simulator",
    description: "Swipe between screen coordinates using the optional idb UI backend.",
    inputSchema: {
      ...target,
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      delta: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.swipe(args))),
);

// 向当前焦点控件输入文本；不会自动聚焦，调用方应先 tap 目标输入框。
server.registerTool(
  "ios_ui_type_text",
  {
    title: "Type Text in iOS Simulator",
    description: "Enter text into the currently focused control using the optional idb UI backend.",
    inputSchema: {
      ...target,
      text: z.string(),
    },
  },
  async (args) => guard(async () => json(await ui.typeText(args))),
);

// 发送硬件按钮事件，枚举受 schema 限制（APPLE_PAY/HOME/LOCK/SIDE_BUTTON/SIRI），避免任意输入注入。
server.registerTool(
  // 按钮枚举由 schema 限制，避免任意注入。
  // 按压时长可选，必须为正数。
  // 该工具依赖可选 UI 后端。
  // 未安装后端时 guard 会把错误转为可读结果。
  "ios_ui_button",
  {
    title: "Press iOS Simulator Button",
    description:
      "Press HOME, LOCK, SIDE_BUTTON, SIRI, or APPLE_PAY using the optional idb UI backend.",
    inputSchema: {
      ...target,
      button: z.enum(["APPLE_PAY", "HOME", "LOCK", "SIDE_BUTTON", "SIRI"]),
      duration: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.button(args))),
);

// 返回当前屏幕的 accessibility 元素信息，供模型先看结构再决定点击目标。
server.registerTool(
  "ios_ui_describe",
  {
    title: "Describe iOS Simulator UI",
    description:
      "Return accessibility information for the current screen using the optional idb UI backend.",
    inputSchema: target,
  },
  async (args) => guard(async () => json(await ui.describe(args))),
);

/**
 * 启动 stdio MCP 服务并阻塞在传输层事件循环。
 *
 * 由宿主进程作为子进程拉起；本函数不返回，直到连接关闭或进程被终止。
 * 失败语义：传输初始化失败会抛出，导致进程退出，由宿主侧看到非零退出码。
 */
// 只建立 stdio 传输，不写标准输出。
// 连接后阻塞在传输事件循环。
// 连接关闭或进程终止时函数才返回。
export async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main();
}

/**
 * 工具执行守卫：把任意异常转成 isError 结果。
 *
 * 这是工具层唯一的错误收敛点，保证 provider 内部抛出的 fs/子进程/schema 错误不打断 MCP 会话；
 * 只保留 message（不含堆栈），避免泄露内部路径与实现细节；Error 之外的抛出物统一 String 化。
 */
// guard 是 registerTool 回调的统一 try/catch：任何 fs/子进程/schema 异常都转成 fail(...) 的 isError 结果，只取 err.message 不附堆栈，非 Error 抛出物用 String(err) 归一，避免中断 MCP 会话。
async function guard(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 把安装路径参数转为可用的绝对路径。
 *
 * 绝对路径原样放行，允许安装工作区外的 .app（如 DerivedData 产物）；
 * 相对路径经 inside 限定在 cwd 内，防止 ../ 穿越读取任意目录。
 */
// file(raw) 用 path.isAbsolute(raw) 放行工作区外的 .app（如 DerivedData 产物），相对路径必须经 inside(process.cwd(), raw) 限定，阻止 ../ 穿越读取任意目录。
function file(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  return inside(process.cwd(), raw);
}
