/**
 * Android Gradle 项目发现与脚手架生成。
 *
 * 职责边界：发现 settings.gradle/AndroidManifest/build.gradle 等文件，提取模块、applicationId、APK 与配置告警；
 * create() 借助 project-template 生成最小工程。
 * 副作用：discover 只读遍历文件系统（advisory 深度 5）；create 会 mkdir + 写文件，可能覆盖既有工程（需 overwrite）。
 * 失败语义：遍历读取失败多以空结果降级；create 在文件已存在且未允许覆盖时抛错，参数非法也抛错。
 * 返回口径：discover 的 root/gradleRoots 为相对传入 dir 的路径，"." 表示当前目录；create 返回相对 cwd 的路径。
 * 不变式：遍历时跳过 node_modules/build/.gradle 与隐藏目录，避免扫描构建产物导致性能与误匹配问题。
 */
import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inside } from "../lib/path.js";
import { androidApiLevel } from "./config.js";
import { templateFiles } from "./project-template.js";
import { sdkRoot } from "./sdk.js";

/**
 * 项目发现结果。
 * root 可能为 undefined（未找到 Gradle 根），此时其它字段为空数组；
 * warnings 给出缺失 wrapper/local.properties 等高价值提示，不阻断后续流程。
 */
type Found = {
  root?: string;
  gradleRoots: string[];
  modules: string[];
  variants: string[];
  applicationIds: string[];
  manifests: string[];
  apks: string[];
  hasWrapper: boolean;
  hasGradleProperties: boolean;
  hasLocalProperties: boolean;
  warnings: string[];
};

/**
 * 扫描目录并汇总 Android 项目元信息。
 *
 * 输入 dir 为搜索起点（默认 cwd），只向下遍历 5 层，避免大仓库全量扫描。
 * 副作用：只读文件系统；读取 settings/manifest 时失败被吞掉并降级为空配置。
 * 失败语义：整体不抛错，找不到 Gradle 根时 root=undefined 且各列表为空，由调用方给出引导。
 * 不变式：优先选择 dir 本身的 settings.gradle（relative 路径为空串），其次第一个命中的子目录。
 */
