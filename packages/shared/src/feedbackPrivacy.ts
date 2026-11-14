// INV-01 只用于反馈材料：守住位置 顶部说明；改错故障 被误用于请求或认证载荷。
// INV-02 键名先归一再去匹配：守住位置 normalizeKey；改错故障 变体命名绕过敏感名单。
// INV-03 敏感键与诊断正文键分级：守住位置 shouldRedactKey；改错故障 普通模式漏掉正文。
// INV-04 带引号字段与无引号字段同判：守住位置 fieldKeys；改错故障 引号形式逃逸。
// INV-05 无法解码的键仍按字面处理：守住位置 解析失败分支；改错故障 转义键名绕过。
// INV-06 URL 凭据在任何位置都要清除：守住位置 shouldRedactUrlPath；改错故障 webhook 路径泄露。
// INV-07 带签名参数的查询串整体判敏感：守住位置 参数名判定；改错故障 签名链接外泄。
// INV-08 无法解码的路径按不安全处理：守住位置 捕获分支；改错故障 编码形式绕过。
// INV-09 认证头与私钥先整体替换：守住位置 redactValues 前两步；改错故障 跨行密钥残留。
// INV-10 键值对按分隔符替换值：守住位置 正则替换；改错故障 值保留原文。
// INV-11 路径统一替换为用户占位：守住位置 最后一条替换；改错故障 本机路径泄露。
// INV-12 诊断模式额外替换邮箱：守住位置 diagnostic 分支；改错故障 反馈含个人信息。
// INV-13 递归深度上限 32：守住位置 scrubValue 与 redactText；改错故障 深层对象导致栈溢出。
// INV-14 对象按键判定后递归清洗：守住位置 fromEntries；改错故障 值已脱敏而键仍泄露。
// INV-15 纯文本按行二次判定：守住位置 redactPlainText；改错故障 已替换值被再次切断。
// INV-16 JSON 片段按括号配对截取：守住位置 jsonFragmentEnd；改错故障 截断对象漏值。
// INV-17 片段解析失败整行舍弃：守住位置 内层捕获；改错故障 半截值泄露。
// INV-18 公开入口只接受文本与诊断开关：守住位置 redactFeedbackText；改错故障 调用方绕过管道。
//
// 模块职责：反馈排障文本的脱敏管道，覆盖结构化与半结构化日志。
// 状态所有权：无状态；全部替换基于入参文本生成新字符串。
// 阅读顺序：先看键名判定，再读值级清洗，最后看片段切分与公开入口。
/** 仅用于用户反馈的排障材料；不得应用到模型请求或认证载荷。 */
// 本文件是纯函数脱敏管道（核心为 redactText），不持有模块级可变状态。
// 不读取磁盘也不发送网络，全部输入来自 text 与 diagnostic 参数。
// 所有 replace 都保持原文结构，只改命中片段。
// 占位符 REDACTED 为固定常量，调用方不得改写。
// 调用方只传入 text 与 diagnostic，不传正则。
const REDACTED = "[REDACTED]";
const sensitiveKey =
  /(?:password|passwd|passphrase|secret|token|apikey|accesskey|privatekey|authorization|cookie|credential)/i;
const diagnosticBodyKey =
  /^(?:content|messages?|prompt|systemprompt|request|response|body|payload|input|output|toolinput|tooloutput|arguments|args|env|environment|headers|text|completion|result|stdout|stderr|data|params)$/i;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "");
}

function shouldRedactKey(key: string, diagnostic: boolean): boolean {
  const normalized = normalizeKey(key);
  return sensitiveKey.test(normalized) || (diagnostic && diagnosticBodyKey.test(normalized));
}

// 与 JSON 对象共用键名判定；带引号、转义和分隔符的字段不能走另一份精简名单。
function fieldKeys(text: string): Array<{ key: string; quoted: boolean; end: number }> {
  const fields = [];
  const pattern = /(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([\w.-]+))\s*[:=]\s*/g;
  for (const match of text.matchAll(pattern)) {
    let key = match[1] ?? match[2] ?? match[3] ?? "";
    if (match[1] !== undefined) {
      try {
        key = JSON.parse(`"${key}"`) as string;
      } catch {
        // 无法解码时仍按字面键名检查。
      }
    }
    fields.push({ key, quoted: match[3] === undefined, end: match.index + match[0].length });
  }
  return fields;
}

// diagnostic === true 时所有键一律视为敏感。
// 含 userinfo 或密码即敏感。
// Slack webhook 主机整体敏感。
// 签名类查询参数同样敏感。
// 路径段按敏感名与动作名判断。
function shouldRedactUrlPath(url: URL, diagnostic: boolean): boolean {
  if (diagnostic || url.username || url.password || url.hostname === "hooks.slack.com") return true;
  // 签名下载的对象路径也可能是凭据；必须在删除 query 前判定。
  if (
    [...url.searchParams.keys()].some(
      (key) => shouldRedactKey(key, false) || /^(?:.*signature|sig|code)$/i.test(normalizeKey(key)),
    )
  )
    return true;
  try {
    return decodeURIComponent(url.pathname)
      .split("/")
      .some((segment) => {
        const normalized = normalizeKey(segment);
        return (
          sensitiveKey.test(normalized) ||
          /^(?:webhook\w*|(?:password)?reset(?:password)?|invites?|invitations?|callback|downloads?|signed|verify|verification|activate|magiclink)$/.test(
            normalized.toLowerCase(),
          )
        );
      });
  } catch {
    // 无法解码的路径不能证明安全，避免编码形式绕过识别。
    return true;
  }
}

