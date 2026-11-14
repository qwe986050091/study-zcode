// INV-01 守住位置：远端互斥只靠 mkdir 锁目录的原子失败，不用 flock 也不引入额外守护进程；改错故障：换成先 stat 再 mkdir 会让两个 waiter 同时判定锁空闲并双双进入临界区
// INV-02 守住位置：owner 文件在 mkdir 成功之后写入，写入之前「目录存在」本身就代表已被占用；改错故障：先写 owner 再建目录会让 waiter 读到空 owner 而误判锁可回收
// INV-03 守住位置：stale 判定以 owner 文件 mtime 为准，缺失时回落到锁目录 mtime，阈值固定 600 秒；改错故障：只认目录 mtime 且不刷新 owner 会把活跃持有者误判为过期
// INV-04 守住位置：stale 回收先 mv 到带 ownerToken 的临时路径再 rm -rf，mv 失败即视为他人已回收；改错故障：直接删除会误伤刚被心跳刷新过的新锁
// INV-05 守住位置：心跳每 30 秒 touch owner 文件，循环条件比对 owner 内容是否仍等于本 token；改错故障：改成无条件死循环会在锁易主后继续替别人续期
// INV-06 守住位置：cleanup 仅在 owner 文件内容仍等于本 token 时删除锁目录；改错故障：无条件删除会把后继持有者的锁一起清掉，互斥彻底失效
// INV-07 守住位置：acquired 与 release 两个 marker 都嵌 ownerToken，waiter 只认本会话的 marker；改错故障：去掉 token 会让旧会话的残留输出被当成加锁成功
// INV-08 守住位置：release 走同一条会话的 stdin 发送 marker 并立刻 end，远端脚本以读到 marker 为唯一放行条件；改错故障：另开连接发送会被脚本判为非法输入并 exit 1
// INV-09 守住位置：锁脚本以八进制转义落盘再用 printf %b 还原，规避外层 shell 提前展开变量；改错故障：直接写原文会被 wsl 登录 shell 吞掉全部局部变量
// INV-10 守住位置：锁脚本显式交由 sh 执行且只用 POSIX 语法，兼容 Alpine 与 BusyBox；改错故障：改用 bash 会在没有 bash 的远端直接失败
// INV-11 守住位置：脚本路径由 lockDir 与 ownerToken 拼成，执行前先 mkdir -p 其父目录；改错故障：父目录不存在会让重定向落盘失败，被 set -eu 提前终止
// INV-12 守住位置：acquire 默认 120 秒 deadline，超时只销毁本会话流、不删除远端锁；改错故障：超时即删锁会破坏仍然存活的持有者的临界区
// INV-13 守住位置：deadline 计时器在订阅 stdout 之前安装，避免 marker 同步到达后残留计时器；改错故障：顺序颠倒会让已成功的获取在到期时被超时回调二次结算
// INV-14 守住位置：close 句柄与 marker 判定同批挂接，持有者提前退出立刻让 waiter 失败而不是等 deadline；改错故障：漏掉这条路径会把崩溃误报成超时并丢掉真实退出码
// INV-15 守住位置：release 复用 acquire 建立的同一条会话，5 秒超时后只销毁流不删远端目录；改错故障：超时即删锁会与远端 cleanup 竞态，留下删不掉的残留目录
// INV-16 守住位置：stderr 与 stdout 缓冲都只保留尾部 4096 字节，诊断随超时或非零退出一起抛出；改错故障：无上限累积会让长时间排队的 waiter 占住内存
// INV-17 守住位置：releasePromise 一旦创建即固定，重复释放返回同一结果且不再重试；改错故障：每次重试都重写 stdin，已关闭的远端会话会收到重复 marker
// INV-18 守住位置：获取失败路径解绑 stderr 监听并释放 close 句柄，释放路径在 finally 中做同样清理；改错故障：漏掉清理会在共享 backend 上累积订阅与回调
//
// 模块职责：在远端主机上用 mkdir 目录锁实现部署互斥，把加锁、心跳续期、过期回收与释放收敛到一条 sh 会话里。
// 状态所有权：锁状态全部落在远端文件系统，本地只持有 ownerToken、stdio 会话与一次性 deadline，不跨调用共享可变状态。
// 阅读顺序：先看常量与句柄契约，再看锁脚本里 mkdir、stale 回收与 trap 的先后顺序，最后看 acquire 的 deadline 竞争与 release 的幂等封装。
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import { REMOTE_BASE } from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "@zcode/server/remote/posixShell.js";

