// ============================================================================
// services/system/sshConfigAlias.ts —— SSH config 别名解析与 ssh -G 校正
// ============================================================================
// 【定位】读取 ~/.ssh/config（含 Include），枚举可直接连接的 Host 别名，
// 再按需用 ssh -G 校正 hostname/port/user；结果缓存 30 秒供连接面板复用。
//
// 【不变量】
// INV-01：别名只来自 `Host <单模式>` 且该模式可直接连接；通配与取反不算条目。
//   守住它的位置：buildAliasMetas 与 isConnectableAliasPattern。
//   破坏后果：面板列出必然连接失败的目标。
// INV-02：Include 展开必须防环且限深；同一物理文件只解析一次。
//   守住它的位置：parseConfigBlocks 的 visited 与 MAX_INCLUDE_DEPTH。
//   破坏后果：互相 Include 的配置递归爆栈。
// INV-03：Windows 路径里的反斜杠不能当转义符吞掉；仅转义分隔符/引号/注释符。
//   守住它的位置：splitSshTokens 的反斜杠分支与 hasGlobPattern。
//   破坏后果：私钥与 Include 路径失效。
// INV-04：privateKeyPath 只信本地解析，绝不取 ssh -G 的 identityfile。
//   守住它的位置：listSSHConfigAliasesFromLocalConfig 的返回构造。
//   破坏后果：密码登录被误判为密钥登录。
// INV-05：字段取「首个匹配块的首个有效值」，与 OpenSSH 先匹配先赢一致。
//   守住它的位置：buildFallbackOptions 的 if (!x) 守卫与 blockMatchesAlias。
//   破坏后果：配置优先级反转，连到错误的主机或端口。
// INV-06：缓存对外只暴露副本，且子进程与 Promise 只结算一次。
//   守住它的位置：cloneAliasOptions 与 runSshConfigQuery 的 finished 标记。
/* eslint-disable max-lines -- SSH config alias 解析链路包含扫描、回退和受控执行，暂集中在同一文件。 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { SSHConfigAliasOption } from "@zcode/shared";

// 缓存 30 秒是权衡：改完 ssh config 最坏要等半分钟才可见，
// 但每次打开连接面板都重扫并跑 ssh -G 会明显拖慢交互。
const CACHE_TTL_MS = 30_000;
// 上限防的是 ssh -G 爆炸：每个别名都要起一个子进程，
// 上千条 Include 展开会让枚举退化成分钟级。
const MAX_ALIAS_COUNT = 200;
// 单个 ssh -G 超时只影响该别名，最终回退到本地解析值：
// 不能无限等待，某些配置会因代理或安全密钥提示而挂住。
const SSH_G_TIMEOUT_MS = 1_500;
// 并发 3 是保守值：ssh -G 会读私钥与 known_hosts，过高并发在
// Windows 上容易撞到文件锁或杀软扫描。
const SSH_G_CONCURRENCY = 3;
// Include 可以互相引用，深度上限配合 visited 是唯一的防环手段：
// 超过 8 层的合法配置极少，而无限递归会直接爆栈。
const MAX_INCLUDE_DEPTH = 8;

interface ParsedDirective {
  key: string;
  value: string;
}

interface ParsedBlock {
  patterns: string[];
  directives: ParsedDirective[];
  source: string;
  fromHostDirective: boolean;
}

interface AliasMeta {
  alias: string;
  source: string;
}

// [并发] 模块级缓存是后写者覆盖，没有 CAS：两次并发枚举会各扫一次，
// 结果都来自同一份磁盘内容，因此可以接受；但不能做增量更新，
// 否则两个进程内调用会拼出一份混合快照。
let aliasCache: {
  expiresAt: number;
  options: SSHConfigAliasOption[];
} | null = null;

// 缓存对外必须返回副本：调用方会就地排序或改写选项，
// 直接给引用会让下一次命中缓存时读到被改过的数据。
function cloneAliasOptions(options: SSHConfigAliasOption[]): SSHConfigAliasOption[] {
  return options.map((option) => ({ ...option }));
}

// 只把能直接 ssh 别名 的模式当条目：通配符、取反、空模式都不是
// 可连接目标，列出来只会让用户点一个必然失败的项。
function isConnectableAliasPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }

// 全通配与取反单独拦掉：它们是最常见的两类 Host 写法，
// 而且在后续字符检查里不一定能被识别出来。
  if (trimmed === "*" || trimmed.startsWith("!")) {
    return false;
  }

  return !/[?*[\\\]]/.test(trimmed);
}

// 手写扫描而不是按 # 直接切分：注释符可能出现在引号或 Windows 路径里，
// 用正则切会把 # 之前的整段内容误删。
// 引号状态与转义状态互相独立，必须先处理转义。
function stripInlineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
// 转义状态优先于引号状态：引号内的转义引号是字面引号，
// 先判引号会让它被当成闭合，注释切分提前结束。
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
// 只在引号外的注释符处截断：路径或备注里出现的注释符不能当分隔，
// 否则会连同后面的有效内容一起丢掉。
      return line.slice(0, i);
    }
  }

  return line;
}

// SSH config 的分词规则与 shell 不同：没有变量展开，也只在引号内
// 与分隔符前处理反斜杠。必须自己实现，用 shell 分词库会改变语义。
// 空 token 不产出，因此连续空白不会污染参数列表。
function splitSshTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (quote) {
      if (char === "\\") {
        const nextChar = line.charAt(i + 1);
        if (!nextChar) {
          current += "\\";
          continue;
        }
        if (nextChar === quote || nextChar === "\\") {
          current += nextChar;
          i += 1;
          continue;
        }
        current += "\\";
        continue;
      }

      if (char === quote) {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

// 未加引号的空白才是 token 分隔符：路径里的空格必须靠引号或转义，
// 这里不猜测，按 OpenSSH 的实际行为保持一致。
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\") {
      const nextChar = line.charAt(i + 1);
      if (!nextChar) {
        current += "\\";
        continue;
      }
      if (
        /\s/.test(nextChar) ||
        nextChar === "\\" ||
        nextChar === "'" ||
        nextChar === '"' ||
        nextChar === "#"
      ) {
        current += nextChar;
        i += 1;
        continue;
      }
      // SSH config 在 Windows 下常见 `C:\Users\...` 这类路径。
      // 不能把任意 `\` 都当成转义前缀：反斜杠会被吞掉，私钥/Include 路径失效。
      // 这里仅在“确实用于转义分隔符/引号”时解义，其余场景保留字面反斜杠。
      current += "\\";
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

// 只认三个 glob 元字符；把 Windows 路径分隔符也算 glob 会让所有
// 绝对路径走进 glob 分支，而 glob 与 existsSync 的处理并不一致。
function hasGlobPattern(value: string): boolean {
  // Windows 绝对路径天然包含 `\`，但这不代表 Include 是 glob。
  // 这里只识别 SSH Include 真正的 glob 元字符：`* ? [ ]`。
  return /[*?[\]]/.test(value);
}

// 支持 ~、~/、Windows 风格的家目录前缀与 %d：%d 是 OpenSSH 在 Windows 上
// 表示用户目录的写法，不展开会指向一个字面量目录。
function expandHomeToken(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return trimmed;
  }

  const home = homedir();
  const withHomeVariable = trimmed.replace(/^%d(?=$|[\\/])/, home);
  if (withHomeVariable === "~") {
    return home;
  }
  if (withHomeVariable.startsWith("~/") || withHomeVariable.startsWith("~\\")) {
    return join(home, withHomeVariable.slice(2));
  }
  return withHomeVariable;
}

// Include 的相对路径以包含它的文件所在目录为基准，不是进程 cwd：
// 基准错了会静默漏掉全部 include，别名列表看起来只是变少。
async function resolveIncludeTargets(includeTokens: string[], baseDir: string): Promise<string[]> {
  const results: string[] = [];
// visited 的粒度是一条 Include 指令的全部 token：同一文件被重复列出时
// 只展开一次，避免别名重复与重复读盘。
  const visited = new Set<string>();

  for (const token of includeTokens) {
    const expanded = expandHomeToken(token);
    if (!expanded) {
      continue;
    }

// glob 与非 glob 走不同查询路径：existsSync 精确判断，glob 逐条展开；
// 用 glob 处理无通配的路径在部分平台会返回空集。
    const absolutePattern = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);

// 精确路径先 existsSync 再入队：无通配时不必走 glob，
// 少一次目录扫描也避免 glob 对字面路径的处理差异。
    if (!hasGlobPattern(absolutePattern)) {
      if (existsSync(absolutePattern) && !visited.has(absolutePattern)) {
        visited.add(absolutePattern);
        results.push(absolutePattern);
      }
      continue;
    }

    try {
// 用异步迭代而不是同步 glob：Include 可能匹配到网络盘，
// 同步 IO 会阻塞整个事件循环，拖慢所有 RPC。
      for await (const match of glob(absolutePattern)) {
        const resolvedMatch = resolve(match);
        if (visited.has(resolvedMatch)) {
          continue;
        }
        visited.add(resolvedMatch);
        results.push(resolvedMatch);
      }
    } catch {
      // include 展开失败时按空集合处理，避免单个坏配置阻塞整体加载。
    }
  }

  return results;
}

// [并发] visited 跨整次扫描共享，同时挡住重复 Include 与环：
// 同一文件被两条 include 链引用时只解析一次，避免别名重复与指数级展开。
// 顶层调用每次新建集合，因此缓存过期后能真正重新读盘。
async function parseConfigBlocks(
  configPath: string,
  visited: Set<string>,
  depth: number,
): Promise<ParsedBlock[]> {
// 先 resolve 再入 visited：同一文件可能以相对路径、绝对路径或含 .. 的
// 写法出现，不归一化就挡不住环。
  const normalizedPath = resolve(configPath);
  if (visited.has(normalizedPath) || depth > MAX_INCLUDE_DEPTH) {
    return [];
  }
  visited.add(normalizedPath);

// 读失败按空内容处理：Include 目标可能已被删除，
// 让其余部分继续解析比整体失败更有用。
  let content = "";
  try {
    content = await readFile(normalizedPath, "utf8");
  } catch {
    return [];
  }

  const blocks: ParsedBlock[] = [];
  let currentBlock: ParsedBlock = {
    patterns: ["*"],
    directives: [],
    source: normalizedPath,
    fromHostDirective: false,
  };
  blocks.push(currentBlock);

// 兼容 CRLF：配置常从 Windows 复制过来，只按换行切会残留回车，
// 让 Host 模式与输出里带上不可见字符。
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const stripped = stripInlineComment(line).trim();
    if (!stripped) {
      continue;
    }

    const tokens = splitSshTokens(stripped);
    if (tokens.length === 0) {
      continue;
    }

    const rawKey = tokens[0];
    if (!rawKey) {
      continue;
    }
    const key = rawKey.toLowerCase();
// Include 出现在 Host 块内时 OpenSSH 只在匹配该 Host 时才读，
// 这里无条件展开：宁可多列几条别名，也不漏掉真实可用的条目。
    if (key === "include") {
      const includeTokens = tokens.slice(1);
// 基准目录取当前文件所在目录，不是顶层配置目录：
// Include 可能出现在被 Include 进来的子文件里。
      const includePaths = await resolveIncludeTargets(includeTokens, dirname(normalizedPath));
      for (const includePath of includePaths) {
        const includeBlocks = await parseConfigBlocks(includePath, visited, depth + 1);
        blocks.push(...includeBlocks);
      }
      continue;
    }

    if (key === "host") {
// Host 之前的指令归入隐式全通配块：这些是全局默认值，
// fallback 计算时应当作用于所有别名。
      currentBlock = {
        patterns: tokens.slice(1),
        directives: [],
        source: normalizedPath,
        fromHostDirective: true,
      };
      blocks.push(currentBlock);
      continue;
    }

// 单 token 行（例如裸 Host）没有值可记，直接跳过：
// 记成空字符串会让 fallback 把 host 覆盖成空。
    if (tokens.length < 2) {
      continue;
    }

    currentBlock.directives.push({
      key,
      value: tokens.slice(1).join(" "),
    });
  }

  return blocks;
}

// 只收录单模式 Host 块：多目标块无法确定用户到底想连哪一个，
// 把它们都当别名会引入用户从未单独配置过的条目。
function buildAliasMetas(blocks: ParsedBlock[]): AliasMeta[] {
  const aliases: AliasMeta[] = [];
  const seenAliases = new Set<string>();

  for (const block of blocks) {
// 隐式全通配块与多模式块都不产生别名：前者是全局默认值，
// 后者无法确定用户到底想连哪一个目标。
    if (!block.fromHostDirective || block.patterns.length !== 1) {
      continue;
    }

    const alias = block.patterns[0]?.trim();
// 去重按首次出现保留：同名 Host 段在 SSH 里先匹配先赢，
// source 指向第一次声明它的文件，与生效来源一致。
    if (!alias || !isConnectableAliasPattern(alias) || seenAliases.has(alias)) {
      continue;
    }

    seenAliases.add(alias);
    aliases.push({
      alias,
      source: block.source,
    });

    if (aliases.length >= MAX_ALIAS_COUNT) {
      break;
    }
  }

  return aliases;
}

// 模式匹配要实现 SSH 的 glob 语义，不能直接 new RegExp(pattern)：
// 模式里的点和加号是字面量，不转义会扩大匹配范围。
function matchHostPattern(pattern: string, alias: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (!/[*?]/.test(pattern)) {
    return pattern === alias;
  }

// 逐字符构造正则体而不是先转义再替换通配符：
// 顺序错了会把刚生成的 .* 又转义掉，退化成字面量匹配。
  const regexBody = Array.from(pattern, (char) => {
    if (char === "*") {
      return ".*";
    }
    if (char === "?") {
      return ".";
    }
    // Teleport 会生成 `Host *.teleport-*.example.com` 这类 SSH glob。
    // 特殊字符（含 `*`）必须先转义，否则会拼出 `^*...` 非法正则并让 alias 枚举整体失败。
    return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }).join("");
  const regex = new RegExp(`^${regexBody}$`);
  return regex.test(alias);
}

// 取反模式优先且立即返回 false：全通配加取反必须排除后者，
// 若先看正向命中再处理取反，被排除的别名会被全通配提前判为匹配。
function blockMatchesAlias(patterns: string[], alias: string): boolean {
  let matchedPositive = false;

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) {
      continue;
    }

    if (pattern.startsWith("!")) {
      const negatePattern = pattern.slice(1);
      if (negatePattern && matchHostPattern(negatePattern, alias)) {
        return false;
      }
      continue;
    }

    if (matchHostPattern(pattern, alias)) {
      matchedPositive = true;
    }
  }

  return matchedPositive;
}

// 端口越界返回 undefined 而不是 0：undefined 表示未配置，
// 上层据此回退到 ssh -G 或默认端口，而不是显示一个非法值。
function toValidPort(rawPort: string): number | undefined {
  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
    return undefined;
  }
  return parsedPort;
}

function normalizeIdentityPath(rawValue: string): string | undefined {
  const expanded = expandHomeToken(rawValue).trim();
  return expanded.length > 0 ? expanded : undefined;
}

// fallback 在 ssh -G 不可用时提供最小可用信息，按首个匹配生效取值
// （见各 case 的 if (!x) 守卫），因此 blocks 的顺序不能重排。
// host 最终回退到别名本身，保证条目至少可点击。
// 与 ssh -G 的关系是保底：后者给出的才是合并默认值后的最终结果。
function buildFallbackOptions(
  blocks: ParsedBlock[],
  aliasMetas: AliasMeta[],
): SSHConfigAliasOption[] {
  return aliasMetas.map((meta) => {
    let host: string | undefined;
    let port: number | undefined;
    let username: string | undefined;
    let privateKeyPath: string | undefined;

    for (const block of blocks) {
      if (!blockMatchesAlias(block.patterns, meta.alias)) {
        continue;
      }

      for (const directive of block.directives) {
// 只认这四个字段：ProxyJump、LocalForward 等不是连接卡片要展示的信息，
// 收进来只会增加协议面与跨端同步成本。
        switch (directive.key) {
          case "hostname":
            if (!host) {
              const normalizedHost = directive.value.trim();
              host = normalizedHost.length > 0 ? normalizedHost : undefined;
            }
            break;
          case "port":
            if (port == null) {
// 端口取首个有效值，非法值不算已配置：
// 否则一条写错的 Port 会把后面合法的 Port 挡住。
              port = toValidPort(directive.value.trim());
            }
            break;
          case "user":
            if (!username) {
              const normalizedUser = directive.value.trim();
              username = normalizedUser.length > 0 ? normalizedUser : undefined;
            }
            break;
// IdentityFile 只做家目录展开，不做相对路径 resolve：
// 这里没有 include 文件的目录上下文，猜基准会把路径改错。
          case "identityfile":
            if (!privateKeyPath) {
              privateKeyPath = normalizeIdentityPath(directive.value);
            }
            break;
          default:
            break;
        }
      }
    }

    return {
      alias: meta.alias,
      host: host ?? meta.alias,
      port,
      username,
      privateKeyPath,
      source: meta.source,
    };
  });
}

// 自己扫 PATH 而不是 spawn 后靠 ENOENT：需要提前知道 ssh 是否可用，
// 以便决定要不要为每个别名起子进程。
function findExecutableFromPath(binaryName: string): string | null {
  const rawPath = process.env["PATH"];
  if (!rawPath) {
    return null;
  }

  for (const entry of rawPath.split(delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
// Windows 的 PATH 条目可能带引号或尾随空格，只 trim 不剥引号：
// 带引号的条目会被判为不存在，属于可接受的降级。
    const fullPath = join(trimmed, binaryName);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

// Windows 的 PATH 常常没有 OpenSSH，但系统自带目录与 Git 附带的
// ssh 都能用；显式列候选比依赖 PATH 可靠得多。
// 找不到返回 null，调用方整体退化为纯解析模式，功能仍可用。
// 非 Windows 平台不做额外兜底：ssh 不在 PATH 就说明环境不完整。
function resolveSshExecutablePath(): string | null {
  if (process.platform !== "win32") {
    return findExecutableFromPath("ssh");
  }

  const fromPath = findExecutableFromPath("ssh.exe");
  if (fromPath) {
    return fromPath;
  }

// 环境变量缺失时用系统默认值兜底：服务可能由精简过环境变量的
// 宿主进程拉起，读不到 WINDIR 不代表目录不存在。
  const windowsDir = process.env["WINDIR"]?.trim() || "C:\\Windows";
  const programFiles = process.env["ProgramFiles"]?.trim() || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim() || "C:\\Program Files (x86)";

// 候选顺序即优先级：系统自带 OpenSSH 优先于 Program Files，
// Git 附带的最老，放最后避免优先选到旧实现。
  const candidates = [
    join(windowsDir, "System32", "OpenSSH", "ssh.exe"),
    join(programFiles, "OpenSSH", "ssh.exe"),
    join(programFiles, "Git", "usr", "bin", "ssh.exe"),
    join(programFilesX86, "Git", "usr", "bin", "ssh.exe"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// [资源] 每个别名起一个 ssh -G 子进程：stdin 关闭、stdout 管道、stderr 丢弃，
// 防止子进程等待输入或把错误刷屏。
// 所有退出路径（超时、error、close）都先置 finished 再结算，
// 保证 Promise 只结算一次。
async function runSshConfigQuery(params: {
  sshExecutablePath: string;
  configPath: string;
  alias: string;
}): Promise<string | null> {
// 先解构再使用：闭包里的超时回调可能在调用方后续改动 params 之后执行，
// 提前取出可以保证整次查询用的是同一组参数。
  const { sshExecutablePath, configPath, alias } = params;
  return await new Promise((resolvePromise) => {
    let finished = false;
    let stdout = "";

// BatchMode 加清空 SSH_ASKPASS 与 DISPLAY 是三重保险：只要漏一处，
// 某条配置就可能弹出密码或口令输入，把服务卡死。
// -F 显式指定配置文件，避免读到与被解析文件不同的默认位置。
    const child = spawn(sshExecutablePath, ["-G", "-F", configPath, "-o", "BatchMode=yes", alias], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: {
        ...process.env,
        SSH_ASKPASS_REQUIRE: "never",
        SSH_ASKPASS: "",
        DISPLAY: "",
      },
    });

// [失败路径] 超时直接 kill 并返回 null：不区分配置错误与主机慢，
// 两者处理方式相同——回退到本地解析结果。
    const timeoutId = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill();
      resolvePromise(null);
    }, SSH_G_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (finished) {
        return;
      }
// 截断到 128KB：输出规模与配置相关，异常配置可能吐出大量行，
// 保留前段足够解析所需字段，也避免内存被单次查询拉高。
      stdout += chunk.toString();
      if (stdout.length > 128_000) {
        stdout = stdout.slice(0, 128_000);
      }
    });

// error 与 close 都可能结算，用 finished 去重：spawn 失败时两者会先后触发。
    child.on("error", () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutId);
      resolvePromise(null);
    });

    child.on("close", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutId);
      resolvePromise(code === 0 ? stdout : null);
    });
  });
}

// [权衡] 只取 hostname、port、user 三个字段：ssh -G 还会输出 identityfile 等，
// 但那些可能是 OpenSSH 的默认值而非用户显式配置，
// 误用会把密码登录显示成密钥登录。
function parseSshGOutput(output: string): Omit<SSHConfigAliasOption, "alias"> {
  let host: string | undefined;
  let port: number | undefined;
  let username: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

// 输出是 键 值 形式且值里允许空格：用非空白串取键、其余整体当值，
// 按空格 split 会把带空格的值截断。
    const match = /^(\S+)\s+(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const rawKey = match[1];
    const rawValue = match[2];
    if (!rawKey || rawValue == null) {
      continue;
    }
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    switch (key) {
      case "hostname":
        if (!host && value.length > 0) {
          host = value;
        }
        break;
      case "port":
        if (port == null) {
          port = toValidPort(value);
        }
        break;
      case "user":
        if (!username && value.length > 0) {
          username = value;
        }
        break;
      default:
        break;
    }
  }

  return {
    host,
    port,
    username,
  };
}

// [并发] 手写工作池而不是分片 Promise.all：分片会在慢请求上留下空转，
// 结果顺序也要额外还原。这里用共享 cursor 抢占索引，
// 结果写回原始下标，因此返回顺序始终与输入一致。
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

// 并发数同时受上限与元素数约束，且至少为 1：
// 传 0 会让一个 worker 都不启动，结果数组全是空洞。
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as R[];
// 预先构造带原始下标的条目：worker 抢占的是游标，
// 写回必须用原始下标，否则结果会被并发顺序打乱。
  const entries = items.map((item, index) => ({ item, index }));
  let cursor = 0;

// 多个 worker 共享 cursor，靠 JS 单线程特性天然互斥：
// 不会有两个 worker 取到同一个索引。
  async function worker(): Promise<void> {
// 队列空时 worker 各读一次游标后退出：并发数大于元素数时多余 worker
// 立即结束，不会空转。
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) {
        return;
      }
      const entry = entries[index];
      if (!entry) {
        continue;
      }
// 单个 mapper 抛错会让整批失败：调用方需要感知枚举不完整，
// 静默跳过会让面板少几个别名却查不出原因。
      results[entry.index] = await mapper(entry.item, entry.index);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      await worker();
    }),
  );

  return results;
}

// 唯一对外入口：先看缓存，再解析配置，最后用 ssh -G 校正。
// 三级来源的关系是解析保底、ssh -G 校真：后者已是 OpenSSH 合并
// Include 与默认值后的最终结果，因此优先采用其字段。
// 返回前写缓存并给副本，调用方拿不到内部数组。
export async function listSSHConfigAliasesFromLocalConfig(): Promise<SSHConfigAliasOption[]> {
  const now = Date.now();
  if (aliasCache && aliasCache.expiresAt > now) {
    return cloneAliasOptions(aliasCache.options);
  }

// 只读标准位置：不读 config.d 之类约定，也不读 SSH_CONFIG 环境变量，
// 避免与用户 shell 环境产生隐式耦合。
  const rootConfigPath = join(homedir(), ".ssh", "config");
// 不存在也写缓存：否则每次打开面板都会 stat 一次，
// 而没有配置文件是绝大多数机器的稳定状态。
  if (!existsSync(rootConfigPath)) {
    aliasCache = {
      expiresAt: now + CACHE_TTL_MS,
      options: [],
    };
    return [];
  }

// visited 每次顶层扫描新建：缓存过期后必须重新读盘，
// 复用集合会让第二次扫描把全部 include 当成已访问而返回空。
  const blocks = await parseConfigBlocks(rootConfigPath, new Set<string>(), 0);
  const aliasMetas = buildAliasMetas(blocks);
  if (aliasMetas.length === 0) {
    aliasCache = {
      expiresAt: now + CACHE_TTL_MS,
      options: [],
    };
    return [];
  }

// 无论能否用 ssh -G 都先算 fallback：它是每个别名的兜底值，
// 也让 ssh -G 失败时仍有 host/port/user 可用。
  const fallbackOptions = buildFallbackOptions(blocks, aliasMetas);
  const fallbackByAlias = new Map(fallbackOptions.map((option) => [option.alias, option] as const));

// 每轮枚举只解析一次可执行文件路径：PATH 扫描是同步 IO，
// 放进 map 回调会随别名数量线性放大。
  const sshExecutablePath = resolveSshExecutablePath();
  const options =
    sshExecutablePath == null
      ? fallbackOptions
      : await mapWithConcurrency(aliasMetas, SSH_G_CONCURRENCY, async (meta) => {
// 理论上 fallback 一定存在（两份数据同源），这里仍给最小对象：
// 宁可少几个字段，也不要让整次枚举因单个别名缺失而失败。
// source 必须保留，它是 UI 展示来源文件的唯一字段。
          const fallbackOption = fallbackByAlias.get(meta.alias) ?? {
            alias: meta.alias,
            host: meta.alias,
            source: meta.source,
          };
          const sshOutput = await runSshConfigQuery({
            sshExecutablePath,
            configPath: rootConfigPath,
            alias: meta.alias,
          });
          if (!sshOutput) {
            return fallbackOption;
          }

// 字段级回退：ssh -G 没给出的字段用 fallback 补，
// 因此一条配置可以同时混用两种来源，而不是整条二选一。
          const parsed = parseSshGOutput(sshOutput);
          return {
            alias: meta.alias,
            host: parsed.host ?? fallbackOption.host ?? meta.alias,
            port: parsed.port ?? fallbackOption.port,
            username: parsed.username ?? fallbackOption.username,
            // `ssh -G` 会返回默认 identityfile（例如 ~/.ssh/id_rsa），
            // 即使 alias 并未显式配置 IdentityFile。之前直接采用该值，会把“密码登录”误判成“密钥登录”。
            // 因此 privateKeyPath 只信任 ssh config 显式解析结果，不再使用 `ssh -G` 的 identityfile。
            privateKeyPath: fallbackOption.privateKeyPath,
            source: meta.source,
          } satisfies SSHConfigAliasOption;
        });

  aliasCache = {
    expiresAt: now + CACHE_TTL_MS,
    options,
  };
// 缓存存内部数组，返回副本：两者不能是同一引用，
// 否则调用方改动会污染后续命中的缓存。
  return cloneAliasOptions(options);
}
