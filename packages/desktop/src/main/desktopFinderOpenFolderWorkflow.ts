// INV-01 安装只在 darwin 上发生，平台判断必须排在一切副作用之前；守住位置：installFinderOpenFolderWorkflow 首行守卫；改错故障：Windows 与 Linux 上也会建 Library/Services 目录并 spawn pbs，启动即报错。
// INV-02 目标目录恒为 <home>/Library/Services，home 只能由测试注入；守住位置：servicesDir 的 join 拼接；改错故障：服务写进错误目录，Finder 的「服务」菜单里永远看不到这一项。
// INV-03 workflow 目录名必须以 .workflow 结尾且与 Info.plist 的 CFBundleName 一致；守住位置：WORKFLOW_NAME 与 buildInfoPlist 的插值；改错故障：菜单项掉进其他分组或显示成目录名的裸串，用户认不出这是什么功能。
// INV-04 脚本语义一旦变化就必须递增 WORKFLOW_VERSION；守住位置：WORKFLOW_VERSION 常量；改错故障：系统按版本号判定缓存未变，用户点菜单仍执行旧脚本，表现为打开错误目录或毫无反应。
// INV-05 同一次安装里 Info.plist 与 document.wflow 必须来自同一个 locale；守住位置：buildInfoPlist 与 buildDocumentWorkflow 的调用点；改错故障：菜单文案已是中文而脚本仍是上一版，两处行为不一致且难以复现。
// INV-06 document.wflow 必须同时写到 Contents 与 Resources 两个位置；守住位置：两次 writeFileIfChanged 调用；改错故障：Finder 能显示服务，点击却报 not configured correctly。
// INV-07 所有进入 plist 的字符串都必须先过 escapeXml，包括菜单文案与整段 shell 脚本；守住位置：buildInfoPlist 与 buildDocumentWorkflow 的插值点；改错故障：文案或路径含 & 与 < 时 plist 解析失败，整个服务被判损坏并静默移除。
// INV-08 shell 脚本不能把路径拼进命令字符串，变量展开一律必须加双引号；守住位置：workflowScript 里对 "$item" 的引用；改错故障：含空格或命令替换的目录名在点菜单时被当成命令执行，形成注入。
// INV-09 只有目录才会被转发给应用；守住位置：workflowScript 的 -d 判断；改错故障：选中文件也走打开流程，应用收到非 workspace 路径后弹出错误或建出空窗口。
// INV-10 多选时只取第一个目录并立即 break；守住位置：workflowScript 的循环与 break；改错故障：一次点开多个窗口，用户没预期的目录被挂载进侧边栏。
// INV-11 路径必须先 encodeURIComponent 再拼进 zcode:// URL；守住位置：workflowScript 调 osascript 的编码步骤；改错故障：含空格、# 或 ? 的路径被 URL 解析截断，打开的是错误目录或空白工作区。
// INV-12 写盘前必须逐字节比较，内容相同就完全不碰文件系统；守住位置：writeFileIfChanged；改错故障：每次启动都重写文件并刷新索引，Finder 菜单反复重建甚至闪烁。
// INV-13 三个文件内容全部未变时不得刷新 Services 索引；守住位置：infoChanged 等三个布尔值的或判断为假的分支；改错故障：每次启动无谓 fork 索引进程，启动变慢且日志被噪音淹没。
// INV-14 任一文件内容变化都必须刷新 Services 索引，不能只刷 plist 变化；守住位置：同一处或判断为真的分支；改错故障：仅脚本更新时菜单文案不变，用户以为升级没生效。
// INV-15 pbs 不存在时静默跳过而不是抛错；守住位置：refreshMacServicesIndex 的 existsSync 早返回；改错故障：精简系统或受限环境下安装整体失败，连文件都已写入却报安装失败。
// INV-16 pbs 子进程必须 detached 加 unref，且必须挂 error 回调；守住位置：spawn 选项与 error 监听；改错故障：主进程退出被索引进程拖住，或 spawn 失败升级成未捕获异常打掉主进程。
// INV-17 安装流程整体包在 try 中，失败必须只记 warn，不能向外抛；守住位置：installFinderOpenFolderWorkflow 的 catch；改错故障：Finder 集成故障阻断应用启动，用户连主界面都进不去。
// INV-18 安装必须幂等，重复调用只产生内容完全相同的文件；守住位置：writeFileIfChanged 与 workflow 内固定 UUID；改错故障：重复安装让 Automator 认为 workflow 被改坏，服务条目失效。
// INV-19 mkdir 必须在写任何文件之前完成，且必须 recursive；守住位置：mkdirSync 调用与后续 writeFileIfChanged 的先后；改错故障：首次安装因目录不存在写盘失败，服务此后一直装不上。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Locale } from "@zcode/shared";

