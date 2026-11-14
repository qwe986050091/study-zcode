/**
 * iOS/Xcode 工程发现与最小 SwiftUI 工程生成。
 *
 * 职责边界：发现 .xcodeproj/.xcworkspace、scheme、bundle id，解析构建源（project/workspace），
 * 以及生成可直接用 xcodebuild 构建的工程文件；不执行构建。
 * 副作用：discover 只读文件系统并运行 xcodebuild -list；create 会 mkdir + 写 Swift 源码与 project.pbxproj。
 * 失败语义：发现阶段的命令失败降级为空列表；create 在参数非法、路径越界或文件已存在（未允许覆盖）时抛错。
 * 口径：返回路径均为相对 cwd；bundle id 优先用户指定，否则 com.example.<slug>。
 * 设计说明：生成的 pbxproj 使用一组固定 24 位对象 ID，保证单工程可解析；这些 ID 仅需在文件内唯一。
 */
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { inside } from "../lib/path.js"
import { ok, run } from "../lib/run.js"

/**
 * 发现结果。projects/workspaces 为相对 dir 的路径数组，schemes/bundleIds 可能为空；
 * 调用方应优先使用 workspace（CocoaPods/SPM 场景需要 workspace 才能正确解析依赖）。
 */
type Found = {
  projects: string[]
  workspaces: string[]
  schemes: string[]
  bundleIds: string[]
}

/**
 * pbxproj 中使用的固定对象 ID 池（24 位十六进制，Xcode 对象 ID 格式）。
 * 模板按固定索引引用它们，因此 ID 只需在单个工程文件内唯一，不要求全局唯一。
 */
const IDS = [
  "A10000000000000000000001",
  "A10000000000000000000002",
  "A10000000000000000000003",
  "A10000000000000000000004",
  "A10000000000000000000005",
  "A10000000000000000000006",
  "A10000000000000000000007",
  "A10000000000000000000008",
  "A10000000000000000000009",
  "A1000000000000000000000A",
  "A1000000000000000000000B",
  "A1000000000000000000000C",
  "A1000000000000000000000D",
  "A1000000000000000000000E",
  "A1000000000000000000000F",
  "A10000000000000000000010",
  "A10000000000000000000011",
  "A10000000000000000000012",
  "A10000000000000000000013",
  "A10000000000000000000014",
  "A10000000000000000000015",
  "A10000000000000000000016",
] as const

/**
 * 扫描工作区并汇总工程、workspace、scheme 与 bundle id 候选。
 *
 * 流程：walk 收集工程目录 → 选 workspace 优先、project 次之 → xcodebuild -list 解析 scheme →
 * 读取各 project.pbxproj 提取 PRODUCT_BUNDLE_IDENTIFIER。
 * 副作用：只读文件系统并执行一次 xcodebuild -list；不修改工程。
 * 失败语义：scheme 查询失败返回空数组、pbxproj 读取失败按空文本处理，整体不抛错。
 * 注意：bundleIds 会去引号并 trim，但不过滤非法值（来自用户工程，应原样展示供人工判断）。
 */
export async function discover(dir = process.cwd()): Promise<Found> {
  const projects: string[] = []
  const workspaces: string[] = []
  await walk(dir, 3, (file) => {
    if (file.endsWith(".xcodeproj")) projects.push(path.relative(dir, file))
    if (file.endsWith(".xcworkspace")) workspaces.push(path.relative(dir, file))
  })
  const source = workspaces[0] ? { flag: "-workspace", file: workspaces[0] } : projects[0] ? { flag: "-project", file: projects[0] } : undefined
  const schemes = source ? await schemesFor(source.flag, source.file) : []
  const ids = new Set<string>()
  for (const item of projects) {
    const file = path.join(dir, item, "project.pbxproj")
    const text = await readFile(file, "utf8").catch(() => "")
    for (const hit of text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)) ids.add(hit[1]?.replaceAll("\"", "").trim() ?? "")
  }
  return { projects, workspaces, schemes, bundleIds: [...ids].filter(Boolean) }
}

