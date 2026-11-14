// 反馈诊断日志归档：从白名单来源收集有界文本日志与 CLI 配置安全投影，打成单个 zip 供上传。
// INV-01：进入 zip 的文件必须来自 sources 声明的目录，经两轮 realpath 校验且 nlink 等于 1；
//         守住位置 walk 内的链接过滤与 open 后 inode 复核。破坏后果：读入来源目录之外的文件。
// INV-02：单文件不超过 8 MiB、整包不超过 32 MiB，脱敏后还要再判一次；
//         守住位置 budget 与两处 size 比较。破坏后果：超大包上传失败，或主进程持有过量内存。
// INV-03：解码失败、含控制字符或无法安全投影时一律跳过并计数，绝不用原文兜底；
//         守住位置 decodeDiagnosticLog/sanitizeCliConfig。破坏后果：凭据与二进制内容外泄。
// INV-04：任何失败都要删除本次临时目录，并保证 about.txt 记录跳过原因分布；
//         守住位置 catch 分支与 skippedLogFilesByReason。
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { redactFeedbackText, ZCODE_VERSION, ZCODE_COMMIT } from "@zcode/shared";

// 上限是「拒绝」而不是「截断」：截断会把一条完整错误切成两半，反而误导排查。
// 8 MiB 覆盖正常滚动日志，32 MiB 是上传通道的保守预算；
// 两个值都在归档入口被 Math.min 夹紧，调用方传更大值不会生效。
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

// 采集策略全部显式声明，不按目录猜意图：同一诊断根目录下可能同时存在按日滚动的日志、
// 只允许取退出码的 .exit.log、以及单文件白名单三种来源。
// 全部可选字段不填 = 递归 + 当天 + 按扩展名过滤，是最保守也最常用的组合。
export interface FeedbackLogSource {
  directory: string;
  archivePrefix: string;
  exitLogsOnly?: boolean;
  /** 只收集根目录下列出的文件名；用于允许单文件进入归档的配置入口。 */
  includeFileNames?: readonly string[];
  /** 默认只收集本地当天修改的文件；配置文件可关闭该限制。 */
  onlyCurrentDay?: boolean;
  /** 配置文件使用结构化安全投影，避免把插件自定义敏感项上传。 */
  contentPolicy?: "diagnostic" | "cli-config";
}

// 解码是归档的可信边界：fatal 模式让非法字节序列直接抛错，避免默认替换字符
// 把二进制内容洗成看似合法的文本再上传。BOM 决定 UTF-16 分支，无 BOM 按 UTF-8。
// [失败路径] 除制表/换行/回车外的控制字符一律判为二进制，返回 null 由调用方跳过并计数。
function decodeDiagnosticLog(buffer: Buffer): string | null {
  try {
    const encoding =
      buffer[0] === 0xff && buffer[1] === 0xfe
        ? "utf-16le"
        : buffer[0] === 0xfe && buffer[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
    }
    return text;
  } catch {
    return null;
  }
}

