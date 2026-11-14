import type { ConnectConfig } from "ssh2";
import type { PublicZCodeErrorCode } from "@zcode/shared";

// 60 秒握手超时：公网弱网也需要机会，超时文案里的秒数由它换算。
export const SSH_READY_TIMEOUT_MS = 60_000;
// 15 秒一次 keepalive：足够发现 NAT 静默断开，又不至于刷屏。
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
// 连续无响应 3 次判定失联：与 keepaliveInterval 配合约 45 秒收敛。
export const SSH_KEEPALIVE_COUNT_MAX = 3;

// SSHConnectConfigInput 只描述凭据：超时与 keepalive 由本文件常量决定，不开放给调用方。
interface SSHConnectConfigInput {
  // host 必填：可以是域名或 IP，解析交给 ssh2。
  host: string;
  // port 可选：缺省在 buildSSHConnectConfig 里补 22。
  port?: number;
  // username 必填：SSH 认证无法匿名，缺失时调用方应提前报错。
  username: string;
  // 私钥允许 string/Buffer：上层从配置或文件读到的形态不同。
  privateKey?: string | Buffer;
  // passphrase 只对加密私钥有意义：明文私钥传入会被 ssh2 忽略。
  passphrase?: string;
  // password 与 privateKey 二选一：两者都为空时连接必然认证失败。
  password?: string;
  // agent 显式传入才启用：空值由 buildSSHConnectConfig 决定是否回退 SSH_AUTH_SOCK。
  agent?: string;
}

// isMissingPrivateKeyPassphraseMessage 独立成函数：调用方只关心布尔结果。
function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  // 缺少口令的原文固定：encrypted ... no passphrase 只出现在这一类错误。
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

// isInvalidPrivateKeyPassphraseMessage 独立成函数：正则便于单测，避免内联后无法复用。
function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  // 三个文案对应同一类失败：口令错误时 ssh2 的原文不统一。
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

// 连接配置的唯一构造点：超时与 keepalive 常量在这里统一落到 ssh2。
export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  // hasPassword 只认非空字符串：空串等价于没给密码，避免空密码认证。
  const hasPassword = typeof input.password === "string" && input.password.length > 0;

  // 密码登录场景里如果无条件带上 SSH_AUTH_SOCK，ssh2 会先走 agent 公钥尝试。
  // 某些主机 MaxAuthTries 很小，公钥阶段就会把认证次数耗尽，导致正确密码也无法进入认证。
  // 这里改成“显式传入 agent 才启用”；否则密码模式默认禁用隐式 agent。
  const resolvedAgent = input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"]);

  // 组装 ConnectConfig：所有字段都来自 input 或本文件的常量。
  return {
    // host 原样透传：解析与校验在调用方完成，本函数不二次规范化。
    host: input.host,
    // 缺省端口 22：与 ssh 命令的默认行为一致。
    port: input.port ?? 22,
    // 用户名必填：上层在解析 SSH 目标时已保证非空。
    username: input.username,
    // 私钥可为 string 或 Buffer：ssh2 两种都接受，不做转码。
    privateKey: input.privateKey,
    // passphrase 原样透传：是否加密由私钥本身决定，这里不做猜测。
    passphrase: input.passphrase,
    // 空密码归一成 undefined：传空串会让 ssh2 进入密码认证并立即失败。
    password: hasPassword ? input.password : undefined,
    // 只传解析后的 agent：undefined 时 ssh2 不会隐式读 SSH_AUTH_SOCK。
    agent: resolvedAgent,
    // ssh2 默认 readyTimeout 是 20s，公网弱网或服务端抖动时容易误判超时。
    // 这里显式放宽连接握手超时，既给真实慢连接机会，也让错误归一化能和实际配置保持一致。
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // SSH 项目空闲后如果被 NAT、防火墙或服务端静默断开，stdio channel 不一定会立刻 close。
    // 启用 SSH-level keepalive，让 ssh2 在连续无响应后主动触发 error/close，避免 UI 任务长期卡在 loading。
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    // keepaliveCountMax 为 3：单次丢包不误杀，持续失联能及时收敛。
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // 一些 SSH 服务端只开启 keyboard-interactive（challenge-response）而关闭 plain password。
    // 开启 tryKeyboard + 交互回调后，同一份密码可以覆盖这类主机，避免“命令行可登录、应用里认证失败”。
    tryKeyboard: hasPassword,
  };
}