/**
 * 通过 xcodebuild -list -json 获取 scheme 列表。
 * 输出结构可能挂在 project 或 workspace 下，二者都兼容；命令失败/JSON 解析失败返回空数组，
 * 由调用方决定是否回退到工程名作为 scheme。
 */
async function schemesFor(flag: string, file: string): Promise<string[]> {
  const out = await run(["xcodebuild", "-list", "-json", flag, file], { timeout: 30_000 })
  if (!ok(out)) return []
  const raw = JSON.parse(out.stdout) as { project?: { schemes?: string[] }; workspace?: { schemes?: string[] } }
  return raw.project?.schemes ?? raw.workspace?.schemes ?? []
}

/**
 * 递归遍历目录并对 .xcodeproj/.xcworkspace 目录回调。
 *
 * 跳过隐藏目录、node_modules 与 DerivedData：这些目录体积大且可能包含无关工程/缓存。
 * 只把以这两种后缀结尾的目录视为工程并停止向下递归，避免进入工程包内部造成重复匹配。
 * depth 为负即停止；读取失败降级为空列表，不阻断发现。
 */
async function walk(dir: string, depth: number, cb: (file: string) => void): Promise<void> {
  if (depth < 0) return
  const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    items
      .filter((item) => !item.name.startsWith(".") && item.name !== "node_modules" && item.name !== "DerivedData")
      .map(async (item) => {
        const file = path.join(dir, item.name)
        if (item.isDirectory() && (item.name.endsWith(".xcodeproj") || item.name.endsWith(".xcworkspace"))) {
          cb(file)
          return
        }
        if (item.isDirectory()) await walk(file, depth - 1, cb)
      }),
  )
}

/**
 * 生成最小 SwiftUI iOS 工程（App + ContentView + project.pbxproj）。
 *
 * 输入 name 会被清洗为合法 Swift 结构名，dir 经 inside() 限制在工作区内，bundleId/deployment 分别校验；
 * 副作用：递归创建目录并写入三个文件。
 * 失败语义：overwrite=false 且任一目标文件已存在时抛错并列出冲突文件，绝不静默覆盖；
 * 名称无可识别字符、包名或部署版本非法、路径越界均抛错。
 * 返回口径：project 为相对 cwd 的 .xcodeproj 路径，scheme 固定等于工程名，files 只含两个 Swift 源文件。
 */
export async function create(input: { name: string; bundleId?: string; dir?: string; deployment?: string; overwrite?: boolean }) {
  const cwd = process.cwd()
  const name = clean(input.name)
  const root = inside(cwd, input.dir || name)
  const bundle = input.bundleId ? bundleId(input.bundleId) : `com.example.${slug(name)}`
  const target = deployment(input.deployment || "17.0")
  const src = path.join(root, name)
  const proj = path.join(root, `${name}.xcodeproj`)
  const files = [
    path.join(src, `${name}App.swift`),
    path.join(src, "ContentView.swift"),
    path.join(proj, "project.pbxproj"),
  ]
  // 未显式允许覆盖时先探测所有目标文件；任一已存在就整体拒绝，避免生成半新半旧的工程。
  if (!input.overwrite) {
    const hits = await present(files)
    if (hits.length) {
      throw new Error(
        `Refusing to overwrite existing iOS app files: ${hits.map((file) => path.relative(cwd, file)).join(", ")}`,
      )
    }
  }
  await mkdir(src, { recursive: true })
  await mkdir(proj, { recursive: true })
  await writeFile(files[0], app(name), "utf8")
  await writeFile(files[1], view(), "utf8")
  await writeFile(files[2], pbx(name, bundle, target), "utf8")
  return {
    project: path.relative(cwd, proj),
    scheme: name,
    bundle,
    files: files.slice(0, 2).map((file) => path.relative(cwd, file)),
  }
}

/**
 * 从 xcodebuild -showBuildSettings 输出中解析 PRODUCT_BUNDLE_IDENTIFIER。
 *
 * 命令失败返回 undefined（构建仍可继续，仅安装/启动需要 bundleId）；
 * 逐行 trim 后取第一条匹配，避免缩进格式变化导致漏解析，也避免被同名变量多次定义干扰。
 */