// INV-03 与 INV-04 的落点：目录名、bundle id、版本号三者必须共同决定系统是否把这次安装当成新服务。
// 目录名必须以 .workflow 结尾且与 CFBundleName 完全一致：Finder 按目录名枚举服务，
// 按 plist 里的名字显示，两者不一致时菜单项会掉进其他分组且名字错乱。
// bundle id 固定为 dev.zcode.app.finder-open-workflow，改名等价于换一个新服务：
// 系统会同时保留旧条目，菜单里出现两个同名项，卸载旧版只能靠手工删目录。
// [权衡] 版本号用每次脚本语义变化就加一的整数串，而不用语义化版本：
// CFBundleVersion 只参与缓存失效比较，递增即可；写成 1.0.1 反而让排序比较不可预期。
// SERVICES_MENU_LABELS 必须是唯一文案来源，缺 key 时必须回退 en-US，避免菜单项显示 undefined。
const WORKFLOW_NAME = "Open in ZCode.workflow";
const WORKFLOW_BUNDLE_ID = "dev.zcode.app.finder-open-workflow";
const WORKFLOW_VERSION = "5";
const SERVICES_MENU_LABELS: Record<Locale, string> = {
  "zh-CN": "在ZCode中打开",
  "en-US": "Open in ZCode",
};

// INV-08 与 INV-09 的落点：这段脚本由 Automator 的 Run Shell Script 执行，
// 输入是被选中条目的路径列表，而不是单个路径，因此必须先筛出目录。
// [权衡] 这里刻意不用位置参数 1：多选时 Automator 传入的参数顺序不稳定，
// 只取第一个参数可能拿到文件而非目录，服务就会在没有可打开目标时静默退出。
// 所有变量展开都加双引号，路径里的空格、括号、引号才不会被 zsh 重新分词。
// 一旦去掉引号，目录名里的命令替换就会在用户点菜单时被执行，构成注入。
// 路径不直接拼进 zcode:// URL，而是先交给 osascript 做 encodeURIComponent：
// 中文、空格、井号与问号在 URL 里有特殊含义，未编码会让应用解析出被截断的路径。
const workflowScript = `first=""
for item in "$@"; do
  if [ -d "$item" ]; then
    first="$item"
    break
  fi
done

if [ -n "$first" ]; then
  encoded=$(/usr/bin/osascript -l JavaScript -e 'function run(argv) { return encodeURIComponent(argv[0]); }' "$first")
  /usr/bin/open "zcode://workspace/open?path=\${encoded}"
fi
`;

// INV-07 的落点：所有进入 plist 的字符串都必须先过这一层，包括菜单文案与整段 shell 脚本。
// XML 只有五个预定义实体，其中 & 必须最先替换：若先替换 < 再替换 &，
// 已经生成的 &lt; 会被二次转义成 &amp;lt;，plist 里就显示成字面量 &lt;。
// [失败路径] 这不是理论风险：shell 脚本里大量使用 && 与重定向符号，
// 未转义时 plist 解析直接失败，系统会把整个服务判定为损坏并静默移除。
// 单引号转成 &apos; 而不是省略：菜单文案未来可能带撇号，
// 缺失这一条会让用户在非中文语言下遇到无法定位的解析错误。
// [权衡] 不引入第三方 XML 库：这里只有五个固定替换，多一个依赖换不来正确性。
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getServicesMenuLabel(locale: Locale): string {
  return SERVICES_MENU_LABELS[locale] ?? SERVICES_MENU_LABELS["en-US"];
}