export async function discover(dir = process.cwd()): Promise<Found> {
  const gradleRoots: string[] = [];
  const manifests: string[] = [];
  await walkProjectFiles(dir, 5, async (file, item) => {
    if (item.isFile() && /^settings\.gradle(\.kts)?$/.test(item.name))
      gradleRoots.push(path.relative(dir, path.dirname(file)));
    if (item.isFile() && item.name === "AndroidManifest.xml")
      manifests.push(path.relative(dir, file));
  });

  // 空串代表 Gradle 根就在 dir 本身，优先级高于任何子目录，避免误选嵌套示例工程。
  const root = gradleRoots.find((item) => item === "") ?? gradleRoots[0];
  const absRoot = root === undefined ? undefined : path.join(dir, root);
  const modules = absRoot ? await modulesFor(absRoot) : [];
  const ids = absRoot ? await applicationIds(absRoot) : [];
  const apks = absRoot
    ? (await findApks(absRoot, modules)).map((file) => path.relative(dir, file))
    : [];
  const hasWrapper = absRoot
    ? await exists(path.join(absRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew"))
    : false;
  const hasGradleProperties = absRoot
    ? await exists(path.join(absRoot, "gradle.properties"))
    : false;
  const hasLocalProperties = absRoot ? await exists(path.join(absRoot, "local.properties")) : false;
  const warnings = projectWarnings({ hasWrapper, hasGradleProperties, hasLocalProperties });

  return {
    root,
    gradleRoots,
    modules,
    variants: ["debug"],
    applicationIds: ids,
    manifests,
    apks,
    hasWrapper,
    hasGradleProperties,
    hasLocalProperties,
    warnings,
  };
}

/**
 * 根据关键配置文件是否存在生成告警文案。
 *
 * 这些缺失通常不会让发现失败，但会让后续 Gradle 构建失败或 SDK 定位失败，
 * 因此提前作为 warnings 返回，让模型在构建前就能提示用户补齐。
 */
function projectWarnings(input: {
  hasWrapper: boolean;
  hasGradleProperties: boolean;
  hasLocalProperties: boolean;
}): string[] {
  const warnings: string[] = [];
  if (!input.hasGradleProperties) {
    warnings.push(
      "Missing gradle.properties. Add android.useAndroidX=true for AndroidX/Compose projects.",
    );
  }
  if (!input.hasLocalProperties) {
    warnings.push(
      "Missing local.properties. Add sdk.dir=<Android SDK path> when Gradle cannot infer the SDK from the environment.",
    );
  }
  if (!input.hasWrapper) {
    warnings.push("Missing Gradle wrapper. Install Gradle or generate ./gradlew before building.");
  }
  return warnings;
}

/**
 * 生成最小 Android 工程（Kotlin + Compose）并写入磁盘。
 *
 * 输入 name 会被清洗成合法标识符，dir 经 inside() 限制在工作区内，packageName/minSdk/compileSdk 均校验；
 * 副作用：递归创建目录并写入模板文件，模板内容由 project-template 提供。
 * 失败语义：overwrite=false 且任一目标文件已存在时抛错并列出冲突文件，绝不静默覆盖；
 * 参数非法（名称无可识别字符、包名不合规、SDK 级别越界）分别抛错。
 * 返回口径：files 为写入的相对路径列表，applicationId 为最终包名，root 为相对 cwd 的目录。
 */
export async function create(input: {
  name: string;
  packageName?: string;
  dir?: string;
  minSdk?: number;
  compileSdk?: number;
  overwrite?: boolean;
}) {
  const cwd = process.cwd();
  const name = cleanName(input.name);
  const root = inside(cwd, input.dir || name);
  const pkg = packageName(input.packageName || `com.example.${slug(name)}`);
  const minSdk = sdkLevel(input.minSdk ?? 23, "minSdk");
  const compileSdk = sdkLevel(input.compileSdk ?? androidApiLevel(), "compileSdk");
  const files = templateFiles(root, pkg, await sdkRoot());

  // 未显式允许覆盖时，先探测所有目标文件；任一已存在就整体拒绝，避免生成出半新半旧的工程。
  if (!input.overwrite) {
    const hits = await present(files.map((item) => item.path));
    if (hits.length) {
      throw new Error(
        `Refusing to overwrite existing Android app files: ${hits.map((file) => path.relative(cwd, file)).join(", ")}`,
      );
    }
  }

  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.body({ name, pkg, minSdk, compileSdk }), "utf8");
  }

  return {
    root: path.relative(cwd, root) || ".",
    module: "app",
    variant: "debug",
    applicationId: pkg,
    files: files.map((file) => path.relative(cwd, file.path)),
    createdBy: "template",
    note: "Build uses ./gradlew when present. If the wrapper is missing, android_build_app can generate it with gradle from PATH.",
  };
}

/**
 * 从 settings.gradle(.kts) 的 include(...) 声明解析模块名。
 *
 * 优先 Kotlin DSL 文件，缺失时读 Groovy；读取失败降级为空串，再回退 ["app"]，
 * 保证即使 settings 解析不到也能继续构建默认模块。
 */
async function modulesFor(root: string): Promise<string[]> {
  const settings =
    (await readFile(path.join(root, "settings.gradle.kts"), "utf8").catch(() => undefined)) ??
    (await readFile(path.join(root, "settings.gradle"), "utf8").catch(() => ""));
  const modules = [...settings.matchAll(/include\(([^)]+)\)/g)]
    .flatMap((match) =>
      [...String(match[1]).matchAll(/["'](:[^"']+)["']/g)].map((hit) => hit[1] ?? ""),
    )
    .filter(Boolean);
  return modules.length ? modules : ["app"];
}

/**
 * 扫描 build.gradle(.kts) 与 AndroidManifest.xml，收集 applicationId/namespace/package。
 * 用 Set 去重，顺序不保证；读取失败按空文本处理，不阻断发现流程。
 */
async function applicationIds(root: string): Promise<string[]> {
  const ids = new Set<string>();
  await walkProjectFiles(root, 5, async (file, item) => {
    if (!item.isFile()) return;
    if (/build\.gradle(\.kts)?$/.test(item.name)) {
      const text = await readFile(file, "utf8").catch(() => "");
      for (const match of text.matchAll(
        /(?:applicationId|namespace)\s*(?:=|\s)\s*["']([^"']+)["']/g,
      )) {
        if (match[1]) ids.add(match[1]);
      }
    }
    if (item.name === "AndroidManifest.xml") {
      const text = await readFile(file, "utf8").catch(() => "");
      const match = text.match(/\bpackage=["']([^"']+)["']/);
      if (match?.[1]) ids.add(match[1]);
    }
  });
  return [...ids];
}

