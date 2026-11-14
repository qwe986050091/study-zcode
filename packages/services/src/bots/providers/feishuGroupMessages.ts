import { channelContentText, type ChannelContentPart } from "@zcode/shared";
// 本文件是飞书群消息的纯解析层：只做「协议字段 -> 统一内容片段」的翻译，不发请求、不读写状态。
// INV-01：解析结果不能提升权限。这里产出的 mention 身份只用于渲染与定位，是否允许执行命令
//   由 botsService 依据可信 sender/message id 判定；正文里出现 "@bot" 字样不算被提及。
// INV-03：去重键由调用方从飞书 message_id 取，本文件不生成也不伪造成任何 id。
// INV-06：卡片正文只抽取可见文本，按钮结构与 value 不进入消息内容，避免把交互参数当成发言。
// 安全口径：所有身份判定只认 open_id（ou_ 前缀）等结构化字段，显示名永远不可信。
function record(value: unknown): Record<string, unknown> | null {
  // 数组也满足 typeof === "object"，这里刻意不做排除：调用方会自行判断 Array.isArray。
  // 返回 null 而不是抛错，是因为所有输入都来自远端 JSON，形状异常属于常态而非缺陷。
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// 接收事件用 bot，历史接口用 app；此前混用导致真实机器人事件在入口被丢弃。
// [权衡] 两种 senderType 都视为机器人而不做细分：历史接口没有更精确的类型字段，
// 细化只会引入一个无法验证的映射表；代价是「应用/机器人」的区分在此层丢失。
export function isFeishuBotSender(senderType: string): boolean {
  return senderType === "bot" || senderType === "app";
}

// 群消息解析的唯一入口：把「正文 + mentions」还原成消息正文与命令副本。
// 输入口径：text 是飞书事件里的原始文本（含 @_user_N 占位符），mentions 是同一事件的 mentions 数组，
//   botOpenId 是本应用在该租户下的 open_id，senderType/senderOpenId 是发送端的可信身份。
// 返回 null 表示「这条消息不该被处理」（身份缺失、跨 bot 回声、非用户/机器人发送者），
//   与「返回空文本」严格区分：后者是合法消息但内容为空，仍可能需要回复。
// 副作用：无。所有过滤都在本地完成，调用方拿到的 null 不需要记录为错误（INV-01）。
/** 只接受真实 mention 身份，不能靠显示名或正文中的 @ 字样触发执行。 */
export function readGroupMessage(
  text: string,
  mentions: unknown,
  botOpenId: string,
  senderType: string,
  senderOpenId?: string,
): {
  text: string;
  commandText: string;
  mentionedBot: boolean;
  contentParts?: ChannelContentPart[];
} | null {
  // 机器人可参与已接入话题，但自身回声必须按可信 ID 过滤，不能使用显示名。
  // botOpenId 为空时无法区分「@我」和「@别人」，此时整体拒绝（fail-closed）：
  // 猜错会把别人的消息当成命令执行，代价远高于少处理一条消息。
  if (!botOpenId || (senderType !== "user" && !isFeishuBotSender(senderType))) return null;
  // 回声过滤：机器人发送的消息只有在能证明「不是自己」时才放行。
  // senderOpenId 缺失同样拒绝——没有可信 id 就没有证明，这与 INV-01 的 fail-closed 一致。
  // [权衡] 若改成只比较 senderOpenId === botOpenId，缺失 id 的机器人消息会被放行，
  // 形成「自己回复自己」的无限循环，且循环里每条消息都带 mention，很难自动收敛。
  if (isFeishuBotSender(senderType) && (!senderOpenId || senderOpenId === botOpenId)) return null;
  // mentioned 只由「结构化 mention 的 open_id 命中 botOpenId」置真，正文 substring 不参与判定。
  let mentioned = false;
  // tokens 是「占位符 -> 内容片段」的映射，供下面的分词循环替换。
  // key 是飞书生成的 @_user_N 形式，可能与正文中出现的顺序不一致，因此必须按 key 查表。
  const tokens = new Map<string, ChannelContentPart>();
  for (const item of Array.isArray(mentions) ? mentions : []) {
    const mention = record(item);
    // 身份只在有 open_id 时可信；id 可能是对象/字符串/缺失，统一收窄成 record 再取字段。
    const id = record(mention?.id)?.open_id;
    const key = mention?.key;
    // 没有占位符 key 的 mention 无法在正文中定位，直接跳过：强行按名字替换会误伤正文里的同名文本。
    if (typeof key !== "string" || !key) continue;
    if (id === botOpenId) mentioned = true;
    // 只有「有显示名」或「命中 bot」的 mention 才建 token；其余保留原文，避免把未知身份伪造成实体。
    if (typeof mention?.name === "string" || id === botOpenId) {
      // open_id 必须通过 ou_ 前缀 + 字符集校验才视为可信身份；
      // 否则（id 缺失、格式异常）降级成普通文本 "@名字"，既不产生实体引用，也不会被下游当作权限依据。
      if (typeof id === "string" && /^ou_[a-zA-Z0-9_-]+$/u.test(id))
        tokens.set(key, {
          type: "channelMention",
          // refId 在本次解析内单调递增（m1、m2…），仅用于正文中的稳定引用，不是 provider id（INV-03）。
          refId: `m${tokens.size + 1}`,
          targetId: id,
          idType: "open_id",
          channel: "feishu",
          // entityType 恒为 unknown：本层不知道对方是人还是机器人，猜测会让 UI 画错头像与权限提示。
          entityType: "unknown",
          // 显示名缺失时回退到 open_id，保证 UI 至少能区分不同实体，而不是统一显示 "@"。
          name: typeof mention?.name === "string" && mention.name.trim() ? mention.name : id,
        });
      else tokens.set(key, { type: "text", text: `@${mention.name}` });
    }
  }
  // 先 trim 全文：飞书正文常带首尾空白，不先裁掉会让首段的 index 计算与后续 trimStart 重复处理。
  text = text.trim();
  const contentParts: ChannelContentPart[] = [];
  // 分词循环：每轮找出「最靠前的占位符」并切一段文本，复杂度 O(占位符数 × 剩余长度)。
  // [权衡] 不用一次性正则替换：占位符数量个位数，正则反而要处理转义与重叠匹配；
  // 但这里每轮都重建 map+sort，占位符很多时是平方级——当前消息规模下可接受。
  while (text) {
    // 同位置命中多个 key 时取更长的那个：@_user_1 是 @_user_10 的前缀，短 key 先匹配会把 10 切成 1 + "0"。
    // 排序稳定（sort 在 V8 上稳定），因此长度相同时保持插入顺序，结果是确定的。
    const next = [...tokens.keys()]
      .map((key) => ({ key, index: text.indexOf(key) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index || b.key.length - a.key.length)[0];
    // 没有任何占位符命中：剩余全部是纯文本，push 后结束循环。
    if (!next) {
      contentParts.push({ type: "text", text });
      break;
    }
    // index 为 0 时跳过空文本片段，避免 contentParts 里出现空串影响下游 join 与首段裁剪。
    if (next.index) contentParts.push({ type: "text", text: text.slice(0, next.index) });
    // [失败路径] tokens.get 一定命中：next.key 取自 tokens.keys() 的同一集合，非空断言不会失败。
    contentParts.push(tokens.get(next.key)!);
    text = text.slice(next.index + next.key.length);
  }
  // 首尾裁剪：占位符替换后两端可能残留空白文本片段，先 trimStart 再丢弃空片段。
  // 只在「仍是 text」时裁剪：channelMention 的 name 不能被改动，否则会改到用户可见的实体名。
  while (contentParts[0]?.type === "text") {
    contentParts[0].text = contentParts[0].text.trimStart();
    if (contentParts[0].text) break;
    contentParts.shift();
  }
  while (contentParts.at(-1)?.type === "text") {
    const last = contentParts.at(-1)!;
    // 上面的循环条件已收窄 type，这里再判一次是为了让 TS 在赋值前确认 last 是 text 片段。
    if (last.type !== "text") break;
    last.text = last.text.trimEnd();
    if (last.text) break;
    contentParts.pop();
  }
  // 自身 @ 是分工原文的一部分；只有命令副本可以剥离开头的唤醒标记。
  // commandStart 只跳过「开头连续的空白文本 + 指向本 bot 的 mention」，遇到第一个实体内容立刻停止：
  // 把中段的 @ 也剥掉会让「@A 请转告 @bot 去做」这类文本丢失真正的收件人。
  let commandStart = 0;
  while (commandStart < contentParts.length) {
    const part = contentParts[commandStart]!;
    if (
      (part.type === "text" && !part.text.trim()) ||
      (part.type === "channelMention" && part.targetId === botOpenId)
    )
      commandStart++;
    else break;
  }
  return {
    // text 保留完整正文（含 @bot），用于展示与引用回复的原始语境。
    text: channelContentText(contentParts),
    // commandText 是去掉唤醒前缀后的命令副本，供命令解析使用；再 trim 一次防止 "@bot    /help" 留下前导空格。
    commandText: channelContentText(contentParts.slice(commandStart)).trim(),
    mentionedBot: mentioned,
    // 只有在确实产出过实体引用时才附带 contentParts：纯文本消息不必让上层多处理一个字段。
    ...(contentParts.some((part) => part.type === "channelMention") ? { contentParts } : {}),
  };
}

// 只要「被 @ 到的正文」，用于引用准备等只需要文本的场景。
// 返回 null 同时覆盖「不该处理的消息」与「没 @ 本 bot」两种情况：调用方在该处都无需继续。
// [失败路径] 必须把 senderOpenId 透传下去，否则 readGroupMessage 会把合法机器人发送者当成身份缺失而拒绝。
export function readGroupMentionText(
  text: string,
  mentions: unknown,
  botOpenId: string,
  senderType: string,
  senderOpenId?: string,
): string | null {
  // 引用准备也必须透传发送者身份，否则合法机器人被当作缺失身份过滤。
  const message = readGroupMessage(text, mentions, botOpenId, senderType, senderOpenId);
  return message?.mentionedBot ? message.text : null;
}

/** 只取卡片可见正文，不把按钮值和审批参数作为另一机器人的发言。 */
// 卡片 JSON -> 可见文本。递归策略是「白名单下钻」：只沿 elements/body/header/title/text/content 走。
// 白名单本身就是安全边界：button.value、action 参数、审批表单字段都不在这些 key 上，
// 因此不会被拼进正文（对齐 INV-11 的「value 只作路由」）。
// 输出用换行连接且过滤空串，保持卡片视觉上的分行语义；不做 HTML 转义，渲染方负责。
export function readGroupCardText(value: unknown): string {
  // 数组逐项递归后连接：卡片里同一容器常以数组表达多个元素，保持原顺序。
  if (Array.isArray(value)) return value.map(readGroupCardText).filter(Boolean).join("\n");
  const item = record(value);
  // 非对象（字符串/数字/null）一律视为空：字符串只有在作为白名单 key 的取值时才被接受。
  if (!item) return "";
  const lines: string[] = [];
  for (const key of ["elements", "body", "header", "title", "text", "content"]) {
    const child = item[key];
    // 只有 text/content 允许是字符串；title/header 等若为字符串说明结构异常，递归会返回空，避免误读。
    if (typeof child === "string" && (key === "text" || key === "content")) lines.push(child);
    else if (typeof child === "object") lines.push(readGroupCardText(child));
  }
  return lines.filter(Boolean).join("\n");
}

/** interactive 也是普通回复载体；只根据控件结构识别操作卡片，不能按消息类型全拦。 */
// [边界] isGroupControlCard 只认控件结构（button/form/select）而不看消息类型：interactive 既可能是操作卡，也可能是普通回复载体。
// 递归遍历所有嵌套值来找控件 tag；一旦命中即返回 true，因此大卡片会在第一个控件处短路。
// 用途是分流：操作卡片走回调处理，普通 interactive 卡片仍按正文进入消息链路。
export function isGroupControlCard(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isGroupControlCard);
  const item = record(value);
  if (!item) return false;
  const tag = typeof item.tag === "string" ? item.tag : "";
  // tag 白名单用正则而非 Set：飞书会派生 select_static、multi_select_person 等带后缀的 tag，
  // 精确匹配会漏判，把操作卡片送进普通消息链路，用户点按钮后没有任何响应。
  if (
    /^(?:button|action|form|input|select(?:_.*)?|multi_select(?:_.*)?|date_picker|time_picker|datetime_picker|picker|checker|overflow)$/u.test(
      tag,
    )
  )
    return true;
  // 跳过 value 子树：按钮的 value 里可能带任意 JSON（含形似控件的 tag 字段），
  // 递归进去会把普通卡片误判成操作卡片，从而吞掉正常回复。
  return Object.entries(item).some(([key, child]) => key !== "value" && isGroupControlCard(child));
}

/** 卡片正文中的发送端 ID 可能与接收端不同，使用平台有序 mentions 恢复本端身份。 */
// 会话卡片里的 <at id="ou_xxx">名字</at> 是「发送端视角」的标记，接收端拿到的 id 可能不可解析；
// 本函数把它们替换成 mentions 里的占位符 key（如 @_user_1），交给 readGroupMessage 统一还原。
// 无匹配时输出 "@unknown"：宁可显示未知实体，也不把可能是外部 id 的原文直接透出。
export function readGroupConversationCardText(value: unknown, mentions: unknown): string {
  const text = readGroupCardText(value);
  // native 只保留 key 为字符串的 mention，顺序即平台顺序，是下面按位兜底的唯一依据。
  const native = Array.isArray(mentions)
    ? mentions.map(record).filter((item) => typeof item?.key === "string")
    : [];
  // 先数一遍节点数：只有「节点数 == mention 数」才允许按位兜底，否则按位对应会把身份错位。
  const nodes = [...text.matchAll(/<at\s+id=["']?([^\s>"']+)["']?[^>]*>[\s\S]*?<\/at>/gu)];
  let index = 0;
  // 替换分两级：优先按 open_id 精确匹配；精确匹配失败且数量一致时才用同位置的 mention 兜底。
  // [权衡] 兜底分支会在「某些 at 节点不属于 mentions」时给出错误身份，但相比整段丢弃，
  // 至少保留了「这里有一个实体」的结构；调用方仍只把 targetId 当展示用，不影响权限（INV-01）。
  return text.replace(
    /<at\s+id=["']?([^\s>"']+)["']?[^>]*>[\s\S]*?<\/at>/gu,
    (_node, id: string) => {
      const mention =
        native.find((item) => record(item?.id)?.open_id === id) ??
        (native.length === nodes.length ? native[index] : undefined);
      // index 无条件自增：它对应「第几个 at 节点」，即使本次走的是精确匹配也要推进，否则后续兜底会错位。
      index++;
      return typeof mention?.key === "string" ? mention.key : "@unknown";
    },
  );
}