type SafeScalarType = "boolean" | "number" | "string";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 白名单投影：只复制「显式声明的字段名 + 声明类型」，未声明的键（插件 options、MCP、
// 网络、hooks）无论敏感与否都不进结果；数组里混入对象则整字段丢弃，不做部分透出。
// 空投影返回 undefined，让上层区分「该段存在但全是不安全字段」与「没有该段」。
function pickSafeSection(
  value: unknown,
  scalarFields: Readonly<Record<string, SafeScalarType>> = {},
  stringArrayFields: readonly string[] = [],
  booleanMapFields: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(scalarFields)) {
    if (typeof value[key] === type) result[key] = value[key];
  }
  for (const key of stringArrayFields) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) {
      result[key] = candidate;
    }
  }
  for (const key of booleanMapFields) {
    const candidate = value[key];
    if (
      isRecord(candidate) &&
      Object.values(candidate).every((item) => typeof item === "boolean")
    ) {
      result[key] = candidate;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 只投影 CLI 的非敏感配置；插件 options、MCP、网络和 hooks 等未知字段全部舍弃。 */
// CLI 配置整份上传风险最高：先 parse 再按 sections 表逐段投影，只留诊断必需项，其余结构性丢弃。
// [失败路径] 解析失败或顶层不是对象时返回 null，由归档入口记为 invalid-config 跳过，
// 绝不退化成上传原文。末尾统一走 redactFeedbackText，兜住已声明字段里的密钥形态字符串。
function sanitizeCliConfig(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const projection: Record<string, unknown> = {};
  const root = pickSafeSection(parsed, { model: "string" });
  if (root) Object.assign(projection, root);
  const sections: ReadonlyArray<{
    key: string;
    scalarFields: Readonly<Record<string, SafeScalarType>>;
    stringArrayFields?: readonly string[];
    booleanMapFields?: readonly string[];
  }> = [
    { key: "modelStream", scalarFields: { idleTimeoutMs: "number" } },
    {
      key: "permission",
      scalarFields: {
        mode: "string",
        autoApproveHighRisk: "boolean",
        allowMediumRiskInAuto: "boolean",
      },
      stringArrayFields: ["allowedTools", "disallowedTools"],
    },
    {
      key: "features",
      scalarFields: {
        compact: "boolean",
        rewind: "boolean",
        subagent: "boolean",
        memory: "boolean",
        skill: "boolean",
        mcp: "boolean",
      },
    },
    { key: "memory", scalarFields: { use: "boolean" } },
    {
      key: "plugins",
      scalarFields: { enabled: "boolean" },
      stringArrayFields: ["suppressedBuiltins"],
      booleanMapFields: ["enabledPlugins"],
    },
    {
      key: "skills",
      scalarFields: {
        enabled: "boolean",
        includeInstructions: "boolean",
        metadataBudget: "number",
      },
    },
    { key: "logging", scalarFields: { level: "string", format: "string" } },
    { key: "ui", scalarFields: { locale: "string", theme: "string" } },
    { key: "toolConcurrency", scalarFields: { maxConcurrency: "number" } },
    {
      key: "modelAnomalyGuard",
      scalarFields: {
        toolCallWarningThreshold: "number",
        repeatedToolCallWarningThreshold: "number",
        maxBudgetWarningsPerTurn: "number",
      },
    },
  ];
  for (const sectionDefinition of sections) {
    const section = pickSafeSection(
      parsed[sectionDefinition.key],
      sectionDefinition.scalarFields,
      sectionDefinition.stringArrayFields,
      sectionDefinition.booleanMapFields,
    );
    if (section) projection[sectionDefinition.key] = section;
  }
  return redactFeedbackText(JSON.stringify(projection, null, 2), { diagnostic: true });
}

// 生命周期顺序不可交换：建目录 → 遍历收集到内存 entries → 写 zip → stat 取大小 → 进度回调；
// 任一步失败都进 catch 删整个临时目录，调用方只会拿到异常，不会拿到半成品路径。
/** 反馈上传唯一归档入口：白名单来源、有界读取、无法安全解码时禁止原文兜底。 */
export async function createFeedbackDiagnosticArchive(options: {
  sources: readonly FeedbackLogSource[];
  outputRootDir: string;
  now?: () => Date;
  maxTotalBytes?: number;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}): Promise<{ path: string; size: number }> {
// 时间基准只取一次：遍历中反复取 now，跨零点时同一次归档会对不同文件用不同「今天」。
// 注入 now 也让跨日与夏令时场景可稳定测试。
  const now = options.now?.() ?? new Date();
  // 按本地自然日筛选文件；次日零点由日历计算，兼容夏令时的 23/25 小时日。
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
// [权衡] 用本地零点区间而非「now 减 24 小时」：日志按本地自然日滚动，回看 24 小时会在上午丢昨天的尾巴；
// 半开区间避免零点整的文件被相邻两日重复计入。
  const isToday = (mtimeMs: number) => mtimeMs >= dayStart && mtimeMs < dayEnd;
  await mkdir(options.outputRootDir, { recursive: true });
// mkdtemp 让并发归档互不覆盖，同时给出「失败即可整目录删除」的清理单元；
// 目录名不携带用户或时间信息，路径本身不泄露元数据。
  const outputDir = await mkdtemp(join(options.outputRootDir, "archive-"));
  const path = join(outputDir, "zcode-diagnostic-logs.zip");
  const entries: Array<{ name: string; data: Buffer }> = [];
// 跳过原因按字符串计数：about.txt 要给出分布，否则用户只看到「少了几个文件」，
// 无法判断是策略过滤（正常）还是读取失败（需排查）。
  const skippedLogFilesByReason: Record<string, number> = {};
  const skipLogFile = (reason: string) => {
    skippedLogFilesByReason[reason] = (skippedLogFilesByReason[reason] ?? 0) + 1;
  };
  let totalBytes = 0;
  let visited = 0;
// 双重夹紧：调用方可调小预算（测试/受限环境），但无法调大超过硬上限；
// 即使配置被误写成极大值，也不会让单次归档吃满内存。
  const budget = Math.min(options.maxTotalBytes ?? MAX_TOTAL_BYTES, MAX_TOTAL_BYTES);
  try {
    options.onProgress?.({ processedBytes: 0, totalBytes: 0 });
    for (const source of options.sources) {
      // 不跟随诊断根目录本身的链接；规范化系统目录别名（如 macOS /var）。
      const root = await realpath(source.directory).catch(() => null);
// realpath 之后再看源目录本身：目录若是指向别处的链接就整体跳过该来源，不跟随进入。
// catch 成 null 把「不存在/无权限」统一成跳过——单个来源不可用不该让整次归档失败。
      if (!root || !(await lstat(source.directory).catch(() => null))?.isDirectory()) continue;
      const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
// 深度与访问量双上限兜住异常目录（深层嵌套、软链环、超大插件目录）：
// visited 是整次归档共享计数，多来源叠加后仍在可预期时间内收敛。
// 超限时静默停止 `walk` 分支而不报错：归档要的是有代表性的样本，不是完整性。
        if (depth > 4 || visited >= 2000) return;
        const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
// 排序只为输出稳定：同一目录在同一预算下先收同一批文件，
// 避免 readdir 顺序差异让两次归档内容不同、无法对比排查。
        for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
          if (++visited > 2000) return;
// 遍历期出现的链接一律不进（目录链接成环、文件链接指向来源之外），
// 这是 realpath 校验之外的第一道廉价过滤。
          if (entry.isSymbolicLink()) continue;
          const absolutePath = join(directory, entry.name);
          const name = posix.join(prefix, entry.name);
// 三种来源形态在此分流：includeFileNames 白名单 > exitLogsOnly（只认 .exit.log）>
// 默认扩展名规则（.log / .log.N / .jsonl / .ndjson）。
// [权衡] 白名单用 !== undefined 而不是长度判断：空数组是有效声明（不收集任何文件）。
          const isExplicitFileSource = source.includeFileNames !== undefined;
          if (entry.isDirectory() && !source.exitLogsOnly && !isExplicitFileSource) {
            await walk(absolutePath, name, depth + 1);
            continue;
          }
          if (
            !entry.isFile() ||
            (isExplicitFileSource
              ? !source.includeFileNames!.includes(entry.name)
              : !(source.exitLogsOnly
                  ? entry.name.endsWith(".exit.log")
                  : /(?:\.log(?:\.\d+)?|\.jsonl|\.ndjson)$/i.test(entry.name)))
          )
            continue;
// 第二轮校验：文件自身解析后的真实路径必须与拼接路径完全相等，不等即以 unsafe-path 跳过。
// 用字符串相等而非前缀比较，避免 /a/b 与 /a/bc 这类前缀混淆；
// 这一步同时覆盖「路径中间某段是链接」的情况。
          if ((await realpath(absolutePath).catch(() => null)) !== absolutePath) {
            skipLogFile("unsafe-path");
            continue;
          }
// 元数据策略一次判完：非普通文件、硬链接数不为 1、超单文件上限、超总预算、非当天。
// nlink 不为 1 防的是同一 inode 被多处引用时的越权读取；当天限制默认开，只有配置入口能关。
// 这里用未打开的 lstat 做廉价筛选，打开后还要按 inode 复核一次。
          const info = await lstat(absolutePath).catch(() => null);
          if (
            !info?.isFile() ||
            info.nlink !== 1 ||
            info.size > MAX_FILE_BYTES ||
            totalBytes + info.size > budget ||
            (source.onlyCurrentDay !== false && !isToday(info.mtimeMs))
          ) {
            skipLogFile("metadata-policy");
            continue;
          }
          // O_NOFOLLOW 防止检查后把文件替换为链接；按打开后的 inode 再校验。
// [资源] O_NOFOLLOW 让 open 在目标被换成链接时直接失败，堵住 lstat 与 open 之间的替换窗口；
// 平台不支持该标志时退化为 0，由随后基于 inode 的复核承担同样的防护。
// 打开失败记 open-failed 并继续，不中断整次归档。
          const handle = await open(
            absolutePath,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          ).catch(() => null);
          if (!handle) {
            skipLogFile("open-failed");
            continue;
          }
          try {
// [资源] 按已打开的 fd 重新取 stat：判定对象必须是这个 inode，而不是之前 lstat 看到的路径。
// ino/dev 相等说明检查与读取之间未被替换；同时复核 nlink/大小/当天，因为窗口内可能被追加。
// 不满足即 opened-file-policy 跳过，句柄由 finally 关闭。
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              opened.nlink !== 1 ||
              opened.ino !== info.ino ||
              opened.dev !== info.dev ||
              (source.onlyCurrentDay !== false && !isToday(opened.mtimeMs)) ||
              opened.size > MAX_FILE_BYTES ||
              totalBytes + opened.size > budget
            ) {
              skipLogFile("opened-file-policy");
              continue;
            }
            // 日志追加是正常场景：只读打开时确认的长度，后续追加留待下次归档。
            // 不能用 size+1 探测增长并丢弃整份 active 日志；短读则仍保守跳过。
// 预分配按打开时确认的长度；读不满即 short-read 跳过——截断说明文件正在被改写，
// 半份日志会破坏上下文，宁可这次不传。
            const bytes = Buffer.alloc(opened.size);
            let length = 0;
            while (length < bytes.length) {
// 循环读到读满或 EOF：单次 read 可能短返回（大文件、网络盘），
// 因此偏移用累计长度，不能假设一次读完。
              const read = await handle.read(bytes, length, bytes.length - length, length);
              if (!read.bytesRead) break;
              length += read.bytesRead;
            }
            if (length !== opened.size) {
              skipLogFile("short-read");
              continue;
            }
// 只解码实际读到的 length，而非整个缓冲区——尾部未写入的 0 会被控制字符判据误杀。
// 解码失败即 unsupported-text，跳过并计数。
            const text = decodeDiagnosticLog(bytes.subarray(0, length));
            if (text === null) {
              skipLogFile("unsupported-text");
              continue;
            }
            const sanitizedText =
              source.contentPolicy === "cli-config"
                ? sanitizeCliConfig(text)
                : redactFeedbackText(text, { diagnostic: true });
// 两种策略共用入口：cli-config 走结构化白名单投影，diagnostic 走通用脱敏。
// [失败路径] 投影失败返回 null 时跳过，不退回原文。
            if (sanitizedText === null) {
              skipLogFile("invalid-config");
              continue;
            }
            const data = Buffer.from(sanitizedText);
            if (data.length > MAX_FILE_BYTES || totalBytes + data.length > budget) {
              skipLogFile("redacted-size-limit");
              continue;
            }
// 预算按「读到的原始长度」与「脱敏后长度」取大者累计：脱敏可能膨胀，
// 原始长度反映真实读取量，取大保证不漏算。
            entries.push({ name, data });
            totalBytes += Math.max(length, data.length);
// [资源] 无论读取、解码还是跳过哪条分支退出，句柄都必须在此关闭；
// 提前 continue 的路径已在各自位置计数，关闭不依赖成功与否。
          } finally {
            await handle.close();
          }
        }
      };
      await walk(root, source.archivePrefix, 0);
    }
// 收集齐 entries 再写包：about.txt 的 includedLogFiles 与跳过分布才是最终值，
// 且写包阶段不会与遍历阶段交织失败。
    const zip = new ZipFile();
// 0o600：包内含诊断信息（可能仍有内部路径），只允许当前用户读写；
// 目录由 mkdtemp 以私有权限创建，二者共同限制扩散面。
    const output = createWriteStream(path, { mode: 0o600 });
    // pipeline 同时监听 ZIP 和输出错误，失败统一清理本次目录。
    const writing = pipeline(zip.outputStream, output);
// 名称用 posix 拼接的 archivePrefix/相对路径，与运行平台无关：
// 同一份包在 Windows/macOS 解压后结构一致，便于支持人员对照。
    for (const entry of entries) zip.addBuffer(entry.data, entry.name);
    zip.addBuffer(
      Buffer.from(
        [
          "ZCode diagnostic logs",
          `timestamp: ${now.toISOString()}`,
          `appVersion: ${ZCODE_VERSION}`,
          `commit: ${ZCODE_COMMIT}`,
          `node: ${process.version}`,
          `os: ${platform()} ${release()} (${arch()})`,
          `includedLogFiles: ${entries.length}`,
          `skippedLogFiles: ${Object.values(skippedLogFilesByReason).reduce((sum, count) => sum + count, 0)}`,
          `skippedLogFilesByReason: ${JSON.stringify(skippedLogFilesByReason)}`,
          "Scope: diagnostic text log files modified today (local time), plus an explicit non-sensitive CLI config projection; credentials and structured payloads redacted.",
        ].join("\n"),
      ),
      "about.txt",
    );
// 必须先 end 再 await writing：不 end 就不会有 EOF，pipeline 会一直挂住。
// 顺序颠倒（先 await 后 end）是这类实现最常见的死锁来源。
    zip.end();
    await writing;
// 以磁盘实际大小回报进度与返回值，而不是内存预算估算值；
// `stat` 得到的压缩体积可能远小于原始累计，调用方按实际字节判断是否还能上传。
    const { size } = await stat(path);
    options.onProgress?.({ processedBytes: size, totalBytes: size });
    return { path, size };
// [资源] 失败路径必须整目录删除：zip 可能只写了一半，残留会被上传流程误当成有效包；
// rm 用 force/recursive，清理失败不覆盖原始异常，调用方仍能看到真正原因。
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}
