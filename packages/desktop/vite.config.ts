// INV-01 构建期能力动态导入：守住位置 顶层通讯；改错故障 配置打包后路径被重定位。
// INV-02 构建元数据只读一次：守住位置 模块顶层；改错故障 每次构建取到不同版本。
// INV-03 依赖别名解析真实安装根：守住位置 解析函数；改错故障 单运行时被拆成两份。
// INV-04 别名在消费端补齐界面目录：守住位置 别名表；改错故障 组件内部导入全部失效。
// INV-05 图表依赖固定到根部版本：守住位置 显式别名；改错故障 预构建命中旧包缺导出。
// INV-06 去重表与别名保持一致：守住位置 去重数组；改错故障 框架出现重复实例。
// INV-07 覆盖率插桩只跑源文件：守住位置 过滤函数；改错故障 依赖与声明文件被打点。
// INV-08 插桩跳过服务端渲染：守住位置 提前返回；改错故障 服务端代码被注入运行时代码。
// INV-09 插桩先于编译执行：守住位置 插件顺序；改错故障 覆盖点反投影到类型声明行。
// INV-10 基线覆盖在收尾时落盘：守住位置 关闭钩子；改错故障 未加载分块从分母消失。
// INV-11 环境解析只认生产字样：守住位置 判定函数；改错故障 拼写错误被当成生产环境。
// INV-12 产品身份与后端环境分轴：守住位置 入参构造；改错故障 更新入口在错误渠道展示。
// INV-13 端来源按环境回退：守住位置 空值合并链；改错故障 测试包连到生产域名。
// INV-14 本地开发标记按模式判定：守住位置 定义常量；改错故障 生产包开启本地运行时。
// INV-15 定义项全部序列化为字符串：守住位置 定义表；改错故障 注入值变成表达式。
// INV-16 资源基路径保持相对：守住位置 基路径字段；改错故障 文件协议下资源加载失败。
// INV-17 生产不暴露映射入口：守住位置 映射分支；改错故障 客户端可还原业务源码。
// INV-18 多入口覆盖全部窗口：守住位置 输入表；改错故障 权限浮窗构建缺失。
//
// 模块职责：桌面端渲染层的构建配置，含覆盖率插桩与多入口。
// 状态所有权：环境与构建元数据在配置求值时一次读取，产物内只留常量。
// 阅读顺序：先看插件与别名，再看环境定义，最后看构建输出。
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveZCodeEndpointOrigin } from "@zcode/shared/zcodeEndpoint";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";

// 动态加载仓库根的构建工具，避免配置打包后其 import.meta.dirname 被重定位到 desktop。
// 构建期可选能力（ARMS、事件上报、自动更新），见 docs/desktop/build-time-optional-capabilities.md
const { resolveBuildTimeConfig, createBuildTimeConfigDefines } = await import(
  pathToFileURL(resolve(__dirname, "../../scripts/build-time-config.mjs")).href
);
// buildTimeConfigDefines 来自仓库根的 build-time-config.mjs。
// pathToFileURL() 动态导入，避免 import.meta.dirname 被重定位。
// resolveBuildTimeConfig() 与 createBuildTimeConfigDefines() 都接收 process.env。
// 结果并入 buildTimeConfigDefines，供 define 统一注入。
const buildTimeConfigDefines = createBuildTimeConfigDefines(
  await resolveBuildTimeConfig(process.env),
);

const buildMetadata = getBuildMetadata();
const desktopRequire = createRequire(import.meta.url);

interface IstanbulInstrumenter {
  instrumentSync(sourceCode: string, filename: string): string;
  lastFileCoverage(): unknown;
  lastSourceMap(): object | null;
}

interface IstanbulLibInstrument {
  createInstrumenter(options: {
    autoWrap: boolean;
    compact: boolean;
    coverageGlobalScope: string;
    coverageGlobalScopeFunc: boolean;
    esModules: boolean;
    parserPlugins: string[];
    preserveComments: boolean;
    produceSourceMap: boolean;
  }): IstanbulInstrumenter;
}

const { createInstrumenter } = desktopRequire("istanbul-lib-instrument") as IstanbulLibInstrument;

function resolveInstalledPackageRoot(packageName: string): string {
  return dirname(desktopRequire.resolve(`${packageName}/package.json`));
}

