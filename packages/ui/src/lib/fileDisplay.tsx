// 职责边界（fileDisplay）
// 做：把一条路径解析成「图标名 + 图标地址 + 文件名 + 目录」的展示描述符，
// 做：补齐 material-icons 的资源前缀与两级图标回退，供 React 组件与原生 DOM 两条出口共用。
// 不做：不判断扩展名语义、不裁剪长路径、不测量溢出，交给 fileDisplayHelpers 与调用方 truncate。
// 依赖：path.js 的 getPathLeaf/isAbsoluteFilePath、fileDisplayHelpers.js 的规范化与扩展名映射、import.meta.env.BASE_URL。
// 边界：helpers 里导入的 getIconPalette/getIconLabel/buildInlineSvgDataUrl 在本文件未被使用，图标已改为 img 直接加载 svg。
//
// INV 不变量表（18 条；每条都是「看起来能改、其实不该动」的约束）
// INV-01 断言：内联兜底图标必须自包含成 data URL，不依赖 public 资源；守住位置：INLINE_FALLBACK_FILE_ICON_SRC 常量；改错故障：素材目录缺失时整屏破图，没有任何可用占位。
// INV-02 断言：图标资源前缀只能从运行时 BASE_URL 派生，不得写死 /material-icons；守住位置：resolveMaterialIconBasePath；改错故障：Electron 把绝对路径解析到磁盘根目录，全部图标 404。
// INV-03 断言：base URL 必须收敛成恰好一个结尾斜杠，方向统一；守住位置：resolveMaterialIconBasePath 的 return；改错故障：desktop 的 ./ 与根相对拼接出双斜杠，资源命中不了。
// INV-04 断言：图标地址固定为 <base>material-icons/<名字>.svg，名字里不带扩展名；守住位置：buildMaterialFileIconSrc；改错故障：拼接出 document.svg.svg，所有文件图标失效。
// INV-05 断言：默认文档与目录图标在模块求值时固化一次，不在渲染期重算；守住位置：FOLDER_FILE_ICON_SRC 与 DOCUMENT_FILE_ICON_SRC；改错故障：测试在加载后改环境变量不生效，图标仍指向旧前缀。
// INV-06 断言：文件夹与文件的视觉区分只看 kind 是否为 directory；守住位置：resolveFileDisplayDescriptor 的 fileIcon 分支；改错故障：目录显示成文档图标，用户无法区分层级。
// INV-07 断言：未知扩展名必须回落 document，不得返回空串或裸扩展名；守住位置：resolveIconName 的空值合并与 fileIcon 赋值；改错故障：img 指向不存在的 svg，行内出现破图。
// INV-08 断言：文件名取路径末段，且先统一分隔符、裁掉尾部斜杠；守住位置：getPathLeaf 与 normalizePath 的调用顺序；改错故障：文件名显示成整条路径，或以空串结尾。
// INV-09 断言：目录路径只在规范化字符串里真实出现 /文件名 时给出，否则为 null；守住位置：buildFilePath；改错故障：展示出与文件名重复的伪目录，读者误判文件位置。
// INV-10 断言：目录路径保留结尾斜杠，调用方不再补分隔符；守住位置：buildFilePath 的切片边界；改错故障：目录与文件名黏连成一段，无法复制区分。
// INV-11 断言：剥离基路径只认「完整路径段 + 斜杠」前缀，不做裸字符串前缀匹配；守住位置：stripBasePath 的前缀分支；改错故障：workspace2 被 workspace 误剥成 2，路径展示错乱。
// INV-12 断言：路径与基路径完全相同时返回空串，由上层回落成文件名；守住位置：stripBasePath 的相等分支；改错故障：路径区出现空串或退化成整条绝对路径。
// INV-13 断言：basePath 优先级为调用方显式值、模块默认值、无基路径依次递减；守住位置：resolveFileDisplayDescriptor 的 effectiveBasePath；改错故障：显式传参被全局默认值顶掉，相对路径算错。
// INV-14 断言：模块级默认基路径是唯一的可变全局状态，只经 setter 写入；守住位置：setDefaultFileDisplayBasePath；改错故障：用例间状态泄漏，上一个工作区的路径影响下一次展示。
// INV-15 断言：图标回退最多两级且只前进不回环，已是内联兜底就停止；守住位置：resolveFallbackFileIconSrc；改错故障：默认素材也缺失时 error 事件自激，浏览器持续重试导致卡顿。
// INV-16 断言：React 侧图标地址必须随描述符变化重置，不能只在挂载时初始化；守住位置：FileDisplayInline 与 FileDisplayIcon 的 effect；改错故障：列表复用节点时上一行的图标串到下一行。
// INV-17 断言：图标是纯装饰，alt 恒为空串并带 aria-hidden，无障碍名只来自文件名；守住位置：两条渲染出口的 img；改错故障：读屏先念一遍图标再念文件名，语义重复。
// INV-18 断言：DOM 出口与 React 出口共用同一描述符与同一类名基线语义；守住位置：createFileDisplayDom 与两个组件；改错故障：同一文件在输入框与列表里尺寸颜色不一致。
//
// 总述：收益在「路径到描述符」这一步收敛，组件只负责把描述符铺成节点。
// 总述：改图标路径、回退层级、basePath 优先级之前，先确认它守的是哪条 INV。
//
import { useEffect, useState, type ReactElement } from "react";
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import {
  DEFAULT_FILE_ICON_NAME,
  normalizePath,
  trimTrailingSeparator,
  resolveIconName,
  getIconPalette,
  getIconLabel,
  buildInlineSvgDataUrl,
} from "@/lib/fileDisplayHelpers.js";