// Authorization 头优先整体替换，避免只抹掉令牌值。
// 私钥块用跨行正则匹配 BEGIN/END 整段。
// Bearer 令牌保留前缀。
// key=value 键值对按原分隔符保留结构，只替换值。
// URL 的路径、查询与片段清空。
function redactValues(text: string, diagnostic: boolean): string {
  let result = text
    .replace(/\b((?:Proxy-)?Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`)
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
      REDACTED,
    )
    .replace(/\bBearer\s+[^\s"'\\,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /([\w.-]+)(\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;"'<>]+)/g,
      (match, key: string, separator: string) =>
        shouldRedactKey(key, false) ? `${key}${separator}${REDACTED}` : match,
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        // URL 凭据并不只在 userinfo/query 中，webhook 和重置链接常将秘密放在路径里。
        if (shouldRedactUrlPath(url, diagnostic) && url.pathname && url.pathname !== "/") {
          url.pathname = `/${REDACTED}`;
        }
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return REDACTED;
      }
    })
    .replace(/(?:\/(?:Users|home)\/|[a-z]:\\Users\\)[^\s"'<>]+/gi, "[USER_PATH]");
  if (diagnostic) {
    result = result.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]");
  }
  return result;
}

// depth > 32 时直接返回 REDACTED，不再递归。
// 字符串统一回到 redactText 完整管道。
// 数组逐项递归 scrubValue，保持长度不变。
// 对象先由 shouldRedactKey 判定，再递归值。
function scrubValue(value: unknown, diagnostic: boolean, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (typeof value === "string") {
    // 字符串也可能包含日志前缀或多个 JSON 片段，必须走同一条完整脱敏路径。
    return redactText(value, diagnostic, depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, diagnostic, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shouldRedactKey(key, diagnostic) ? REDACTED : scrubValue(item, diagnostic, depth + 1),
      ]),
    );
  }
  return value;
}

function redactPlainText(text: string, diagnostic: boolean): string {
  return redactValues(text, diagnostic)
    .split(/\r?\n/)
    .map((line) => {
      // 非结构化正文的长度和换行边界不可靠；已知敏感字段无法安全解析时舍弃该行。
      const unsafe = fieldKeys(line).some(
        ({ key, quoted, end }) =>
          shouldRedactKey(key, diagnostic) &&
          (quoted || diagnostic || !line.slice(end).startsWith(REDACTED)),
      );
      return unsafe ? REDACTED : line;
    })
    .join("\n");
}

function jsonFragmentEnd(text: string, start: number): number {
  let nesting = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") nesting += 1;
    else if ((character === "}" || character === "]") && --nesting === 0) return index + 1;
  }
  return text.length;
}

function redactText(text: string, diagnostic: boolean, depth: number): string {
  if (depth > 32) return REDACTED;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(scrubValue(parsed, diagnostic, depth + 1));
    }
  } catch {
    // 混合日志继续逐片段处理，不能只清洗可解析的最后一个 JSON。
  }
  // 私钥和普通凭据可能跨行或含括号，先按整体清洗，避免片段切分后残留值的后半段。
  const source = redactValues(text, diagnostic);
  const chunks: string[] = [];
  let cursor = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith(REDACTED, index)) {
      index += REDACTED.length - 1;
      continue;
    }
    if (source[index] !== "{" && source[index] !== "[") continue;
    const prefix = source.slice(cursor, index);
    let end = jsonFragmentEnd(source, index);
    const linePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
    const sensitiveValue = fieldKeys(linePrefix).some(({ key }) =>
      shouldRedactKey(key, diagnostic),
    );
    if (sensitiveValue) {
      // 普通字段值可能由文本和对象混合组成；不能只删对象而留下同行尾部。
      const lineEnd = source.indexOf("\n", end);
      end = lineEnd < 0 ? source.length : lineEnd;
    }
    const fragment = source.slice(index, end);
    chunks.push(redactPlainText(prefix, diagnostic));
    try {
      chunks.push(
        sensitiveValue
          ? REDACTED
          : JSON.stringify(scrubValue(JSON.parse(fragment), diagnostic, depth + 1)),
      );
    } catch {
      // 多行或截断对象不能只丢弃键名所在行，否则下一行的值仍会泄露。
      chunks.push(
        sensitiveValue || fieldKeys(fragment).some(({ key }) => shouldRedactKey(key, diagnostic))
          ? REDACTED
          : redactPlainText(fragment, diagnostic),
      );
    }
    cursor = end;
    index = end - 1;
  }
  chunks.push(redactPlainText(source.slice(cursor), diagnostic));
  return chunks.join("");
}

// redactFeedbackText 的 diagnostic 缺省为 false。
// 深度从 0 开始。
// 其余逻辑全部复用 redactText，不另写一份。
// 返回值为脱敏后的新字符串。
export function redactFeedbackText(text: string, options: { diagnostic?: boolean } = {}): string {
  return redactText(text, options.diagnostic === true, 0);
}
