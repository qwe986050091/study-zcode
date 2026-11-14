// INV-01 任何发往 docker 的容器引用在组装 argv 前必须通过白名单正则，拒绝以连字符开头的选项形态；守住位置：buildDockerExecArgs 的首个守卫；改错故障：容器名被 docker 自身解析成 -a、--privileged 之类选项，命令在宿主侧被改写或落到错误容器
// INV-02 远端命令必须以字符串数组交给 execFile 或 spawn，禁止拼接成单条 shell 字符串；守住位置：buildDockerExecArgs 的返回值与 exec、execDirectInContainer 两处调用；改错故障：路径中的空格、分号、反引号被宿主 shell 解释，形成命令注入
// INV-03 需要远端 shell 语义的命令只能作为 sh -lc 的最后一个 argv 元素整体传入；守住位置：exec 的 spawn 参数与 execSimple 的数组构造；改错故障：命令被拆成多个 argv，sh 只执行第一段，其余片段被当作位置参数丢弃
// INV-04 拼进远端 shell 语句的每个动态路径都必须经 quotePosixShellArg 包裹；守住位置：quotePosixShellArg 及其在 mkdir、cat、test -f 三处模板串中的使用；改错故障：含空格或 $ 的路径被展开，写入落到别的文件、读取返回空内容
// INV-05 单引号参数内的单引号必须用闭合再重开的方式转义，不能只加反斜杠；守住位置：quotePosixShellArg 的 replaceAll；改错故障：引号提前闭合，文件名剩余片段被 shell 当成新命令求值
// INV-06 container 引用在 backend 生命周期内视为不变，home 与容器名只解析一次并长期复用；守住位置：constructor 保存 options 与 resolveInfo 的单次解析；改错故障：中途改写配置后 exec 用新值而缓存中的 home 仍是旧容器，上传与执行分属两个环境
// INV-07 容器匹配在单次遍历中按名称全等、ID 全等、ID 前缀三条规则取第一个命中项；守住位置：resolveContainer 的 find 谓词；改错故障：过短的 ID 前缀命中多个容器时按 docker ps 顺序选中，命令作用到无关容器
// INV-08 非 running 状态必须在解析阶段显式报错，不能留给后续命令失败兜底；守住位置：resolveContainer 的 state 判定分支；改错故障：容器已停止时调用方只看到加载中无响应或裸退出码，拿不到明确原因
// INV-09 可用性探测的拒绝态必须清空字段以便重试，而容器解析的拒绝态会被固化；守住位置：ensureAvailable 的 catch 与 resolveInfo 的赋值；改错故障：前者的瞬时故障被永久化，后者的容器恢复后仍持续失败直到新建 backend
// INV-10 同一时刻只允许一个探测或解析在飞，其余调用共享同一个 promise；守住位置：availabilityPromise 与 resolvedInfoPromise 的惰性赋值；改错故障：冷启动并发探测各起一份 docker CLI，首个请求被多倍 round-trip 拖垮
// INV-11 缓存 promise 的赋值必须在同一个同步段内完成，不能在 await 之后再回填；守住位置：resolveInfo 中立即执行函数返回值的赋值；改错故障：并发调用各自发起 docker ps，两次解析结果不一致且后者覆盖前者
// INV-12 上传前必须先按解析后的绝对路径 mkdir -p 父目录，再写文件；守住位置：upload 中 mkdir 与 uploadViaExec 的先后顺序；改错故障：首次连接时目标目录不存在，重定向失败并只留下退出码，用户看到的是上传中止而非目录缺失
// INV-13 文件内容必须经容器内 cat 的标准输入写入，不使用 docker cp；守住位置：uploadViaExec 的 exec 调用；改错故障：文件 owner 变成宿主 UID，容器用户随后 chmod 与部署时权限被拒
// INV-14 上传的每条失败出口都必须先置 settled 再清理监听与流，且清理只发生一次；守住位置：finishError 与 onClose 回调的首行；改错故障：abort 与进程退出同时到达时重复 reject，监听泄漏并在下一次上传重复回调
// INV-15 abort 监听必须在成功与失败两条出口都被移除；守住位置：finishError 与 onClose 内的 removeEventListener；改错故障：长生命周期 signal 累积监听，无关取消会误杀已完成的上传并持续占用内存
// INV-16 上传退出码非零时必须带 stderr 摘要上抛，且摘要长度受固定上限约束；守住位置：onClose 的错误分支与 onStderr 的 slice；改错故障：报错只剩退出码无法定位原因，或超长输出无界增长撑爆内存
// INV-17 exec 直接使用用户已确认的容器引用，不为等价路径再枚举容器；守住位置：exec 的 containerRef 与 readFile 的 $HOME 分支；改错故障：每条命令多出两次 docker ps，冷启动探测耗尽预算后被误判为 Docker 不可用
// INV-18 以 ~ 开头的读取只交给容器内 shell 展开，返回内容统一去掉 CR；守住位置：readFile 的 $HOME 分支与 normalizeDockerOutput；改错故障：Windows 宿主残留的 \r 混入 token 文件，鉴权头解析失败且报错指向远端文件损坏
// INV-19 exec 的关闭事件必须在 exit 与 close 之间只触发一次，管道缺失时必须立即拒绝；守住位置：fireOnce 与 spawn 回调；改错故障：调用方重复收尾导致流被两次关闭，或管道缺失时 promise 永久悬挂使会话卡死
import { spawn, execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { DockerConnectOptions } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { createCloseEventController } from "@zcode/server/remote/closeEvent.js";
import {
  isDockerAvailable,
  listDockerContainers,
  resolveDockerCommand,
  type DockerContainerInfo,
} from "@zcode/server/remote/docker-detect.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";

interface ResolvedDockerInfo {
  containerName: string;
  homeDir: string;
}

const DOCKER_EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const DOCKER_UPLOAD_MAX_STDERR_LENGTH = 2_048;

// [权衡] 用单引号而不是双引号包裹：双引号内仍会展开 $、反引号与反斜杠，路径里的 $ 会被当成变量名。
// 单引号内唯一需要处理的字符就是单引号本身，转义面因此收敛到一条替换规则，无需逐个字符判断。
// 闭合再重开的语义是先结束当前引用、插入一个转义的单引号、再重新开启引用，结果仍是同一个完整参数。
// [失败路径] 漏掉这条替换时，含单引号的文件名会让 shell 提前结束引用，后半段被当作新命令执行。
// 该函数只负责引用，不判断路径是否越出 home；是否允许绝对路径由 resolveLinuxPath 决定。
// 远端必须是能解析这套引号的 POSIX shell，Windows 容器的 cmd 不遵循该规则，本 backend 不做兼容。
// 空串经此函数变成一对空引号，仍是合法参数，不会退化成零个参数而改变后续参数位置。
function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizeDockerOutput(raw: string): string {
  return raw.replace(/\r/g, "");
}

// 函数只拼接 argv，绝不把容器名与命令再合成一条字符串交给宿主 shell 解析。
// [失败路径] 正则要求首字符为字母或数字，正是为了挡掉会被 docker 当成自身选项的引用形态。
// 允许点、下划线与连字符，与容器命名的既有约束一致，也覆盖从 docker ps 复制来的十六进制 ID 前缀。
// [失败路径] 该校验对 exec 与 execDirect 两条路径同时生效，是唯一还能拦住坏引用的位置。
// 校验失败抛普通 Error 而不是静默改写引用，配置错误因此能原样呈现在连接结果里。
// 参数 -i 保留 stdin，上传依赖它把文件内容送进容器；去掉后 cat 立即读到 EOF 并写出空文件。
// 命令参数整体作为 argv 尾部展开，参数边界由进程边界保证，不经过任何 shell 分词。
function buildDockerExecArgs(containerName: string, commandArgs: string[]): string[] {
  // 直接 exec/read 跳过容器枚举后失去了隐式校验；在组装 argv 处拒绝选项形态和非法引用。
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) {
    throw new Error("Invalid Docker container reference");
  }
  return ["exec", "-i", containerName, ...commandArgs];
}