// [资源] 内联 SVG 直接编进常量，不依赖 public 目录，任何运行环境都能渲染。
// [失败路径] 素材整体缺失时的最后一道兜底，必须始终是合法的 data:image/svg+xml 地址。
// [权衡] 整段标签走 encodeURIComponent，体积略大，换取不转义 # 与引号带来的解析歧义。
export const INLINE_FALLBACK_FILE_ICON_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M4.5 1.5h4.586L12.5 4.914V13a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3.5 13V3A1.5 1.5 0 0 1 5 1.5Z" stroke="%2394A3B8" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.75V5h3.25" stroke="%2394A3B8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
let defaultFileDisplayBasePath: string | null = null;

// [契约] fileIconSrc 始终是可被 img 加载的地址，永不为空串，调用方无需再判空。
// [契约] filePath 为 null 表示只展示文件名，非 null 时已带结尾斜杠。
// [契约] normalizedPath 保留为调试与二次解析用，展示层不应直接拿它渲染。
export interface FileDisplayDescriptor {
  fileIcon: string;
  fileIconSrc: string;
  fileName: string;
  filePath: string | null;
  normalizedPath: string;
}

export interface FileDisplayOptions {
  basePath?: string;
  kind?: "file" | "directory";
  showIcon?: boolean;
  showFilePath?: boolean;
  iconSize?: number;
  className?: string;
  fileNameClassName?: string;
  filePathClassName?: string;
}

// [事务] 全局默认基路径只有这一个写入点，模块加载时为 null，测试可在用例内切换再复原。
// [并发] 写入不加锁：多窗口共用同一模块实例时后写者覆盖前者，只适用于启动期配置。
// [权衡] 不把基路径放进 React context，换取 createFileDisplayDom 这类非组件出口也能读到同一份值。
export function setDefaultFileDisplayBasePath(basePath: string | null) {
  defaultFileDisplayBasePath = basePath;
}

// [资源] web 端 public 挂在根路径，desktop 端用 file:// 且 base 为 ./，只能靠运行时的 BASE_URL 区分。
// [失败路径] 若把路径写死成 /material-icons，Electron 会解析到磁盘根目录，文件图标全部 404。
// [权衡] 读 import.meta.env 前先判 typeof import.meta，避免非 Vite 运行环境直接抛错。
function resolveMaterialIconBasePath(): string {
  const baseUrl =
    typeof import.meta !== "undefined" &&
    typeof import.meta.env?.BASE_URL === "string"
      ? import.meta.env.BASE_URL
      : "/";

  // web 端 public 资源挂在根路径下，desktop 端则使用 file:// + base="./"。
  // 之前把图标路径写死成 /material-icons，Electron 会把它解析到磁盘根目录，导致 file icon 全部 404。
  // 这里统一基于运行时 base URL 生成资源路径，让 desktop/web 都命中各自的 public/material-icons。
  return `${baseUrl.replace(/\/?$/, "/")}material-icons`;
}

export function buildMaterialFileIconSrc(iconName: string): string {
  return `${resolveMaterialIconBasePath()}/${iconName}.svg`;
}

function buildIconSrc(iconName: string): string {
  return buildMaterialFileIconSrc(iconName);
}

// [契约] 两个导出常量在模块求值时就固化成字符串，供列表批量复用，不再逐次拼路径。
// [契约] 目录图标固定 folder、文件默认 document，二者是未知类型时的语义锚点。
// [资源] 常量求值依赖 BASE_URL，测试若在模块加载后再改环境变量，结果不会跟着变。
export const FOLDER_FILE_ICON_SRC = buildMaterialFileIconSrc("folder");
export const DOCUMENT_FILE_ICON_SRC = buildMaterialFileIconSrc(
  DEFAULT_FILE_ICON_NAME,
);