// 三个时间常量共同划定锁的活性窗口：心跳 30 秒一次，过期阈值 600 秒，恰好容忍二十次心跳丢失
// 远端脚本把 30 与 600 直接内联进 shell 文本，改动这里会同时改变远端行为，不存在第二份可覆盖的配置
// 过期阈值必须显著大于心跳间隔，否则一次网络抖动就会让 waiter 误判持有者已死并抢锁
// 获取超时默认 120 秒，远小于过期阈值，正常排队者不会走到 stale 回收，避免无谓的重命名与删除
// 释放超时 5 秒只覆盖本地等待 close 事件，与远端 cleanup 的实际耗时无关
const DEPLOY_LOCK_HEARTBEAT_SECONDS = 30;
const DEPLOY_LOCK_STALE_SECONDS = 600;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const MAX_LOCK_STDERR_LENGTH = 4_096;

// 句柄只暴露 ownerToken 与 release，不交出底层 stdio，调用方无法绕过 marker 协议直接关连接
// ownerToken 同时嵌进 acquired 与 release 两个 marker，是远端脚本识别本次会话的唯一凭据
// release 被设计成幂等：重复调用返回同一个 promise，而不是再次向 stdin 写入释放标记
// 句柄存活期间远端 sh 进程必须阻塞等待 release marker，持有时长就等于业务临界区长度
// 句柄本身不持有计时器，acquire 与 release 各自的 deadline 都在内部创建并在 finally 清理
export interface RemoteDeployLockHandle {
  ownerToken: string;
  release(): Promise<void>;
}

export interface AcquireRemoteDeployLockOptions {
  lockDir?: string;
  ownerToken?: string;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
}

function destroyStreamBestEffort(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  try {
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  } catch {
    // release timeout 后只尽力关闭本次 lock-holder stream；清理失败不能再次覆盖 timeout 诊断。
  }
}

// 按 stdin、stdout、stderr 的顺序依次尽力销毁，任何一条抛错都不阻断后面两条
// 关闭异常被就地吞掉，避免覆盖此前已经构造好的 timeout 诊断信息
// 这里不碰 backend 的销毁入口：backend 由上层统一回收，误关会让同一 backend 上的其他会话一起断
// 只在 acquisition deadline 与 release deadline 两个分支调用，正常完成路径永远不会走到这里
// stdin 若尚未写入就销毁，远端 read 可能拿到空行，脚本把空行当作非法 marker 后自行退出
function destroyLockStreamBestEffort(stream: StdioStream): void {
  destroyStreamBestEffort(stream.stdin);
  destroyStreamBestEffort(stream.stdout);
  destroyStreamBestEffort(stream.stderr);
}

// 唯一的互斥原语是远端 mkdir，靠它在目录已存在时的原子失败实现无 flock 的跨进程锁
// 必须先拿到目录再写 owner 文件，读到空 owner 的 waiter 只能观察到 mtime 尚未刷新，不会误认持有者
// 过期回收用 mv 到带 ownerToken 的临时路径再删除，mv 失败就说明别的 waiter 已经抢先回收
// cleanup 只在自己仍是 owner 时删除目录，防止把下一个持有者刚建立的锁一起抹掉
// trap 覆盖 EXIT/HUP/INT/TERM，保证 sh 被杀时锁目录与心跳子进程都被回收
// 心跳循环条件读取 owner 文件内容，owner 一旦易主就自行退出，不会替新持有者续 mtime
function buildRemoteDeployLockScript(lockDir: string, ownerToken: string): string {
  const acquiredMarker = `zcode-deploy-lock-acquired:${ownerToken}`;
  const releaseMarker = `zcode-deploy-lock-release:${ownerToken}`;
  return [
    "set -eu",
    `lock_dir=${quotePosixPathArg(lockDir)}`,
    `owner_token=${quotePosixShellArg(ownerToken)}`,
    'owner_file="$lock_dir/owner"',
    'stale_dir="$lock_dir.stale-$owner_token"',
    `mkdir -p ${quotePosixPathArg(posix.dirname(lockDir))}`,
    'while ! mkdir "$lock_dir" 2>/dev/null; do',
    '  lock_mtime=$({ stat -c %Y "$owner_file" || stat -f %m "$owner_file" || stat -c %Y "$lock_dir" || stat -f %m "$lock_dir"; } 2>/dev/null || printf 0)',
    "  lock_now=$(date +%s)",
    `  if [ "$lock_mtime" -gt 0 ] && [ $((lock_now - lock_mtime)) -ge ${DEPLOY_LOCK_STALE_SECONDS} ]; then`,
    '    if command mv "$lock_dir" "$stale_dir" 2>/dev/null; then rm -rf "$stale_dir"; fi',
    "    continue",
    "  fi",
    "  sleep 1",
    "done",
    'printf %s "$owner_token" > "$owner_file"',
    "lock_heartbeat_pid=",
    "cleanup_deploy_lock() {",
    '  if [ -n "${lock_heartbeat_pid:-}" ]; then kill "$lock_heartbeat_pid" >/dev/null 2>&1 || true; wait "$lock_heartbeat_pid" 2>/dev/null || true; fi',
    '  current_owner=$(cat "$owner_file" 2>/dev/null || true)',
    '  if [ "$current_owner" = "$owner_token" ]; then rm -rf "$lock_dir"; fi',
    "}",
    "trap cleanup_deploy_lock EXIT HUP INT TERM",
    `(while [ "$(cat "$owner_file" 2>/dev/null || true)" = "$owner_token" ]; do touch "$owner_file" 2>/dev/null || exit 0; sleep ${DEPLOY_LOCK_HEARTBEAT_SECONDS}; done) &`,
    "lock_heartbeat_pid=$!",
    `printf '%s\n' ${quotePosixShellArg(acquiredMarker)}`,
    "release_marker=",
    "IFS= read -r release_marker || true",
    `if [ "$release_marker" != ${quotePosixShellArg(releaseMarker)} ]; then echo ${quotePosixShellArg("[deploy-lock] invalid release marker")} >&2; exit 1; fi`,
  ].join("\n");
}

