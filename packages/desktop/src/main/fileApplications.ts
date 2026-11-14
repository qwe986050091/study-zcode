// ZCode 桌面端外部应用注册表：把文档与媒体扩展名映射到本机原生应用，并提供候选路径探测。
//
// 纯数据加路径解析模块：三个导出必须分别负责定义清单（getFileApplicationDefs）、扩展名匹配（matchesFileApplication）、把候选路径落成绝对路径（resolveFileApplicationPath）。
// 唯一触盘点是 resolveFileApplicationPath（access / stat / readdir / reg.exe），其余均为纯函数。
// 不变量（INV-01..INV-20）必须每条写明不变量本身、守卫位置、以及被改动后的破坏后果。
// INV-01 平台分派只认 darwin / win32 / linux，其余平台返回空数组。守卫在 getFileApplicationDefs 末尾的 return []。若改成抛错，未知平台会在模块初始化阶段直接崩溃。
// INV-02 每个平台清单按推荐程度降序书写，数组首位是默认优先应用。守卫在各分支返回数组的字面量顺序。调换顺序会改变菜单默认项与用户预期。
// INV-03 id 在同一平台清单内唯一，跨平台允许同名。守卫在 getFileApplicationDefs 的三份清单。重复 id 会让渲染层 key 冲突、偏好读写互相覆盖。
// INV-04 appPath 恒为非空字符串，windows 用 paths[0] ?? "" 兜底，linux 用 /usr/bin/<exe>。守卫在 windows 构造器的 ?? ""。改成 undefined 会让 access 收到非法参数并抛类型错误。
// INV-05 appPath 必须同时是候选集第一项，剩余候选放 appPathCandidates。守卫在 windows 的 paths.slice(1)。若把首项也留在候选里，探测会多跑一次并让日志出现重复条目。
// INV-06 fileExtensions 一律小写且不带前导点。守卫在三个构造器的字面量，以及 matchesFileApplication 的 toLowerCase。改成大写会让匹配静默失效且无任何报错。
// INV-07 文件路径缺失或没有扩展名时匹配结果为 false。守卫在 matchesFileApplication 的三元表达式。若改成默认通配，无扩展名文件会被任意应用认领。
// INV-08 取扩展名前先把反斜杠归一化成斜杠。守卫在 matchesFileApplication 的 replace 调用。省掉归一化会让 Windows 风格路径的 extname 结果随宿主平台漂移。
// INV-09 mac 构造器里以斜杠开头的 bundle 原样使用，相对名补 /Applications 前缀与 .app 后缀。守卫在 bundle.startsWith 判断。改判断会让 /System/Applications/Preview.app 被二次拼接。
// INV-10 mac 候选额外包含 ~/Applications 下同名 app，覆盖用户级安装。守卫在 join(homedir(), "Applications", basename(appPath))。删掉会漏掉非管理员安装的副本。
// INV-11 windows 根目录顺序固定为 ProgramFiles、ProgramFiles(x86)、系统盘兜底两项、LOCALAPPDATA，并去重。守卫在 new Set 与 filter(Boolean)。顺序变化会改变 x64 与 x86 的选择结果。
// INV-12 windows 根目录去重按字符串精确比较，不做路径归一化。守卫在 new Set。若为去重引入 realpath，会在定义阶段产生额外 IO 并可能合并大小写不同的根。
// INV-13 linux 定义的 appPath 固定为 /usr/bin/<exe>，存在性完全交给 resolve 判定。守卫在 linux 构造器。若在定义阶段探测 PATH，清单构建就会变成依赖运行环境的 IO。
// INV-14 LibreOffice 三件套共用同一可执行文件，只能靠 launchArgs 区分 writer、impress、calc。守卫在三处 spread 覆盖。丢掉 launchArgs 会让三个条目都打开起始中心。
// INV-15 windowsVersionRoots 存放的是版本目录的父目录，不是可执行文件目录。守卫在 win32 分支对 wps 的赋值。改变语义会让版本扫描拼出错误前缀。
// INV-16 reg.exe 调用必须带 timeout 与 windowsHide，且参数固定为 query 加 /ve 的只读形式。守卫在 execFile 的 options。去掉 timeout 会让异常注册表键挂死清单构建。
// INV-17 注册表探测只在 win32 且直接候选全部失败后执行。守卫在 direct 命中即返回的提前返回。删掉平台判断会让 darwin 与 linux 无谓地 spawn reg.exe。
// INV-18 注册表值先剥引号再展开 %VAR%，未识别的变量保留原文。守卫在两级 replace 的链式调用。顺序颠倒会让带空格的带引号路径解析失败。
// INV-19 注册表命中的路径必须 stat 且 isFile 双重确认才采信。守卫在 path 与 stat 的联合判断行。去掉 isFile 会把残留的目录当成可执行文件返回。
// INV-20 版本目录按名称数值降序排列，最新版本优先，结果只追加到候选尾部。守卫在 readdir 之后的 sort。去掉 numeric 会让 10.1 按字典序排在 9.1 之前，选中旧版。
//
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, extname, join, win32 } from "node:path";