// [失败路径] 回退两级：任意图标失败先回 document，document 再失败才回内联 data URL。
// [失败路径] 当前已是内联兜底时返回 null，调用方据此停止换地址，避免 error 事件自激循环。
// [权衡] 只按地址后缀识别 document，不查文件是否存在，换取零网络探测与同步决策。
function resolveFallbackFileIconSrc(currentSrc: string): string | null {
  const defaultIconSrc = DOCUMENT_FILE_ICON_SRC;
  if (currentSrc === INLINE_FALLBACK_FILE_ICON_SRC) {
    return null;
  }

  if (currentSrc === defaultIconSrc || currentSrc.endsWith("/document.svg")) {
    // 之前图标缺失最多只会回退到 document.svg。
    // 如果默认素材本身也不存在，界面上仍会出现破图。这里补第二层兜底，
    // 退回内置 data URL 图标，保证不同运行环境都至少有稳定占位。
    return INLINE_FALLBACK_FILE_ICON_SRC;
  }

  return defaultIconSrc;
}

// [事务] 先规范化分隔符再裁尾部斜杠，两侧共用同一套规则，保证前缀比较可比。
// [权衡] 只剥离「完整路径段 + 斜杠」前缀，不用裸前缀匹配，避免 workspace 与 workspace2 互相误伤。
// [失败路径] 路径等于基路径时返回空串，由上层回落成文件名，而不是返回单个斜杠。
function stripBasePath(path: string, basePath?: string): string {
  if (!basePath) {
    return path;
  }

  const normalizedPath = trimTrailingSeparator(normalizePath(path));
  const normalizedBasePath = trimTrailingSeparator(normalizePath(basePath));

  if (normalizedPath === normalizedBasePath) {
    return "";
  }

  if (normalizedPath.startsWith(`${normalizedBasePath}/`)) {
    return normalizedPath.slice(normalizedBasePath.length + 1);
  }

  return path;
}

// [契约] 只在规范化路径里找到 /文件名 的最后一个位置，才切出目录；找不到就返回 null。
// [契约] 返回值保留结尾斜杠，展示时直接拼文件名即可，调用方不再补分隔符。
// [失败路径] 路径就是文件名本身（无目录）时返回 null，避免把文件名当目录重复展示。
function buildFilePath(path: string, fileName: string): string | null {
  const normalizedPath = normalizePath(path);

  if (!normalizedPath || normalizedPath === fileName) {
    return null;
  }

  const fileNameIndex = normalizedPath.lastIndexOf(`/${fileName}`);
  if (fileNameIndex === -1) {
    return null;
  }

  const directoryPath = normalizedPath.slice(0, fileNameIndex + 1);
  return directoryPath.length > 0 ? directoryPath : null;
}

// [契约] 纯函数：同样的路径、选项与模块默认基路径必得同样的描述符，内部不留缓存。
// [契约] 目录优先于扩展名判断，kind 为 directory 时不再看文件名后缀。
// [并发] 读的是模块级默认基路径，调用期间若被 setter 改写，本次可能读到旧值。
export function resolveFileDisplayDescriptor(
  filePath: string,
  options: Pick<FileDisplayOptions, "basePath" | "kind"> = {},
): FileDisplayDescriptor {
  const normalizedPath = normalizePath(filePath);
  const fileName = getPathLeaf(normalizedPath);
  const effectiveBasePath =
    options.basePath ?? defaultFileDisplayBasePath ?? undefined;
  const relativePath = stripBasePath(normalizedPath, effectiveBasePath);
  const resolvedFilePath = buildFilePath(relativePath, fileName);
  const fileIcon =
    options.kind === "directory" ? "folder" : resolveIconName(fileName);

  return {
    fileIcon,
    fileIconSrc: buildIconSrc(fileIcon),
    fileName,
    filePath: resolvedFilePath,
    normalizedPath,
  };
}

// [契约] 与 React 出口共用描述符与默认类名，差异仅在于节点由 createElement 手工拼装。
// [失败路径] img 的 error 监听只换一次地址，回退结果仍失败时保留占位，不再重试。
// [资源] 每次调用都新建 span 与 img，不做节点复用，调用方需自行控制重建频率。
export function createFileDisplayDom(
  filePath: string,
  options: FileDisplayOptions = {},
): HTMLSpanElement {
  const descriptor = resolveFileDisplayDescriptor(filePath, {
    basePath: options.basePath,
    kind: options.kind,
  });
  const container = document.createElement("span");
  container.className =
    options.className ??
    "inline-flex max-w-full items-center gap-1.5 align-middle";

  if (options.showIcon !== false) {
    const icon = document.createElement("img");
    icon.src = descriptor.fileIconSrc;
    icon.alt = "";
    icon.width = options.iconSize ?? 14;
    icon.height = options.iconSize ?? 14;
    icon.className = "shrink-0";
    icon.setAttribute("aria-hidden", "true");
    icon.addEventListener("error", () => {
      const fallbackSrc = resolveFallbackFileIconSrc(icon.src);
      if (!fallbackSrc) {
        return;
      }
      icon.src = fallbackSrc;
    });
    container.append(icon);
  }

  const primary = document.createElement("span");
  primary.className =
    options.fileNameClassName ?? "truncate text-[0.95em] leading-[1.6]";
  primary.textContent = descriptor.fileName;
  container.append(primary);

  if (options.showFilePath && descriptor.filePath) {
    const secondary = document.createElement("span");
    secondary.className =
      options.filePathClassName ??
      "truncate text-[0.85em] text-muted-foreground";
    secondary.textContent = descriptor.filePath;
    container.append(secondary);
  }

  return container;
}