// INV-05 的落点：NSServices 声明这是提供给 Finder 的服务，其余键只为让系统接受这个 bundle。
// NSApplicationIdentifier 限定 com.apple.finder，否则服务会出现在所有应用的「服务」菜单里。
// NSSendFileTypes 只列 public.folder 与 public.directory：前者是 Finder 里的文件夹，
// 后者是底层目录类型，只写一个会漏掉通过路径选择或终端拖入的场景。
// NSMessage 必须固定为 runWorkflowAsService，这是 Automator 服务型 workflow 的入口名，
// 改成别的 NSMessage 后系统仍能登记服务，但点击时找不到可执行入口。
// [失败路径] 该 plist 一旦写坏，macOS 不会报错，只是菜单里少一项，用户无从感知。
function buildInfoPlist(locale: Locale): string {
  const servicesMenuName = escapeXml(getServicesMenuLabel(locale));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>English</string>
  <key>CFBundleExecutable</key>
  <string></string>
  <key>CFBundleIdentifier</key>
  <string>${WORKFLOW_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${servicesMenuName}</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>${WORKFLOW_VERSION}</string>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>${servicesMenuName}</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict>
        <key>NSApplicationIdentifier</key>
        <string>com.apple.finder</string>
      </dict>
      <key>NSSendFileTypes</key>
      <array>
        <string>public.folder</string>
        <string>public.directory</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
}

// INV-06 的落点：document.wflow 是 Automator 的 workflow 描述文件，
// 这里只用内置的 Run Shell Script action，不依赖用户机器上的自定义 action，
// 从而保证全新系统上也能运行，不需要额外的 Automator 授权或安装步骤。
// [权衡] action 的 UUID 是硬编码常量而不是每次随机生成：随机值会让每次安装
// 都产生内容不同的 wflow，破坏 writeFileIfChanged 的幂等判断。
// AMAccepts 声明输入是 com.apple.cocoa.path 列表，必须与脚本预期保持一致：
// 声明成单个字符串时 Finder 会把多选拆成多次调用，第一条之后的目录全部丢失。
// serviceProcessesInput 为 false，让系统只传路径而不消费原文件，避免选中项被移动。
function buildDocumentWorkflow(): string {
  const escapedScript = escapeXml(workflowScript);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>COMMAND_STRING</key>
          <string>${escapedScript}</string>
          <key>inputMethod</key>
          <integer>1</integer>
          <key>shell</key>
          <string>/bin/zsh</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <true/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.path</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict>
          <key>CheckedForUserDefaultShell</key>
          <dict/>
          <key>COMMAND_STRING</key>
          <dict/>
          <key>inputMethod</key>
          <dict/>
          <key>shell</key>
          <dict/>
          <key>source</key>
          <dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <false/>
        <key>CanShowWhenRun</key>
        <true/>
        <key>Category</key>
        <array>
          <string>AMCategoryUtilities</string>
        </array>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>Class Name</key>
        <string>RunShellScriptAction</string>
        <key>InputUUID</key>
        <string>F477A40F-2E89-4A51-8CC1-477A68B23B20</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string>
          <string>Script</string>
        </array>
        <key>OutputUUID</key>
        <string>6F83E6AB-25DA-4FE4-8F38-F3FA66EB5821</string>
        <key>UnlocalizedApplications</key>
        <array>
          <string>Automator</string>
        </array>
        <key>UUID</key>
        <string>85496E72-E631-48B7-A8AB-4E7841D622E6</string>
      </dict>
      <key>isViewVisible</key>
      <true/>
    </dict>
  </array>
  <key>AMApplicationBuild</key>
  <string>521</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceApplicationBundleID</key>
    <string>com.apple.finder</string>
    <key>serviceApplicationPath</key>
    <string>/System/Library/CoreServices/Finder.app</string>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject.folder</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <false/>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
`;
}

// INV-12 与 INV-18 的落点：安装入口在每次应用启动时都会调用这里，
// 因此写盘前必须逐字节比较，内容相同就完全不碰文件系统。
// [权衡] 不比较直接覆盖也能得到正确内容，代价是修改时间每次都变：
// macOS 的 Services 缓存按修改时间失效，无谓重写会让 Finder 反复重建服务菜单。
// [资源] 同步读写是有意为之：安装只发生在启动早期，异步化会让调用方
// 无法从返回值判断是否需要刷新索引，还要额外处理写失败的时序。
// [失败路径] 读取现有文件时若权限不足会抛错，由调用方的 try 统一兜住；
// 这里不吞异常，否则会把读不到误判成内容不同而继续盲写。
function writeFileIfChanged(path: string, content: string): boolean {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === content) {
      return false;
    }
  }

  writeFileSync(path, content, "utf8");
  return true;
}

// INV-15 与 INV-16 的落点：pbs 是系统 Services 索引的刷新工具，
// 只更新注册表，不重启 Finder，所以可以放心在启动路径上调用。
// [资源] 子进程必须 detached 加 unref：否则主进程退出时要等索引进程结束，
// 用户会看到应用关不掉，或退出后仍残留一个 pbs 进程。
// stdio 设为 ignore，避免子进程继承主进程的管道，让日志句柄迟迟不释放。
// [失败路径] error 回调必须存在且为空：spawn 对不存在的可执行文件会异步抛错，
// 没有监听时 Node 会把它升级成未捕获异常，直接打掉主进程。
function refreshMacServicesIndex(): void {
  const pbsPath = "/System/Library/CoreServices/pbs";
  if (!existsSync(pbsPath)) {
    return;
  }

  const child = spawn(pbsPath, ["-update"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

// INV-01 与 INV-17 的落点：这是唯一对外入口，平台判断必须排在所有副作用之前，
// 否则 Windows 与 Linux 上会先建 Library/Services 目录再发现不该执行。
// [失败路径] 整体包在 try 中，任何一步失败都只记 warn：
// Finder 集成属于增强功能，装不上不能阻断应用启动，用户仍可手动打开目录。
// 三个布尔值的或判断同时承担两件事：决定是否刷新索引，以及决定是否记 info 日志。
// 全为假表示本次启动没有改动，静默返回，避免每次启动刷一条无意义日志。
// [权衡] 刷新索引必须通过可注入的 refreshServicesIndex 完成，测试里可以替换成空实现，
// 生产路径则回落到真实 pbs；注入点存在只为可测性，不改变安装语义。
export function installFinderOpenFolderWorkflow(options: {
  platform: NodeJS.Platform;
  locale: Locale;
  homeDir?: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  refreshServicesIndex?: () => void;
}): void {
  if (options.platform !== "darwin") {
    return;
  }

  const servicesDir = join(options.homeDir ?? homedir(), "Library", "Services");
  const workflowDir = join(servicesDir, WORKFLOW_NAME);
  const contentsDir = join(workflowDir, "Contents");
  const resourcesDir = join(contentsDir, "Resources");
  const infoPlistPath = join(contentsDir, "Info.plist");
  const documentWorkflowPath = join(contentsDir, "document.wflow");
  const resourcesDocumentWorkflowPath = join(resourcesDir, "document.wflow");

  try {
    mkdirSync(resourcesDir, { recursive: true });

    const infoChanged = writeFileIfChanged(infoPlistPath, buildInfoPlist(options.locale));
    const workflowContent = buildDocumentWorkflow();
    const workflowChanged = writeFileIfChanged(documentWorkflowPath, workflowContent);
    // 用户 Automator workflow 通常读取 Contents/document.wflow；
    // 系统内置 workflow 也存在 Resources/document.wflow 形态。两个位置都写同一份，
    // 避免 Finder 能显示服务但运行时报 “not configured correctly”。
    const resourcesWorkflowChanged = writeFileIfChanged(
      resourcesDocumentWorkflowPath,
      workflowContent,
    );

    if (infoChanged || workflowChanged || resourcesWorkflowChanged) {
      // Finder 系统服务展示名来自 workflow 的 Info.plist。
      // 语言切换后必须重写 plist 并刷新 Services 索引，否则系统菜单会继续显示旧语言。
      (options.refreshServicesIndex ?? refreshMacServicesIndex)();
      options.logger.info("[finder-open-folder] Finder 服务已安装或更新", {
        locale: options.locale,
        workflowPath: workflowDir,
      });
    }
  } catch (error) {
    options.logger.warn("[finder-open-folder] Finder 服务安装失败", {
      error: error instanceof Error ? error.message : String(error),
      workflowPath: workflowDir,
    });
  }
}