// 逐字节转成三位八进制转义，确保脚本正文里不出现任何会被外层 shell 解释的字符
// 落盘时用 printf %b 还原，八进制转义是 POSIX printf 的必备能力，BusyBox 同样支持
// 保留这层编码是为了绕开 wsl 登录 shell 提前展开局部变量的历史问题，与脚本语法无关
// 编码只按 UTF-8 字节处理，不做 locale 转换，远端非 UTF-8 环境可能显示乱码但不影响执行
// 转义串长度约为原文四倍，锁脚本本身很短，整条命令仍在远程 exec 参数长度的承受范围内
function encodePosixOctal(value: string): string {
  return Array.from(
    Buffer.from(value, "utf8"),
    (byte) => `\\${byte.toString(8).padStart(3, "0")}`,
  ).join("");
}

function buildRemoteDeployLockCommand(lockDir: string, ownerToken: string): string {
  const scriptPath = `${lockDir}.holder-${ownerToken}.sh`;
  const script = buildRemoteDeployLockScript(lockDir, ownerToken);
  // 历史原因：WSLBackend 曾以 `wsl.exe -- bash -lc` 启动，默认 shell 会先把脚本里的局部 `$var`
  // 展开为空，所以这里改为纯八进制内容落盘后再执行。该根因已由 buildWslArgs 改用 `--exec` 修复
  //（R3-ISSUE-024），落盘路径继续保留：三种 backend 共用一条命令，同时保留 stdin 给 release marker。
  // 锁脚本只使用 POSIX 语法，显式用 sh 执行，兼容 Alpine/BusyBox 等没有 bash 的远端。
  return [
    "set -eu",
    `mkdir -p ${quotePosixPathArg(posix.dirname(scriptPath))}`,
    `printf '%b' ${quotePosixShellArg(encodePosixOctal(script))} > ${quotePosixPathArg(scriptPath)}`,
    `trap ${quotePosixShellArg(`rm -f ${quotePosixPathArg(scriptPath)}`)} EXIT HUP INT TERM`,
    `sh ${quotePosixPathArg(scriptPath)}`,
  ].join("\n");
}

function createStreamClosePromise(stream: StdioStream): {
  promise: Promise<number>;
  dispose(): void;
} {
  let disposable: { dispose(): void } | undefined;
  const promise = new Promise<number>((resolve) => {
    disposable = stream.onClose((code) => resolve(code));
  });
  return {
    promise,
    dispose() {
      disposable?.dispose();
    },
  };
}