// [状态] 图标地址是本地 state，初始值取描述符，路径变化时不靠重挂载纠正。
// [事务] 描述符的图标地址一变就用 effect 同步回 state，防止列表复用把上一行图标串到下一行。
// [失败路径] 图片加载失败走两级兜底，兜底后仍失败则保留当前地址，不再触发第二次替换。
// [权衡] 每次解析都重算描述符、不做 memo，换取路径变化时零缓存失效问题。
export function FileDisplayInline({
  path,
  options,
}: {
  path: string;
  options?: FileDisplayOptions;
}): ReactElement {
  const descriptor = resolveFileDisplayDescriptor(path, {
    basePath: options?.basePath,
    kind: options?.kind,
  });
  const [fileIconSrc, setFileIconSrc] = useState(descriptor.fileIconSrc);

  useEffect(() => {
    // mention panel 会复用同一批列表项组件，之前这里只在首次渲染时初始化图标 src，
    // 过滤条件或可视区变化后 path 变了但 state 没重置，就会把上一行的图标串到下一行。
    // 这里在解析结果变化时同步重置，确保图标始终跟当前文件扩展名对应。
    setFileIconSrc(descriptor.fileIconSrc);
  }, [descriptor.fileIconSrc]);

  return (
    <span
      className={
        options?.className ?? "inline-flex max-w-full items-center gap-1 "
      }
    >
      {options?.showIcon !== false ? (
        <img
          src={fileIconSrc}
          alt=""
          width={options?.iconSize ?? 16}
          height={options?.iconSize ?? 16}
          className="shrink-0"
          aria-hidden="true"
          onError={() => {
            const fallbackSrc = resolveFallbackFileIconSrc(fileIconSrc);
            if (!fallbackSrc) {
              return;
            }
            setFileIconSrc(fallbackSrc);
          }}
        />
      ) : null}
      <span
        className={
          options?.fileNameClassName ??
          "truncate text-ui-base font-medium text-foreground"
        }
      >
        {descriptor.fileName}
      </span>
      {options?.showFilePath && descriptor.filePath ? (
        <span
          className={
            options.filePathClassName ??
            "truncate text-ui-base text-foreground-subtlest"
          }
        >
          {descriptor.filePath}
        </span>
      ) : null}
    </span>
  );
}

// [状态] src 由 props 驱动，effect 在 src 变化时重置，避免切到下一行时继承上一条的回退状态。
// [契约] 尺寸只由 size 决定，类名完全交给调用方，本组件不注入任何布局约束。
// [失败路径] onError 里先算出兜底地址再更新 state，已是内联兜底时保持原样。
export function FileDisplayIcon({
  src,
  size = 16,
  className,
}: {
  src: string;
  size?: number;
  className?: string;
}): ReactElement {
  const [fileIconSrc, setFileIconSrc] = useState(src);

  useEffect(() => {
    // toolcall 列表项会复用同一套文件图标节点。
    // 如果这里只在首次渲染时保留旧 src，切到下一条文件记录后会把上一条 fallback 状态串过来。
    setFileIconSrc(src);
  }, [src]);

  return (
    <img
      src={fileIconSrc}
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      onError={() => {
        const fallbackSrc = resolveFallbackFileIconSrc(fileIconSrc);
        if (!fallbackSrc) {
          return;
        }
        setFileIconSrc(fallbackSrc);
      }}
    />
  );
}

// [契约] 优先返回剥离基路径后的相对路径，空结果回落成文件名。
// [权衡] 未传基路径且剩余路径仍是绝对路径时，宁可给绝对路径也不给误导性的相对路径。
// [失败路径] 绝对路径判定含盘符与 UNC，Windows 路径不会因为反斜杠被误判成相对路径。
export function getFileDisplayPath(
  filePath: string,
  basePath?: string,
): string {
  const normalizedPath = normalizePath(filePath);
  const pathWithoutBase = stripBasePath(normalizedPath, basePath);

  if (!pathWithoutBase) {
    return getPathLeaf(normalizedPath);
  }

  if (basePath || !isAbsoluteFilePath(pathWithoutBase)) {
    return pathWithoutBase;
  }

  return normalizedPath;
}