export class DockerBackend implements IRemoteBackend {
  private readonly dockerCommand = resolveDockerCommand();
  private readonly options: DockerConnectOptions;
  private availabilityPromise: Promise<void> | null = null;
  // 缓存的是 promise 而不是结果：首个调用者创建，后续调用者直接等待同一个对象。
  // [并发] 判空与赋值之间没有 await，因此并发进入也只会创建一个解析，不会出现两份 docker ps。
  // [权衡] 与可用性探测不同，这里的拒绝态不会清空：home 解析失败通常意味着容器或配置有问题。
  // [资源] 缓存只持有 promise 与两个字符串，不持有子进程或流，不需要显式释放。
  // [失败路径] 一旦解析失败，后续 read 与 upload 都会立刻拿到同一个错误，只能凭错误文本区分故障类型。
  // home 与 containerName 必须来自同一次解析，分开缓存会让两者可能指向不同容器。
  // 该字段只在类内部读写，外部无法注入，避免调用方或测试伪造解析结果绕过容器校验。
  private resolvedInfoPromise: Promise<ResolvedDockerInfo> | null = null;

  constructor(options: DockerConnectOptions) {
    this.options = options;
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureAvailable();
    const reportedPlatform = normalizeRemotePlatform(
      normalizeDockerOutput(await this.execSimple("uname -s")),
    );
    const arch = normalizeRemoteArch(normalizeDockerOutput(await this.execSimple("uname -m")));
    const kernelOstype = await this.readKernelOstype();
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    if (platform !== reportedPlatform) {
      // 测试容器里可能通过 wrapper 伪造了 uname 输出，
      // 这里只在发生回退时打一条低频日志，便于排查“为何最终按 Linux 选包”。
      console.warn(
        `[docker] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
      );
    }

    return {
      platform,
      arch,
    };
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    const parentDir = this.dirname(resolvedRemotePath);

    // 上传流不会帮我们创建父目录。
    // 如果直接写入 `~/.zcode/server/...` 这类首次连接路径，上传会因为目录不存在而失败。
    // 先显式 `mkdir -p`，再由容器当前用户写入目标文件，和 SSH/WSL 保持一致。
    // [失败路径] 先建目录再写文件：上传流本身没有创建目录的能力，父目录缺失时重定向会直接失败。
    // 父目录来自已展开 home 的绝对路径，不再含波浪号，因此 mkdir 与随后的写入落在同一位置。
    // [权衡] 用一次额外 round-trip 换掉 docker cp 的 owner 问题，代价是每次上传多一条容器命令。
    // mkdir -p 对已存在目录是幂等的，重复上传不会因为目录已存在而中止。
    // 只创建父目录，不创建文件本身；文件由 stdin 写入，权限遵循容器当前用户的 umask。
    // 目录名经 quotePosixShellArg 处理，含空格或单引号的路径不会被拆成多个参数。
    // 若远端路径本身是相对路径，dirname 返回的仍是相对片段，此时目录相对容器工作目录而不是 home。
    await this.execSimple(`mkdir -p ${quotePosixShellArg(parentDir)}`);

    // `docker cp` 复制到容器后的文件可能保留宿主 UID/GID，
    // 非 root 容器用户随后无法 chmod。统一由容器当前用户通过 stdin 写入，
    // 保证文件 owner 与后续部署命令的执行用户一致。
    await this.uploadViaExec(localPath, resolvedRemotePath, options ?? {});
  }

  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options: RemoteUploadOptions,
  ): Promise<void> {
    const totalBytes = await stat(localPath).then((value) => value.size);
    if (options.signal?.aborted) {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      throw error;
    }
    // 上传以容器内 cat 重定向写入，本地字节经 stdin 单向流入，stdout 不承载任何数据。
    // [资源] 本地读流、远端 stdin、stderr 三者都要在出口处收尾，漏一个就会在进程生命周期内累积句柄。
    // settled 是幂等闸门：abort、读流错误、写流错误、进程退出四条路径都可能先到。
    // [失败路径] abort 时销毁 stdin 让容器侧 cat 读到 EOF 并退出，否则子进程会一直挂着直到外部超时。
    // 进度按读取到的字节数上报，正常结束时强制补一次满额，避免最后一块未触发回调而进度停在 99%。
    // stderr 只保留尾部固定长度，容器初始化脚本可能输出很长，全量缓冲会无界增长。
    // [并发] 同一 backend 允许并发多次上传，每次调用持有独立的 settled 与监听，不共享任何状态。
    const stream = await this.exec(`cat > ${quotePosixShellArg(resolvedRemotePath)}`);
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let stderrText = "";
      let uploadedBytes = 0;
      let settled = false;
      const onStderr = (chunk: Buffer | string) => {
        stderrText = `${stderrText}${chunk.toString()}`.slice(-DOCKER_UPLOAD_MAX_STDERR_LENGTH);
      };
      stream.stderr.on("data", onStderr);
      const removeStderrListener = () => {
        stream.stderr.removeListener("data", onStderr);
      };
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        readStream.destroy();
        const destroyable = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        destroyable.destroy?.(error);
        reject(error);
      };
      const abort = () => {
        const error = new Error("Remote upload canceled");
        error.name = "AbortError";
        finishError(error);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      readStream.on("data", (chunk: Buffer) => {
        uploadedBytes += chunk.length;
        options.onProgress?.({ uploadedBytes, totalBytes });
      });
      readStream.on("error", finishError);
      stdin.on("error", finishError);
      stream.onClose((code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        if (code !== 0) {
          const stderrSummary = normalizeDockerOutput(stderrText).trim();
          reject(
            new Error(
              stderrSummary
                ? `Docker upload failed with exit code ${code}: ${stderrSummary}`
                : `Docker upload failed with exit code ${code}`,
            ),
          );
          return;
        }
        options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
        resolve();
      });
      readStream.pipe(stdin);
    });
  }

  async exec(command: string): Promise<StdioStream> {
    // Bug 原因：`docker exec` 本身接受名称、完整 ID 和 ID 前缀，也会权威报告 daemon/
    // container 状态。旧实现却在每条命令前先跑 `docker version`，首次再跑两次 `docker ps`
    // 和一次 home 探测；冷启动 Source 的单 round-trip probe 因而被放大成五条 CLI 命令。
    // 纯 exec 不解析远端路径，直接使用用户已确认的 container ref；需要 `~` 展开为本地
    // 路径的 read/upload 仍走 resolveInfo 的严格校验。
    // trim 只去掉首尾空白，容器名中间的空格会原样进入正则并被拒绝，不会变成两个参数。
    // 信任边界：该引用来自用户在本机配置里确认的容器，backend 不再用 docker ps 交叉校验一致性。
    // 命令以 sh -lc 传入，容器内仍是完整 shell 语义，调用方拼接的字符串同样要自行引用。
    // [失败路径] 容器不存在或已停止时这里不预判，错误表现为子进程非零退出与 stderr 文案。
    // [资源] 子进程三个管道都由调用方消费，长期不读 stdout 会写满管道缓冲并阻塞容器侧输出。
    // 与 read 和 upload 的严格解析并不矛盾：那两条路径需要展开 home，本来就依赖容器枚举。
    // 每次调用都重新读取配置对象，若调用方中途改写 container，前后命令会发往不同目标。
    const containerRef = this.options.container.trim();

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.dockerCommand,
        buildDockerExecArgs(containerRef, ["sh", "-lc", command]),
        {
          stdio: "pipe",
          windowsHide: true,
        },
      );

      child.once("error", reject);
      child.once("spawn", () => {
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
          reject(new Error("Docker exec stdio is not available"));
          return;
        }

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) {
            return;
          }
          fired = true;
          onClose.fire(code);
        };

        child.on("exit", (code) => {
          fireOnce(code ?? 0);
        });
        child.on("close", (code) => {
          fireOnce(code ?? 0);
        });

        resolve({
          stdin,
          stdout,
          stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resolvedInfo = await this.resolveInfo();
      const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
      await this.execSimple(`test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    if (remotePath === "~" || remotePath.startsWith("~/")) {
      // Source ingress token 等内部文件本来就以 home 相对路径表达；shell 在容器内能权威
      // 展开 `$HOME`，无需先用 docker ps + docker exec 解析同一个 container/home。
      const shellPath =
        remotePath === "~" ? '"$HOME"' : `"$HOME"/${quotePosixShellArg(remotePath.slice(2))}`;
      return normalizeDockerOutput(
        await this.execDirectInContainer(this.options.container.trim(), [
          "sh",
          "-lc",
          `cat ${shellPath}`,
        ]),
      );
    }
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    return normalizeDockerOutput(
      await this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`),
    );
  }

  dispose(): void {
    // Docker backend 的命令都是一次性子进程，没有常驻连接需要显式清理。
  }

  // [并发] 判断字段为空与写入 promise 之间没有 await，并发进入也只会创建一次探测。
  // 第二个及之后的调用者直接等待同一个 promise，不会重复启动 docker version 子进程。
  // [失败路径] 拒绝态同时传播给所有等待者，各自拿到同一个 Error 实例，不会二次包装或改写文案。
  // 字段被清空只发生在失败分支，成功路径永远保留已兑现的 promise 供后续复用。
  // [权衡] 采用惰性探测而非构造时探测：构造可能早于 daemon 就绪，那时失败会被固化。
  // 等待本身不支持取消，调用方中途放弃时探测子进程仍会跑到结束。
  // 该方法不吞错误，连接层据此把不可用状态映射成用户可读的提示而不是空结果。
  private async ensureAvailable(): Promise<void> {
    if (!this.availabilityPromise) {
      // Bug 原因：Source probe 内的每条 Docker exec 都重复执行 `docker version`；首次解析
      // container/home 又重复 `docker ps`。应用冷启动峰值下，四五个 CLI round-trip 会让
      // 单个本地 Docker Source 在真正 probe 前就耗尽 10 秒预算。Backend 生命周期内只需
      // 探测一次 daemon；失败清空 promise，后续显式重试仍可重新检测。
      this.availabilityPromise = isDockerAvailable()
        .then((available) => {
          if (!available) throw new Error("当前系统未检测到可用的 Docker 环境");
        })
        .catch((error) => {
          this.availabilityPromise = null;
          throw error;
        });
    }
    await this.availabilityPromise;
  }

  private async resolveInfo(): Promise<ResolvedDockerInfo> {
    if (this.resolvedInfoPromise) {
      return this.resolvedInfoPromise;
    }

    this.resolvedInfoPromise = (async () => {
      const container = await this.resolveContainer();
      const homeDir = normalizeDockerOutput(
        await this.execDirectInContainer(container.name, ["sh", "-lc", "printf %s ~"]),
      ).trim();

      return {
        containerName: container.name,
        homeDir,
      };
    })();

    return this.resolvedInfoPromise;
  }

  private async resolveContainer(): Promise<DockerContainerInfo> {
    // all 为 true 才能看到已停止的容器，否则停止的容器会被报成未找到，误导用户去改名字。
    // [失败路径] 匹配不上时抛出带用户配置名的错误，指明是引用问题而不是 daemon 问题。
    // 名称全等优先于 ID 前缀，避免用户把容器命名成另一个容器 ID 的前缀时选错目标。
    // [权衡] 保留前缀匹配以便直接粘贴 docker ps 输出的短 ID，代价是过短前缀存在歧义，按列表顺序取首个。
    // 状态比较统一转小写，避免 docker 输出大小写不一致时把运行中的容器判成停止。
    // state 为空时错误信息补 unknown，避免出现空尾巴让人误以为容器列表解析失败。
    // 该方法是纯查询，不启动也不重启容器，停止状态一律交给用户自行处理。
    const containers = await listDockerContainers({ all: true });
    const matched = containers.find(
      (container) =>
        container.name === this.options.container ||
        container.id === this.options.container ||
        container.id.startsWith(this.options.container),
    );

    if (!matched) {
      throw new Error(`未找到名为 ${this.options.container} 的 Docker 容器`);
    }

    if (matched.state.toLowerCase() !== "running") {
      throw new Error(
        `Docker 容器 ${matched.name} 当前未运行（state=${matched.state || "unknown"}）`,
      );
    }

    return matched;
  }

  private resolveLinuxPath(remotePath: string, homeDir: string): string {
    if (remotePath === "~") {
      return homeDir;
    }

    if (remotePath.startsWith("~/")) {
      return `${homeDir.replace(/\/$/, "")}/${remotePath.slice(2)}`;
    }

    return remotePath;
  }

  private dirname(remotePath: string): string {
    const normalized = remotePath.replace(/\/+/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) {
      return "/";
    }

    return normalized.slice(0, lastSlash);
  }

  private async execSimple(command: string): Promise<string> {
    return this.execDirect(["sh", "-lc", command]);
  }

  private async readKernelOstype(): Promise<string> {
    try {
      return normalizeDockerOutput(
        await this.execSimple(
          "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi",
        ),
      ).trim();
    } catch {
      return "";
    }
  }

  private async execDirect(commandArgs: string[]): Promise<string> {
    const container = await this.resolveContainer();
    return await this.execDirectInContainer(container.name, commandArgs);
  }

  private async execDirectInContainer(
    containerName: string,
    commandArgs: string[],
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // [权衡] 用 execFile 而不是 exec：参数以数组传递且不经过 shell，路径里的元字符构不成注入面。
      // maxBuffer 固定为 8MB，超出时回调收到错误而不是留下被截断的半份内容。
      // [失败路径] 失败时优先返回 stderr 文本，docker 的错误说明比 Node 的默认 message 更贴近根因。
      // stderr 与 stdout 都要去掉 CR，Windows 宿主上 docker CLI 的输出可能带回车，会让逐行解析错位。
      // windowsHide 避免桌面端每次命令闪出控制台窗口，不改变任何输出内容。
      // 该函数不注册取消监听，长命令只能靠自身退出；上传路径因此单独实现了中止逻辑。
      // 容器名与参数已在 buildDockerExecArgs 校验，这里不重复判断，避免两处规则漂移。
      execFile(
        this.dockerCommand,
        buildDockerExecArgs(containerName, commandArgs),
        {
          encoding: "utf8",
          maxBuffer: DOCKER_EXEC_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(normalizeDockerOutput(stderr).trim() || error.message));
            return;
          }

          resolve(normalizeDockerOutput(stdout));
        },
      );
    });
  }
}