// 工厂函数：password 捕获在闭包里，ssh2 每次提问都复用它。
export function createKeyboardInteractiveResponder(password?: string) {
  // 返回闭包而不是类：每个连接独立持有 password，无需额外状态。
  return (
    // _name 是键盘交互的认证名，这里不需要分支。
    _name: string,
    // _instructions 仅展示用，统一忽略避免把服务端自由文本带进交互。
    _instructions: string,
    // _lang 当前不使用：保留形参以匹配 ssh2 回调签名。
    _lang: string,
    // prompts 描述服务端要问的几个问题，echo 决定是否回显。
    prompts: Array<{ prompt: string; echo: boolean }>,
    // finish 由 ssh2 注入：回调必须且只能调用一次，重复调用会让握手失败。
    finish: (responses: string[]) => void,
  ) => {
    // 空 password 与 prompts.length===0 同处理：没有可填的值时不应伪造回答。
    if (!password || prompts.length === 0) {
      // 无密码或无提问时交空数组：ssh2 视作未提供响应，继续走其它认证方式。
      finish([]);
      // 提前结束：finish([]) 后必须 return，否则会再回调一次导致 ssh2 抛错。
      return;
    }

    // 每个 prompt 都回同一密码：keyboard-interactive 会把密码拆成多个问题。
    finish(prompts.map(() => password));
  };
}

// 对外唯一错误归一入口：上层拿到的 Error 可安全展示，底层 ssh2 文案不外泄。
export function normalizeSSHConnectError(error: unknown): Error {
  // 用 level 字段识别认证失败：ssh2 的 Error 上该值稳定，文案会随版本变。
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    // 认证失败统一提示三项检查：用户名、密码、私钥，覆盖多数 client-authentication。
    return authenticationError("SSH 认证失败：请检查用户名、密码或私钥配置", error);
  }

  // client-timeout 是 ssh2 的握手超时标记：按 level 字段判定，不依赖文案。
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    // 超时文案带秒数：SSH_READY_TIMEOUT_MS 改了提示会同步，不让用户看到过期数字。
    return new Error(
      `SSH 连接握手超时：未能在 ${SSH_READY_TIMEOUT_MS / 1000} 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异`,
    );
  }

  // Error 分支才做文案归一：非 Error 值没有 message，无法匹配私钥模式。
  if (error instanceof Error) {
    // ssh2 对不同私钥格式（OpenSSH 旧/新格式、PPK）会返回不同文案。
    // 之前仅匹配单一字符串，导致部分“缺少口令/口令错误”场景泄露底层错误文本，用户难以判断应输入哪种凭据。
    // 这里改为模式化归一化，把同类错误稳定映射成产品语义提示，便于用户直接修正输入。
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      // 缺口令提示要求用户补 passphrase：不能让底层英文错误直接透出。
      return authenticationError("SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令", error);
    }
    // 复用正则判据：bad passphrase 与 key integrity 等文案都归到同一分支。
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      // 口令错误单独定码：与「缺少口令」的提示不同，用户要改的是 passphrase 值。
      return authenticationError("SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确", error);
    }
    // 已识别的 Error 原样返回：不重复包装，保留原始 stack 与 cause。
    return error;
  }

  // 字符串错误需先判非空：空串包装后 message 为空，日志里看不出原因。
  if (typeof error === "string" && error.length > 0) {
    // 非空字符串原样包装：ssh2 偶尔只抛字符串，保留原文便于排查。
    return new Error(error);
  }

  // 兜底文案：无法分类的异常仍返回 Error，避免调用方拿到非 Error 类型。
  return new Error("SSH 连接失败");
}

// 认证错误统一构造器：保证 code 与 cause 同时挂上，调用方不必逐处 Object.assign。
function authenticationError(message: string, cause: unknown): Error {
  // 认证发生在懒连接的 probe 内；在仍有 ssh2 结构化原因的边界定码，避免被归成预检失败。
  return Object.assign(new Error(message, { cause }), {
    // 定码 remote-authentication-failed：上层据此区分「凭据错」与「网络/预检失败」。
    code: "remote-authentication-failed" satisfies PublicZCodeErrorCode,
  });
}