export async function acquireRemoteDeployLock(
  backend: IRemoteBackend,
  options: AcquireRemoteDeployLockOptions = {},
): Promise<RemoteDeployLockHandle> {
  const ownerToken = options.ownerToken?.trim() || randomUUID();
  const lockDir = options.lockDir?.trim() || `${REMOTE_BASE}/.deploy.lock`;
  const acquireTimeoutMs = Math.max(
    1,
    Math.floor(options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS),
  );
  const releaseTimeoutMs = Math.max(
    1,
    Math.floor(options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS),
  );
  const acquiredMarker = `zcode-deploy-lock-acquired:${ownerToken}`;
  const releaseMarker = `zcode-deploy-lock-release:${ownerToken}`;
  // 一次 exec 同时承载加锁脚本与后续的释放通道，锁的生命周期就是这条 stdio 会话的生命周期
  // acquired marker 只认本会话的 ownerToken，收到旧会话残留输出不会被判为加锁成功
  // stdout 与 stderr 各自只留尾部 4096 字节，长时间等待时关键诊断不会被无关输出冲掉
  // 拿到 stream 之后才安装 deadline，exec 本身失败会直接抛出，不会留下半开的流
  // 同一 backend 上的并发调用各持一条会话，互斥完全依赖远端目录而不是进程内状态
  const stream = await backend.exec(buildRemoteDeployLockCommand(lockDir, ownerToken));
  const close = createStreamClosePromise(stream);
  let stderrText = "";
  const onStderr = (chunk: Buffer | string) => {
    stderrText = `${stderrText}${chunk.toString()}`.slice(-MAX_LOCK_STDERR_LENGTH);
  };
  stream.stderr.on("data", onStderr);

  try {
    await new Promise<void>((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        stream.stdout.off("data", onStdout);
        if (timeout) {
          clearTimeout(timeout);
        }
      };
      const onStdout = (chunk: Buffer | string) => {
        stdoutBuffer = `${stdoutBuffer}${chunk.toString()}`.slice(-MAX_LOCK_STDERR_LENGTH);
        if (!stdoutBuffer.includes(acquiredMarker) || settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onTimeout = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        // 其他 owner 持续 heartbeat 时 stale recovery 永远不会触发，waiter 会永久挂住。
        // deadline 后只销毁本次 waiter 的 stream，不删除远端 lock，也不 dispose 共享 backend。
        destroyLockStreamBestEffort(stream);
        reject(
          new Error(
            `[deploy-lock] lock acquisition timed out after ${acquireTimeoutMs}ms (owner=${ownerToken})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          ),
        );
      };
      // 先安装 deadline 再订阅 stdout；某些 stream 在注册 data listener 时会同步吐出缓冲 marker。
      // 若顺序相反，marker 已 resolve 后才创建的 timer 会残留到 deadline。
      timeout = setTimeout(onTimeout, acquireTimeoutMs);
      stream.stdout.on("data", onStdout);
      void close.promise.then((code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new Error(
            `[deploy-lock] lock-holder exited before acquisition (code=${code})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          ),
        );
      });
    });
  } catch (error) {
    stream.stderr.off("data", onStderr);
    close.dispose();
    throw error;
  }

  // releasePromise 缓存把重复释放折叠成同一次远端交互，第二次调用直接复用第一次的结果
  // 失败结果同样被缓存：超时之后再调 release 不会重试，是否继续由调用方决定
  // 只有 error 与预先构造的 timeoutError 全等时才销毁流，写失败等其他异常把连接留给 backend 处理
  // finally 里解绑 stderr 监听并释放 close 句柄，避免每次释放都在共享 backend 上留下订阅
  // 释放超时后不重试也不删远端目录，残留锁交给下一个 waiter 的 stale 回收流程消化
  let releasePromise: Promise<void> | null = null;
  return {
    ownerToken,
    release() {
      if (releasePromise) {
        return releasePromise;
      }
      releasePromise = (async () => {
        try {
          stream.stdin.write(`${releaseMarker}\n`);
          stream.stdin.end();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutError = new Error(
            `[deploy-lock] lock-holder release timed out after ${releaseTimeoutMs}ms (owner=${ownerToken})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          );
          let code: number;
          try {
            code = await Promise.race([
              close.promise,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(timeoutError), releaseTimeoutMs);
              }),
            ]);
          } catch (error) {
            if (error === timeoutError) {
              // 远端半开或 close 事件丢失会让 deployServer 永久卡在 finally。
              // deadline 后只销毁当前 owner 的 stdio，让 backend 后续 dispose 接管底层连接回收。
              destroyLockStreamBestEffort(stream);
            }
            throw error;
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
          }
          if (code !== 0) {
            throw new Error(
              `[deploy-lock] lock-holder release failed (code=${code})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
            );
          }
        } finally {
          stream.stderr.off("data", onStderr);
          close.dispose();
        }
      })();
      return releasePromise;
    },
  };
}