/**
 * 在模块构建输出目录中查找 APK。
 *
 * 同时搜索各模块的 build/outputs/apk 与根项目同名目录（多模块共享产物场景），
 * 深度限制 5 层，结果去重；目录不存在时返回空数组而非抛错。
 */
export async function findApks(root: string, modules: string[] = []): Promise<string[]> {
  const names = modules.length ? modules.map((item) => item.replace(/^:+/, "") || "app") : ["app"];
  const roots = [
    ...names.map((name) => path.join(root, name, "build", "outputs", "apk")),
    path.join(root, "build", "outputs", "apk"),
  ];
  const hits = await Promise.all(roots.map((dir) => walkApks(dir, 5)));
  return unique(hits.flat());
}

/**
 * 递归遍历项目文件并对每个条目回调。
 *
 * 跳过隐藏文件/目录与 node_modules/build/.gradle：这些目录体积大且不属于源码，
 * 扫描它们既慢又可能把构建产物中的同名文件误识别为项目配置。
 * 读取目录失败降级为空列表，保证个别权限问题不阻断整体发现；depth 为负即停止。
 */
async function walkProjectFiles(
  dir: string,
  depth: number,
  cb: (file: string, item: Dirent) => Promise<void>,
): Promise<void> {
  if (depth < 0) return;
  const items: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    items
      .filter(
        (item) =>
          !item.name.startsWith(".") && !["node_modules", "build", ".gradle"].includes(item.name),
      )
      .map(async (item) => {
        const file = path.join(dir, item.name);
        await cb(file, item);
        if (item.isDirectory()) await walkProjectFiles(file, depth - 1, cb);
      }),
  );
}

/**
 * 递归收集目录下的 .apk 文件。
 * 只按扩展名与文件类型判断，读取失败返回空数组；不跟随符号链接，避免环状目录导致无限递归。
 */
async function walkApks(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      items
        .filter((item) => !item.name.startsWith("."))
        .map(async (item) => {
          const file = path.join(dir, item.name);
          if (item.isFile() && item.name.endsWith(".apk")) return [file];
          if (item.isDirectory()) return walkApks(file, depth - 1);
          return [];
        }),
    )
  ).flat();
}

/**
 * 返回入参中实际已存在的文件列表，用于覆盖前的冲突检测。
 */
async function present(files: string[]): Promise<string[]> {
  return (
    await Promise.all(
      files.map(async (file) => {
        const hit = await exists(file);
        return hit ? file : undefined;
      }),
    )
  ).filter((file): file is string => file !== undefined);
}

/**
 * 判断路径是否可访问；任何错误（不存在、权限不足）都返回 false。
 */
async function exists(file: string): Promise<boolean> {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

/**
 * 把用户输入的工程名清洗成可用标识符：仅保留字母数字下划线，数字开头加 App 前缀。
 * 清洗后为空说明没有任何可用字符，直接抛错，避免生成无法引用的工程名。
 */
function cleanName(value: string): string {
  const out = value.replace(/[^A-Za-z0-9_]/g, "");
  if (!out) throw new Error("App name must contain letters or numbers.");
  if (/^[0-9]/.test(out)) return `App${out}`;
  return out;
}

/**
 * 校验 Android 包名：至少两段、每段以字母开头且只含字母数字下划线。
 * 非法时抛错，防止值被写入 Gradle 脚本后引发难以定位的构建错误。
 */
function packageName(value: string): string {
  const parts = value.split(".");
  const good = parts.length > 1 && parts.every((part) => /^[A-Za-z][A-Za-z0-9_]*$/.test(part));
  if (!good) throw new Error(`Invalid Android package name: ${value}`);
  return value;
}

/**
 * 校验 SDK 级别：必须为 21~99 的整数，覆盖 Android 5.0 以上的合理范围。
 */
function sdkLevel(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 21 || value > 99)
    throw new Error(`Invalid ${field}: ${value}`);
  return value;
}

/**
 * 把工程名转成包名可用的 slug：非字母数字替换为下划线、合并连续下划线、去掉首尾下划线并小写。
 * 数字开头补 app_ 前缀；结果为空时回退 "app"，保证默认包名始终合法。
 */
function slug(value: string): string {
  const out = value
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  if (/^[0-9]/.test(out)) return `app_${out}`;
  return out || "app";
}

/**
 * 字符串数组去重，保留首次出现顺序。
 */
function unique(items: string[]): string[] {
  return [...new Set(items)];
}