// resolveInstalledPackageRoot() 返回 dirname(desktopRequire.resolve()) 的真实根。
// 按真实安装根解析，兼容 pnpm 的不同 node-linker 布局。
// react、react-dom、lucide-react 三个依赖保持同源。
// desktopRendererDependencyAliases 的键集与去重表同集合。
export const desktopRendererDependencyAliases = {
  // pnpm hoisted/package-local 布局会随安装配置变化；硬编码 node_modules 子路径
  // 会让 Rolldown 依赖优化把 react/jsx-runtime 等入口解析到不存在的位置。
  // 通过 Node 解析真实安装根目录，既保留单 React runtime，又兼容不同 node-linker。
  react: resolveInstalledPackageRoot("react"),
  "react-dom": resolveInstalledPackageRoot("react-dom"),
  "lucide-react": resolveInstalledPackageRoot("lucide-react"),
} as const;

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

function createE2EUIRendererCoveragePlugin(repoRoot: string): Plugin {
  const sourceRoots = [
    resolve(repoRoot, "packages/ui/src"),
    resolve(repoRoot, "packages/desktop/src/renderer"),
  ].map(normalizePathForVite);
  const instrumenter = createInstrumenter({
    autoWrap: true,
    compact: false,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    parserPlugins: ["typescript", "jsx"],
    preserveComments: true,
    produceSourceMap: true,
  });
  const baselineCoverage: Record<string, unknown> = {};
  const baselinePath = resolve(
    repoRoot,
    "packages/desktop/out/renderer/e2e-coverage-baseline.json",
  );

  return {
    name: "zcode:e2e-ui-source-coverage",
    enforce: "pre",
    transform(sourceCode, id, options) {
      if (options?.ssr || id.startsWith("\0")) {
        return null;
      }
      const filename = stripViteRequestQuery(id);
      const absoluteFilename = isAbsolute(filename) ? filename : resolve(repoRoot, filename);
      const normalizedFilename = normalizePathForVite(absoluteFilename);
      if (!shouldInstrumentE2EUISource(normalizedFilename, sourceRoots)) {
        return null;
      }

      // post-transform 插桩依赖 Vite/React/esbuild 的合并 sourcemap，
      // 会把生成后的 JS 覆盖点反投影到 import、interface 等 TS 源码行上。
      // 这里先对原始 TS/TSX AST 插桩，再交给 Vite 编译，保证 coverage map 只包含真实运行时代码。
      const code = instrumenter.instrumentSync(sourceCode, normalizedFilename);
      baselineCoverage[normalizedFilename] = JSON.parse(
        JSON.stringify(instrumenter.lastFileCoverage()),
      );
      return {
        code,
        map: instrumenter.lastSourceMap(),
      };
    },
    closeBundle() {
      // 只读取页面 __coverage__ 会让从未加载的 lazy chunk 消失，分母被缩小。
      // coverage build 将完整 renderer graph 的零命中 map 留给 suite reporter 合并。
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(baselineCoverage, null, 2)}\n`, "utf-8");
    },
  };
}

function shouldInstrumentE2EUISource(filename: string, sourceRoots: string[]) {
  return (
    isCoverageSourceFile(filename) &&
    !filename.includes("/node_modules/") &&
    !isDeclarationFile(filename) &&
    !isTestSourceFile(filename) &&
    sourceRoots.some((sourceRoot) => isInsidePath(filename, sourceRoot))
  );
}

function isCoverageSourceFile(filename: string) {
  return [".cts", ".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(filename));
}

function isDeclarationFile(filename: string) {
  return /\.d\.[cm]?ts$/u.test(filename);
}

function isTestSourceFile(filename: string) {
  return /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filename);
}

function isInsidePath(filename: string, directory: string) {
  return filename === directory || filename.startsWith(`${directory}/`);
}

function normalizePathForVite(path: string) {
  return path.replaceAll("\\", "/");
}

function stripViteRequestQuery(id: string) {
  return id.split("?")[0] ?? id;
}

// loadEnv() 只从 .env* 读取链接常量。
// 产品身份与 ZCODE_ENV 后端环境分轴注入。
// 覆盖率插件只在 coverage 开关打开时动态加载。
// 构建输出关闭生产 sourcemap 入口。
export default defineConfig(({ mode }) => {
  // `.env*` 只提供链接常量；当前产品环境由启动脚本或 CI 注入 ZCODE_ENV。
  const env = loadEnv(mode, "../..", "");
  const repoRoot = resolve(__dirname, "../..");
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  // 安装包身份与后端环境分轴；renderer 用它决定是否展示更新入口。
  const zcodeProductFlavor = resolveDesktopProductFlavor({
    ...process.env,
    ...env,
    ZCODE_ENV: zcodeEnv,
  });
  const e2eCoverageEnabled =
    env.ZCODE_E2E_COVERAGE === "1" || process.env.ZCODE_E2E_COVERAGE === "1";
  const e2eStoreBridgeEnabled =
    env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" || process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1";
  const zcodeEndpointOrigin = resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin:
      env.ZCODE_BASE_URL ??
      env.ZCODE_ENDPOINT_ORIGIN ??
      (zcodeEnv === "production" ? env.ZCODE_PRODUCTION_BASE_URL : env.ZCODE_TEST_BASE_URL),
  });
  const codingPlanWebviewOrigin =
    env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? process.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? "";
  const plugins = [
    ...(e2eCoverageEnabled ? [createE2EUIRendererCoveragePlugin(repoRoot)] : []),
    pdfJsCMapsPlugin(),
    react(),
    tailwindcss(),
  ];

  return {
    root: "src/renderer",
    plugins,
    resolve: {
      alias: {
        // 修复 UI 组件库中的 @ 别名解析失败。
        // 问题原因：desktop 会直接打包 packages/ui 的源码，但当前 Vite 配置不知道 @ 应该指向 packages/ui/src，
        // 导致 spinner、alert 等组件里的内部导入在构建时全部失效。
        // 这里在消费端补齐别名，比逐个改组件导入更稳，也能和 web 端保持一致。
        "@": resolve(__dirname, "../ui/src"),
        ...desktopRendererDependencyAliases,
        // Recharts 通过 d3-shape 读取 d3-path 的 Path 导出；hoisted node_modules
        // 里可能残留 d3-shape/node_modules/d3-path@1.x，Vite 预构建会优先命中旧包并报 Missing export。
        // 这里把 d3-path 固定到根部 3.x 入口，确保桌面端依赖优化和运行时解析一致。
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
      dedupe: ["react", "react-dom", "lucide-react"],
    },
    server: { port: 5174, strictPort: true },
    define: {
      __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
      __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(buildMetadata.minCompatibleVersion),
      __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
      __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
      ...buildTimeConfigDefines,
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(mode !== "production"),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // 兼容旧 renderer 读取名；新代码统一读 VITE_ZCODE_BASE_URL。
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN": JSON.stringify(codingPlanWebviewOrigin),
      "import.meta.env.VITE_REWARDS_WEBVIEW_ORIGIN": JSON.stringify(env.VITE_REWARDS_WEBVIEW_ORIGIN ?? process.env.VITE_REWARDS_WEBVIEW_ORIGIN ?? ""),
      // Bugfix: E2E store bridge 只能由 WDIO 专用变量打开，避免把 ZCODE_ENV=test 产品环境误当成测试运行态。
      "import.meta.env.VITE_ZCODE_E2E_STORE_BRIDGE": JSON.stringify(
        e2eStoreBridgeEnabled ? "1" : "",
      ),
    },
    // Electron 用 file:// 协议加载页面，资源路径必须是相对路径，否则会 ERR_FILE_NOT_FOUND
    base: "./",
    worker: {
      rollupOptions: {
        // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
        // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
        // 只关闭 worker 构建的摇树，避免影响主包。
        treeshake: false,
      },
    },
    build: {
      outDir: "../../out/renderer",
      emptyOutDir: true,
      // 生产包若直接暴露 sourceMappingURL，攻击者可在客户端侧还原业务源码。
      // 生产使用 hidden sourcemap：本地/发布流程保留 .map，不在产物里暴露映射入口。
      sourcemap: mode === "production" ? "hidden" : true,
      rollupOptions: {
        // 多入口：主窗口 + 进程监控 + CUA 权限拖拽浮窗
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          "resource-manager": resolve(__dirname, "src/renderer/resource-manager.html"),
          "cua-permission-panel": resolve(__dirname, "src/renderer/cua-permission-panel.html"),
          // 插件 UI 沙箱的受信 shell，经 zcode-sandbox:// 提供
          "plugin-sandbox": resolve(__dirname, "src/renderer/plugin-sandbox.html"),
        },
      },
    },
  };
});