export async function bundle(flag: "-project" | "-workspace", file: string, scheme: string): Promise<string | undefined> {
  const out = await run(["xcodebuild", flag, file, "-scheme", scheme, "-showBuildSettings"], { timeout: 60_000 })
  if (!ok(out)) return undefined
  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("PRODUCT_BUNDLE_IDENTIFIER = "))
    ?.replace("PRODUCT_BUNDLE_IDENTIFIER = ", "")
}

/**
 * 解析构建源：显式 workspace 优先于显式 project，二者都无则按发现结果自动选择。
 *
 * 输入路径均经 scoped 做越界与后缀校验；scheme 由 pick 决定（显式 → 发现首个 → 文件名）。
 * 失败语义：显式路径越界/后缀不符抛错；完全没有工程时抛错并引导先调用 ios_create_app。
 * 返回口径：{ flag, file, scheme } 可直接拼入 xcodebuild 命令；scheme 可能 undefined（由上层再校验）。
 */
export function source(input: { project?: string; workspace?: string; scheme?: string }, found: Found) {
  const workspace = input.workspace ? scoped(input.workspace, ".xcworkspace") : undefined
  const project = input.project ? scoped(input.project, ".xcodeproj") : undefined
  if (workspace) return { flag: "-workspace" as const, file: workspace, scheme: pick(input, found, workspace) }
  if (project) return { flag: "-project" as const, file: project, scheme: pick(input, found, project) }
  const auto = found.workspaces[0]
    ? { flag: "-workspace" as const, file: found.workspaces[0] }
    : found.projects[0]
      ? { flag: "-project" as const, file: found.projects[0] }
      : undefined
  if (auto) return { ...auto, scheme: pick(input, found, auto.file) }
  throw new Error("No .xcodeproj or .xcworkspace found. Use ios_create_app first.")
}

/**
 * 选择 scheme：显式入参优先；否则仅当文件是发现到的首个工程时采用发现的首个 scheme；
 * 最后回退为文件名（Xcode 默认 scheme 与工程/workspace 同名）。
 * 非首个工程不套用首个工程的 scheme，避免多工程场景误选。
 */
function pick(input: { scheme?: string }, found: Found, file: string): string | undefined {
  const first = found.workspaces[0] || found.projects[0]
  return input.scheme || (file === first ? found.schemes[0] : undefined) || path.basename(file, path.extname(file))
}

/**
 * 返回输入中实际已存在的文件列表，用于覆盖前冲突检测。
 */
async function present(files: string[]): Promise<string[]> {
  return (
    await Promise.all(
      files.map(async (file) => {
        const hit = await access(file)
          .then(() => true)
          .catch(() => false)
        return hit ? file : undefined
      }),
    )
  ).filter((file): file is string => file !== undefined)
}

/**
 * 校验并规范化显式工程路径：必须在 cwd 内（inside 抛越界错误）、后缀必须匹配，
 * 最后转成相对 cwd 的路径，保证后续 xcodebuild 参数口径统一。
 */
function scoped(raw: string, ext: ".xcodeproj" | ".xcworkspace"): string {
  const file = inside(process.cwd(), raw)
  if (!file.endsWith(ext)) throw new Error(`Expected ${ext} path: ${raw}`)
  return path.relative(process.cwd(), file)
}

/**
 * 校验 bundle id：至少两段，每段以字母数字开头且只含字母数字与连字符。
 * 非法抛错，避免写入 pbxproj 后引发难以定位的构建失败。
 */
function bundleId(value: string): string {
  const parts = value.split(".")
  const good = parts.length > 1 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(part))
  if (!good) throw new Error(`Invalid bundle id: ${value}`)
  return value
}

/**
 * 校验 iOS 部署版本：形如 17、17.0、17.0.1（最多三段数字）。非法抛错。
 */
function deployment(value: string): string {
  if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(value)) throw new Error(`Invalid deployment target: ${value}`)
  return value
}

