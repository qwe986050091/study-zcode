/**
 * ============================================================================
 * hooks/display-metadata.ts —— Hook 的可展示元数据与文本脱敏
 * ============================================================================
 *
 * descriptor 是 UI/事件侧看到的 hook 摘要:命令展示串、来源、执行模式、超时、
 * 是否客户端可见。命令串可能内嵌 token/URL 凭证,进入 descriptor 前必须脱敏。
 *
 * 脱敏是"宁可多遮"的保守策略,只作用于展示文本,不改变真正执行的命令字节;
 * clientVisible 只由来源决定:internal hook 发事件但不进客户端展示（链路 9）。
 * ============================================================================
 */
import type { HookConfig, HookExecutionDescriptor } from "@zcode/contracts";

// 敏感键名用词根描述而不是枚举全量字符串:access_token / api-key / MY_SECRET 都要命中。
const SENSITIVE_KEY =
  "(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret|token)";
// 允许前后带前缀/后缀段,覆盖 aws_secret_access_key 这类复合命名。
const SENSITIVE_IDENTIFIER = `(?:[A-Za-z0-9]+[_-])*${SENSITIVE_KEY}(?:[_-][A-Za-z0-9]+)*`;
// 固定掩码而不是按原长度打星:长度差异本身也是信息。
const MASK = "••••";

export function createHookExecutionDescriptor(
  hook: HookConfig,
  timeoutMs: number,
  expandDisplayValue: (value: string) => string = (value) => value,
): HookExecutionDescriptor {
  // 展示串按参数边界拼接:process 类型逐段引用,保证可读且能复制粘贴;
  // 它与真正传给 spawn 的 argv 是两份数据,展示层的引号不影响执行。
  const commandDisplay =
    hook.type === "process"
      ? [hook.command, ...(hook.args ?? [])].map(expandDisplayValue).map(quoteCommandPart).join(" ")
      : expandDisplayValue(hook.command);
  // 来源优先级:插件 > 记录来源 > internal。internal 是内置/会话邮箱 hook,
  // 它们照常参与执行与事件,只是不出现在客户端展示里。
  const plugin = hook.plugin;
  const sourceKind = plugin ? "plugin" : (hook.source?.kind ?? "internal");
  return {
    // 可见性由来源决定,而不是由启用状态决定:隐藏 hook 不占用户可见序号,
    // 部分 hook 被跳过时 UI 序号仍然连续（链路 9）。
    clientVisible: sourceKind !== "internal",
    commandDisplay: sanitizeHookDisplayText(commandDisplay),
    // 只有 command 且显式 async 才是后台模式;process 的异步语义由执行器另行处理。
    executionMode: hook.type === "command" && hook.async === true ? "background" : "foreground",
    executionType: hook.type,
    // 可选字段用条件 spread 而非显式 undefined:事件/序列化后形状稳定,便于比对。
    ...(plugin?.id ? { pluginId: plugin.id } : {}),
    ...(plugin?.name ? { pluginName: plugin.name } : {}),
    sourceKind,
    // 路径优先取插件侧:同一 hook 同时来自插件与 source 时,展示以插件为准,
    // 避免出现互相矛盾的两个来源路径。
    ...(plugin?.sourcePath || hook.source?.path
      ? { sourcePath: plugin?.sourcePath ?? hook.source?.path }
      : {}),
    ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
    timeoutMs,
  };
}

export function sanitizeHookDisplayText(value: string): string {
  // 空串直接返回:后续正则链对空值无意义,也省掉一次多余分配。
  if (!value) return value;
  // 六轮定向脱敏,分别覆盖 URL userinfo、Authorization 头、query 参数、
  // 键值/赋值、引号键名、裸键名与 CLI 参数;凭证的语法位置不同无法一次覆盖。
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu, `$1${MASK}:${MASK}@`)
    .replace(
      /(authorization\s*:\s*(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu,
      `$1${MASK}`,
    )
    .replace(
      new RegExp(`([?&](?:authorization|${SENSITIVE_IDENTIFIER})=)[^&\\s"']+`, "giu"),
      `$1${MASK}`,
    )
    .replace(/(\bauthorization\b\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)/giu, `$1${MASK}`)
    .replace(
      new RegExp(
        `((?:"${SENSITIVE_IDENTIFIER}"|'${SENSITIVE_IDENTIFIER}')\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`,
        "giu",
      ),
      `$1${MASK}`,
    )
    .replace(
      new RegExp(
        `(^|[^A-Za-z0-9_])(${SENSITIVE_IDENTIFIER}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`,
        "gimu",
      ),
      `$1$2${MASK}`,
    )
    .replace(
      new RegExp(`((?:--)?${SENSITIVE_IDENTIFIER})(\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "giu"),
      `$1$2${MASK}`,
    );
}

function quoteCommandPart(value: string): string {
  // 安全字符集内原样输出;含空格、引号或换行的参数用 JSON 引号包裹,
  // 让展示串无歧义,也不会因为裸空格被读成两个参数。
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}