export interface FileApplicationDef {
  id: string;
  name: string;
  appPath: string;
  appPathCandidates?: string[];
  command: null;
  fileExtensions: readonly string[];
  executableNames?: string[];
  windowsVersionRoots?: string[];
  launchArgs?: string[];
}

// [并发] 每次调用都会 spawn 一个 reg.exe 子进程，本模块不做并发限流，只靠 2s 超时兜底。
// [资源] windowsHide 避免黑窗闪现，timeout 2000ms 让异常键查询以 error 回调结束而不是长期占用句柄。
// [失败路径] 非零退出、超时、reg.exe 缺失都必须让 queryAppPath 走 reject，调用方用 try/catch 吞掉并继续下一个 hive。
// [权衡] 不用同步 execFileSync：那会阻塞主进程事件循环导致窗口白屏，故包成 Promise。
// 只读查询默认值 /ve，不写注册表也不删除，所以无需回滚或事务保护。
const queryAppPath = (key: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "reg.exe",
      ["query", key, "/ve"],
      { windowsHide: true, timeout: 2000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
// [权衡] OFFICE 是可变数组而非 as const，被展开时只读使用，任何 push 都会污染所有 Office 条目。
const OFFICE = ["docx", "pptx", "xlsx"];
// [权衡] 媒体扩展名只有 mp3 与 mp4，quicktime、iina、vlc 共用这一份，新增格式必须同步三平台清单。
const MEDIA = ["mp3", "mp4"];

// mac 构造器把 bundle 约定收敛到一处：调用点只写应用名，路径规则不外泄。
// [失败路径] bundle 拼错不会在此报错，只会在 resolve 的 access 检查处静默落选。
function mac(
  id: string,
  name: string,
  bundle: string,
  fileExtensions: string[],
): FileApplicationDef {
  // [权衡] 用 startsWith 判绝对路径而不调 path.isAbsolute，避免 win32 语义混入 mac 分支。
  const appPath = bundle.startsWith("/") ? bundle : `/Applications/${bundle}.app`;
  return {
    id,
    name,
    appPath,
    appPathCandidates: [join(homedir(), "Applications", basename(appPath))],
    command: null,
    fileExtensions,
  };
}

// windows 构造器把安装根与相对片段的笛卡尔积展开成候选，调用点只描述片段。
// [失败路径] 片段写错时路径不存在，resolve 阶段逐个 access 失败后回落到注册表探测。
function windows(
  id: string,
  name: string,
  relativePaths: string[],
  fileExtensions: string[],
  executableNames: string[],
): FileApplicationDef {
  // [资源] 根目录来源最多五项，filter(Boolean) 会去掉未设置的 env，避免拼出以反斜杠开头的相对路径。
  // [权衡] 顺序决定命中优先，同一应用同时存在于 x64 与 x86 目录时取靠前的根。
  const roots = [
    ...new Set(
      [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        `${process.env.SystemDrive || "C:"}\\Program Files`,
        `${process.env.SystemDrive || "C:"}\\Program Files (x86)`,
        process.env.LOCALAPPDATA,
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  // 先按根、再按片段展开，保留根的优先级，调换嵌套顺序会打乱程序位数偏好。
  // [失败路径] roots 为空时 paths 为空，appPath 落到空串，最终由 resolve 判定为未安装。
  const paths = roots.flatMap((root) => relativePaths.map((path) => win32.join(root, path)));
  return {
    id,
    name,
    // [权衡] 用空串而非 undefined 兜底，保证 appPath 的非空类型契约，调用方不必判空。
    appPath: paths[0] ?? "",
    appPathCandidates: paths.slice(1),
    command: null,
    fileExtensions,
    executableNames,
  };
}

// linux 定义只描述 /usr/bin/<exe> 与可选启动参数，PATH 探测推迟到 resolve。
// [失败路径] 安装到 /usr/local/bin 等非标准位置时，依赖 resolve 的 PATH 补扫兜底。
function linux(
  id: string,
  name: string,
  executable: string,
  fileExtensions: string[],
  launchArgs?: string[],
): FileApplicationDef {
  return {
    id,
    name,
    appPath: `/usr/bin/${executable}`,
    command: null,
    executableNames: [executable],
    fileExtensions,
    launchArgs,
  };
}

// 纯函数：相同 platform 恒得同一份清单与同一顺序，单测可直接断言 id 序列。
// [并发] 每次调用都会新建数组与新对象，调用方增删条目互不影响，但是条目之间不共享引用。
export function getFileApplicationDefs(
  platform: NodeJS.Platform = process.platform,
): FileApplicationDef[] {
  // [权衡] mac 清单是静态字面量而非文件系统探测，冷启动不付出 IO 代价，代价是感知不到用户自定义安装位置。
  if (platform === "darwin")
    return [
      mac("preview", "Preview", "/System/Applications/Preview.app", ["pdf"]),
      mac("adobe-acrobat", "Adobe Acrobat", "Adobe Acrobat DC/Adobe Acrobat", ["pdf"]),
      mac("adobe-reader", "Adobe Acrobat Reader", "Adobe Acrobat Reader", ["pdf"]),
      mac("pdf-expert", "PDF Expert", "PDF Expert", ["pdf"]),
      mac("word", "Microsoft Word", "Microsoft Word", ["docx"]),
      mac("pages", "Pages", "Pages", ["docx"]),
      mac("powerpoint", "Microsoft PowerPoint", "Microsoft PowerPoint", ["pptx"]),
      mac("keynote", "Keynote", "Keynote", ["pptx"]),
      mac("excel", "Microsoft Excel", "Microsoft Excel", ["xlsx"]),
      mac("numbers", "Numbers", "Numbers", ["xlsx"]),
      mac("wps", "WPS Office", "wpsoffice", ["pdf", ...OFFICE]),
      {
        // LibreOffice 三件套共用同一个 .app，只能靠 launchArgs 区分组件。
        // [失败路径] 漏掉 launchArgs 会退化成打开起始中心，三个条目在实际行为上完全等价。
        ...mac("libreoffice-writer", "LibreOffice Writer", "LibreOffice", ["docx"]),
        launchArgs: ["--writer"],
      },
      {
        ...mac("libreoffice-impress", "LibreOffice Impress", "LibreOffice", ["pptx"]),
        launchArgs: ["--impress"],
      },
      {
        ...mac("libreoffice-calc", "LibreOffice Calc", "LibreOffice", ["xlsx"]),
        launchArgs: ["--calc"],
      },
      mac("music", "Music", "/System/Applications/Music.app", ["mp3"]),
      mac("quicktime", "QuickTime Player", "/System/Applications/QuickTime Player.app", MEDIA),
      mac("iina", "IINA", "IINA", MEDIA),
      mac("vlc", "VLC", "VLC", MEDIA),
    ];
  // win32 分支比 mac 与 linux 多一步：先构造 wps 并补版本目录，再并入返回数组。
  // [事务] wps 是刚构造的独占对象，就地赋值 windowsVersionRoots 不会污染其他条目，所以无需拷贝或回滚。
  if (platform === "win32") {
    // WPS 首选启动器 ksolaunch.exe，失败后再回落 wps.exe，两者都登记进 executableNames。
    // [权衡] 先落变量而不是内联字面量，是因为下面还要追加 windowsVersionRoots。
    const wps = windows(
      "wps",
      "WPS Office",
      ["Kingsoft/WPS Office/ksolaunch.exe", "Kingsoft/WPS Office/wps.exe"],
      ["pdf", ...OFFICE],
      ["ksolaunch.exe", "wps.exe"],
    );
    // [资源] 这里只记录版本根，不 readdir，版本枚举再推迟到 resolve，定义阶段不触盘。
    // [失败路径] env 缺失时 join 会拼出相对路径，readdir 抛错后被 catch 吞掉，该根直接失效。
    wps.windowsVersionRoots = [
      win32.join(process.env.LOCALAPPDATA || "", "Kingsoft", "WPS Office"),
      ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
        .filter((root): root is string => Boolean(root))
        .map((root) => win32.join(root, "Kingsoft", "WPS Office")),
    ];
    // [权衡] win32 清单必须按 PDF 阅读器、Office、WPS、LibreOffice、浏览器、播放器分组，Edge 作为系统必装兜底排在 PDF 组尾部。
    return [
      windows(
        "adobe-acrobat",
        "Adobe Acrobat",
        ["Adobe/Acrobat DC/Acrobat/Acrobat.exe"],
        ["pdf"],
        ["Acrobat.exe"],
      ),
      windows(
        "adobe-reader",
        "Adobe Acrobat Reader",
        ["Adobe/Acrobat Reader DC/Reader/AcroRd32.exe", "Adobe/Reader 11.0/Reader/AcroRd32.exe"],
        ["pdf"],
        ["AcroRd32.exe"],
      ),
      windows(
        "foxit",
        "Foxit PDF Reader",
        ["Foxit Software/Foxit PDF Reader/FoxitPDFReader.exe"],
        ["pdf"],
        ["FoxitPDFReader.exe"],
      ),
      windows(
        "word",
        "Microsoft Word",
        ["Microsoft Office/root/Office16/WINWORD.EXE", "Microsoft Office/Office16/WINWORD.EXE"],
        ["docx"],
        ["WINWORD.EXE"],
      ),
      windows(
        "powerpoint",
        "Microsoft PowerPoint",
        ["Microsoft Office/root/Office16/POWERPNT.EXE", "Microsoft Office/Office16/POWERPNT.EXE"],
        ["pptx"],
        ["POWERPNT.EXE"],
      ),
      windows(
        "excel",
        "Microsoft Excel",
        ["Microsoft Office/root/Office16/EXCEL.EXE", "Microsoft Office/Office16/EXCEL.EXE"],
        ["xlsx"],
        ["EXCEL.EXE"],
      ),
      wps,
      {
        ...windows(
          "libreoffice-writer",
          "LibreOffice Writer",
          ["LibreOffice/program/soffice.exe"],
          ["docx"],
          ["soffice.exe"],
        ),
        launchArgs: ["--writer"],
      },
      {
        ...windows(
          "libreoffice-impress",
          "LibreOffice Impress",
          ["LibreOffice/program/soffice.exe"],
          ["pptx"],
          ["soffice.exe"],
        ),
        launchArgs: ["--impress"],
      },
      {
        ...windows(
          "libreoffice-calc",
          "LibreOffice Calc",
          ["LibreOffice/program/soffice.exe"],
          ["xlsx"],
          ["soffice.exe"],
        ),
        launchArgs: ["--calc"],
      },
      windows(
        "edge",
        "Microsoft Edge",
        ["Microsoft/Edge/Application/msedge.exe"],
        ["pdf"],
        ["msedge.exe"],
      ),
      windows(
        "windows-media-player",
        "Windows Media Player",
        ["Windows Media Player/wmplayer.exe"],
        MEDIA,
        ["wmplayer.exe"],
      ),
      windows("vlc", "VLC", ["VideoLAN/VLC/vlc.exe"], MEDIA, ["vlc.exe"]),
      windows(
        "potplayer",
        "PotPlayer",
        ["DAUM/PotPlayer/PotPlayerMini64.exe", "DAUM/PotPlayer/PotPlayerMini.exe"],
        ["mp4"],
        ["PotPlayerMini64.exe", "PotPlayerMini.exe"],
      ),
    ];
  }
  // [失败路径] linux 上 WPS 会拆成 wps、wpp、et 三个入口，缺失任一不影响其余条目入列。
  if (platform === "linux")
    return [
      linux("evince", "Evince", "evince", ["pdf"]),
      linux("okular", "Okular", "okular", ["pdf"]),
      linux("firefox", "Firefox", "firefox", ["pdf"]),
      linux("wps", "WPS Office", "wps", ["docx"]),
      linux("wps-presentation", "WPS Presentation", "wpp", ["pptx"]),
      linux("wps-spreadsheets", "WPS Spreadsheets", "et", ["xlsx"]),
      linux("libreoffice-writer", "LibreOffice Writer", "libreoffice", ["docx"], ["--writer"]),
      linux("libreoffice-impress", "LibreOffice Impress", "libreoffice", ["pptx"], ["--impress"]),
      linux("libreoffice-calc", "LibreOffice Calc", "libreoffice", ["xlsx"], ["--calc"]),
      linux("vlc", "VLC", "vlc", MEDIA),
      linux("mpv", "mpv", "mpv", MEDIA),
    ];
  // [失败路径] 未知平台返回空数组而非抛错，上层据此提示暂无可用应用，不会崩在模块初始化。
  return [];
}

// 匹配只做扩展名是否属于 def.fileExtensions 的集合判断，不校验文件是否存在。
// [权衡] 不做存在性检查，让匹配可用于菜单预渲染，真正的可用性由 resolveFileApplicationPath 决定。
// filePath 可选，缺省视为不匹配，调用方无需先判空。
export function matchesFileApplication(def: FileApplicationDef, filePath?: string): boolean {
  // 先反斜杠归一化成斜杠，再取扩展名，最后去掉前导点并转小写，三步顺序不可换。
  // [权衡] 用字符串替换而不看 path.sep，保证同一份路径在任意宿主平台得到一致后缀。
  const extension = filePath ? extname(filePath.replace(/\\/g, "/")).slice(1).toLowerCase() : "";
  return def.fileExtensions.includes(extension);
}

// 三段式探测：直接候选、注册表 App Paths、WPS 版本目录，最后统一复扫一遍。
// [并发] 全程串行 await，不并行探测：候选规模小，所以串行更省进程与文件句柄。
export async function resolveFileApplicationPath(
  def: FileApplicationDef,
  platform: NodeJS.Platform = process.platform,
  searchPath = process.env.PATH || "",
): Promise<string | null> {
  // 候选集以 appPath 打头再拼 appPathCandidates，保持定义里的优先级顺序。
  // [失败路径] 用空数组兜底，缺省候选字段的定义（如 linux）不会抛错。
  const candidates = [def.appPath, ...(def.appPathCandidates ?? [])];
  // linux 额外把 PATH 按冒号切分，为每个目录拼上 executableNames，覆盖非 /usr/bin 安装。
  // [失败路径] filter(Boolean) 吃掉连续冒号产生的空段，否则会拼出根目录下的 vlc 这类路径。
  if (platform === "linux") {
    candidates.push(
      ...searchPath
        .split(":")
        .filter(Boolean)
        .flatMap((root) => (def.executableNames ?? []).map((name) => join(root, name))),
    );
  }
  // 内层闭包直接复用外层构建好的 candidates，不需要参数，命中即返回。
  // [资源] 逐个 access 而不做 stat 或 readdir，代价最低，且能带上 linux 的可执行位语义。
  async function findPath(): Promise<string | null> {
    for (const path of candidates) {
      try {
        // linux 用 X_OK 校验可执行位，其余平台用 F_OK 只要求存在。
        // [失败路径] access 抛错即视为该候选不可用，异常被内层 catch 静默吞掉。
        await access(path, platform === "linux" ? constants.X_OK : constants.F_OK);
        return path;
      } catch {
        /* 未安装的可选应用不进入列表。 */
      }
    }
    return null;
  }
  // [资源] 先跑直接候选，这是标准安装的最常见路径，命中即返回，省掉注册表与版本目录开销。
  // [失败路径] 全部直接候选都失败才返回 null，从而触发后面的 Windows 专用探测。
  const direct = await findPath();
  // [失败路径] 非 win32 平台到此收敛，返回 null 表示未安装，调用方应把该应用从菜单过滤掉。
  if (direct || platform !== "win32") return direct;
  // [失败路径] 只对声明了 executableNames 的应用做注册表探测，空数组时循环零次并直接落到版本目录阶段。
  for (const name of def.executableNames ?? []) {
    // 先查 HKCU 再查 HKLM：用户级安装优先于机器级，符合 Windows 自身的解析顺序。
    // [失败路径] 单个 hive 查询失败只影响本轮，catch 后继续下一个 hive。
    for (const hive of ["HKCU", "HKLM"]) {
      try {
        // 键路径是 App Paths 下的可执行文件名，/ve 表示读取默认值，不做写入或删除。
        const stdout = await queryAppPath(
          `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`,
        );
        // 从 reg 输出里抓 REG_SZ 或 REG_EXPAND_SZ 之后的值，trim 后剥掉包裹的双引号。
        // [失败路径] %VAR% 就地展开，未识别的变量原样保留，输出格式变化导致 match 落空时 path 为 undefined，后续判断直接跳过。
        const path = stdout
          .match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/)?.[1]
          ?.trim()
          .replace(/^"|"$/g, "")
          .replace(/%([^%]+)%/g, (_, key: string) => process.env[key] || `%${key}%`);
        // 注册表可能指向已卸载残留，必须 stat 且 isFile 双重确认才采信。
        // [权衡] 不校验可执行位：Windows 的可执行性由扩展名决定，X_OK 在此无意义。
        if (path && (await stat(path)).isFile()) return path;
      } catch {
        /* 非标准安装位置通过系统 App Paths 查找，缺失是正常情况。 */
      }
    }
  }
  // 最后阶段只服务 WPS：它的安装目录带版本号，无法用固定相对路径表达。
  // [资源] 每个根一次 readdir（含 dirent），根数量通常不超过三个。
  for (const root of def.windowsVersionRoots ?? []) {
    try {
      // [失败路径] 根目录不存在或权限不足都会抛错，catch 后视为该根下没有可用版本。
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries
        .filter((entry) => entry.isDirectory())
        // 按目录名数值降序，保证 11.1 排在 9.1 之前，从而选中最新版本。
        // [权衡] numeric 选项避免字典序把 10 排到 9 前面，localeCompare 保证跨语言稳定。
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
        for (const name of def.executableNames ?? [])
          // 必须拼出根、版本、office6、可执行名四段路径，这是 WPS 各版本统一的内部布局。
          // [失败路径] 版本目录里没有 office6 时该候选不存在，最终 findPath 自然跳过，不抛错。
          candidates.push(win32.join(root, entry.name, "office6", name));
      }
    } catch {
      /* WPS 版本目录可能不存在。 */
    }
  }
  // 复扫扩充后的候选：前两阶段可能已把 WPS 版本路径追加进 candidates。
  // [失败路径] 仍未命中返回 null，语义等同未安装，调用方不应把它当作异常。
  return findPath();
}