/**
 * 把工程名转成 bundle id 可用的 slug：非字母数字替换为连字符、合并重复、去首尾并小写。
 * 数字开头补 app- 前缀；结果为空回退 "app"，保证默认 bundle id 始终合法。
 */
function slug(value: string): string {
  const out = value
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  if (/^[0-9]/.test(out)) return `app-${out}`
  return out || "app"
}

/**
 * 把用户输入清洗成合法 Swift 标识符：仅保留字母数字下划线，数字开头加 App 前缀。
 * 清洗后为空说明没有任何可用字符，抛错避免生成无法编译的工程。
 */
function clean(value: string): string {
  const out = value.replace(/[^A-Za-z0-9_]/g, "")
  if (!out) throw new Error("App name must contain letters or numbers.")
  if (/^[0-9]/.test(out)) return `App${out}`
  return out
}

/**
 * 生成 App 入口 Swift 源码：@main App 结构 + WindowGroup 承载 ContentView，
 * 结构名由清洗后的工程名决定，需保证与文件名保持一致以便 Xcode 编译。
 */
function app(name: string): string {
  return `import SwiftUI

@main
struct ${name}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`
}

/**
 * 生成 ContentView：Hello 文案、计数文本与自增按钮。
 * countLabel/incrementButton 的 accessibilityIdentifier 为 idb UI 自动化提供稳定定位点，
 * 不依赖可变文本匹配，便于 ios_ui_describe/tap 使用。
 */
function view(): string {
  return `import SwiftUI

struct ContentView: View {
    @State private var count = 0

    var body: some View {
        VStack(spacing: 20) {
            Text("Hello from iOS")
                .font(.largeTitle)
            Text("Count: \\(count)")
                .font(.title2)
                .accessibilityIdentifier("countLabel")
            Button("Increment") {
                count += 1
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("incrementButton")
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
`
}

function pbx(name: string, bundle: string, deployment: string): string {
  return `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 56;
  objects = {
    ${IDS[0]} = {isa = PBXBuildFile; fileRef = ${IDS[1]}; };
    ${IDS[2]} = {isa = PBXBuildFile; fileRef = ${IDS[3]}; };
    ${IDS[1]} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}App.swift; sourceTree = "<group>"; };
    ${IDS[3]} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ContentView.swift; sourceTree = "<group>"; };
    ${IDS[4]} = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${name}.app; sourceTree = BUILT_PRODUCTS_DIR; };
    ${IDS[5]} = {
      isa = PBXGroup;
      children = (${IDS[6]}, ${IDS[7]});
      sourceTree = "<group>";
    };
    ${IDS[6]} = {
      isa = PBXGroup;
      children = (${IDS[1]}, ${IDS[3]});
      path = ${name};
      sourceTree = "<group>";
    };
    ${IDS[7]} = {
      isa = PBXGroup;
      children = (${IDS[4]});
      name = Products;
      sourceTree = "<group>";
    };
    ${IDS[8]} = {
      isa = PBXNativeTarget;
      buildConfigurationList = ${IDS[9]};
      buildPhases = (${IDS[10]});
      buildRules = ();
      dependencies = ();
      name = ${name};
      productName = ${name};
      productReference = ${IDS[4]};
      productType = "com.apple.product-type.application";
    };
    ${IDS[10]} = {
      isa = PBXSourcesBuildPhase;
      buildActionMask = 2147483647;
      files = (${IDS[0]}, ${IDS[2]});
      runOnlyForDeploymentPostprocessing = 0;
    };
    ${IDS[11]} = {
      isa = PBXProject;
      attributes = {BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 1500; LastUpgradeCheck = 1500; TargetAttributes = {${IDS[8]} = {CreatedOnToolsVersion = 15.0;};};};
      buildConfigurationList = ${IDS[12]};
      compatibilityVersion = "Xcode 14.0";
      developmentRegion = en;
      hasScannedForEncodings = 0;
      knownRegions = (en, Base);
      mainGroup = ${IDS[5]};
      productRefGroup = ${IDS[7]};
      projectDirPath = "";
      projectRoot = "";
      targets = (${IDS[8]});
    };
    ${IDS[13]} = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING = YES; CLANG_WARN_BOOL_CONVERSION = YES; CLANG_WARN_COMMA = YES; CLANG_WARN_CONSTANT_CONVERSION = YES; CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS = YES; CLANG_WARN_DIRECT_OBJC_ISA_USAGE = YES_ERROR; CLANG_WARN_DOCUMENTATION_COMMENTS = YES; CLANG_WARN_EMPTY_BODY = YES; CLANG_WARN_ENUM_CONVERSION = YES; CLANG_WARN_INFINITE_RECURSION = YES; CLANG_WARN_INT_CONVERSION = YES; CLANG_WARN_NON_LITERAL_NULL_CONVERSION = YES; CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF = YES; CLANG_WARN_OBJC_LITERAL_CONVERSION = YES; CLANG_WARN_OBJC_ROOT_CLASS = YES_ERROR; CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES; CLANG_WARN_RANGE_LOOP_ANALYSIS = YES; CLANG_WARN_STRICT_PROTOTYPES = YES; CLANG_WARN_SUSPICIOUS_MOVE = YES; CLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE; CLANG_WARN_UNREACHABLE_CODE = YES; COPY_PHASE_STRIP = NO; DEBUG_INFORMATION_FORMAT = dwarf; ENABLE_STRICT_OBJC_MSGSEND = YES; ENABLE_TESTABILITY = YES; GCC_C_LANGUAGE_STANDARD = gnu17; GCC_DYNAMIC_NO_PIC = NO; GCC_NO_COMMON_BLOCKS = YES; GCC_OPTIMIZATION_LEVEL = 0; GCC_PREPROCESSOR_DEFINITIONS = ("DEBUG=1", "$(inherited)"); GCC_WARN_64_TO_32_BIT_CONVERSION = YES; GCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR; GCC_WARN_UNDECLARED_SELECTOR = YES; GCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE; GCC_WARN_UNUSED_FUNCTION = YES; GCC_WARN_UNUSED_VARIABLE = YES; IPHONEOS_DEPLOYMENT_TARGET = ${deployment}; MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE; MTL_FAST_MATH = YES; ONLY_ACTIVE_ARCH = YES; SDKROOT = iphoneos; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; SWIFT_OPTIMIZATION_LEVEL = "-Onone";}; name = Debug; };
    ${IDS[14]} = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; COPY_PHASE_STRIP = NO; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; ENABLE_NS_ASSERTIONS = NO; GCC_C_LANGUAGE_STANDARD = gnu17; IPHONEOS_DEPLOYMENT_TARGET = ${deployment}; MTL_ENABLE_DEBUG_INFO = NO; MTL_FAST_MATH = YES; SDKROOT = iphoneos; SWIFT_COMPILATION_MODE = wholemodule; SWIFT_OPTIMIZATION_LEVEL = "-O"; VALIDATE_PRODUCT = YES;}; name = Release; };
    ${IDS[15]} = {isa = XCBuildConfiguration; buildSettings = {ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; DEVELOPMENT_ASSET_PATHS = ""; DEVELOPMENT_TEAM = ""; ENABLE_PREVIEWS = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundle}; PRODUCT_NAME = "$(TARGET_NAME)"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = NO; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2";}; name = Debug; };
    ${IDS[16]} = {isa = XCBuildConfiguration; buildSettings = {ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; DEVELOPMENT_ASSET_PATHS = ""; DEVELOPMENT_TEAM = ""; ENABLE_PREVIEWS = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundle}; PRODUCT_NAME = "$(TARGET_NAME)"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = NO; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2";}; name = Release; };
    ${IDS[12]} = {isa = XCConfigurationList; buildConfigurations = (${IDS[13]}, ${IDS[14]}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    ${IDS[9]} = {isa = XCConfigurationList; buildConfigurations = (${IDS[15]}, ${IDS[16]}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
  };
  rootObject = ${IDS[11]};
}
`
}
