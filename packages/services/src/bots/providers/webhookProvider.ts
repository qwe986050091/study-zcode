import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  BotStructuredElicitationResponse,
  SelectionPrompt,
} from "@zcode/shared";
import type { BotProviderAdapter } from "./types.js";
// 文件职责：通用 webhook 渠道适配器。两个方向都要实现：
//   出站：BotOutboundMessage -> JSON POST 到 bot.webhookUrl（可选共享 secret 头）；
//   入站：HTTP 回调 JSON -> BotInboundMessage（含附件与 elicitation 结构化应答）。
// 维护/依赖的不变量：
// INV-01：本文件只做字段翻译，不做授权判断；userId/chatType 只取 payload 明面字段。
// INV-02：出站非 2xx 一律抛错，不把"请求已发出"当成"已投递"。
// INV-03：providerMessageId 依次取 messageId / id，缺失则留空（fail-open），不伪造。
// INV-05：入站共享 secret 由 server 路由从 x-zcode-bot-secret 头提取、由 botsService 比对；
//   本文件既不读请求头也不校验，只做 payload 字段翻译——状态所有者只有一处。
// INV-09：filename 直接来自入站 payload，本文件必须不拼路径、不落盘。
// INV-10：仅对 5xx/网络错误做有限重试（0/500/1500ms），4xx 立即返回交给上层。

// 只注入凭据读取能力：适配器拿不到凭据列表，也没有写入通道（INV-08）。
interface WebhookProviderDeps {
  loadCredential(key: string): Promise<string | null>;
}

// 入站 payload 是外部任意 JSON，读取任何字段前先过类型闸门，
// 否则 null/数组会被当作对象索引而抛出 TypeError，整条回调变成 500。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 为纯文本渠道把 selection 降级成"人可手敲的命令行"。
// 口径：
// - permission.respond 直接回 optionId：权限选项是 runtime 生成的稳定短值，不需要前缀；
// - elicitation.respond 带 token 时输出 /elicitation <token> <optionId>，token 是问答会话的
//   作用域凭证，漏掉它会答到另一个请求上；
// - model.* 要保留 "provider "/"model " 二级子命令，否则 parser 会把值当成模型名；
// - 其余走通用的 /<action> <optionId>，replace(".set","") 只会去掉后缀，不改变语义。
// [权衡] 这里生成的是用户可见文本，选项 id 会出现在聊天记录里；换来的是无需按钮也能作答。
// optionId 来自 SelectionPrompt，只是展示/回填用的值；能执行什么仍由 botsService 按
// 当前 pending 列表和调用者身份判定，文本里出现 id 不等于获得该操作权限（INV-11）。
function formatSelectionCommand(
  selection: SelectionPrompt,
  optionId: string,
): string {
  // 权限应答直接回 optionId：runtime 生成的权限选项就是短 id，多套一层命令会让对端无法解析。
  if (selection.action === "permission.respond") {
    return optionId;
  }
  if (selection.action === "elicitation.respond") {
    // token 是问答会话的作用域凭证，必须紧跟在子命令后；漏传会让这条答复落到另一个待答请求上。
    return selection.token ? `/elicitation ${selection.token} ${optionId}` : `/elicitation ${optionId}`;
  }
  if (selection.action === "model.provider.set") {
    // provider 与 model 两个子命令同名不同义，这里少写一层会让 parser 把 provider id 当成模型名处理。
    return `/model provider ${optionId}`;
  }
  if (selection.action === "model.set") {
    return `/model model ${optionId}`;
  }
  // 兜底分支只剥掉 .set 后缀：后缀是内部动作命名习惯，用户可敲的命令里不该出现。
  return `/${selection.action.replace(".set", "")} ${optionId}`;
}

// 出站正文拼装：text 加上每个选项的"序号. 标签 - 描述"以及可直接复制的命令。
// 序号从 1 开始，与 permission/task 等按序号回填的解析保持同一口径；
// 用户按序号回复时，上层用"当前 pending 列表的第 N 项"定位，因此这里的顺序必须与
// selection.options 完全一致；一旦重排或过滤，序号会指到别的选项。
// 没有按钮的渠道只能靠这行文本作答，因此即使 selection 为空也原样返回 text，
// 绝不在 selection 为空时追加空行或占位符。
function buildSelectionText(message: BotOutboundMessage): string {
  if (!message.selection) {
    return message.text;
  }
  const selection = message.selection;
  // 序号由 map 的 index 决定而不是 option.id，因此上游若过滤过 options，这里的序号就会与 pending 列表错位。
  const lines = selection.options.map((option, index) => {
    const description = option.description ? ` - ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}\n${formatSelectionCommand(selection, option.id)}`;
  });
  // 正文与选项之间只插一个换行：多一行空行会让微信等客户端把首条选项隔离成引用块。
  return `${message.text}\n${lines.join("\n")}`;
}

// 重试退避用 delay 最小实现：只有本文件使用，不需要可取消语义——
// 调用方是 test/send 的一次性请求，取消由外层的整体超时兜底。
// 定时器不 unref：退避最长 1.5s，进程退出时由 Node 自行回收，不值得引入额外句柄管理。
function delay(ms: number): Promise<void> {
  // 用裸 setTimeout 而不是可取消定时器：本文件只在 send/test 的短退避里用，最长 1.5s，没有取消需求。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 入站附件解析。与其它 provider 的"解析失败返回 null 并过滤"不同，这里尽量补默认值，
// 因为 webhook 的 payload 由接入方自行构造，字段缺失是常态而不是异常：
// - kind 白名单外直接丢弃：未知类型无法决定下游如何处理，硬塞成 file 会误导用户；
// - id 缺失时用 webhook-<序号> 合成：它只用于同一条消息内区分附件，不能参与去重，
//   因此不会伪造平台幂等键（INV-03 针对的是 message id，不是附件 id）；
// - filename 缺失时用 <id>.<kind>，保证下游有可展示的名字，真实净化在落盘时做（INV-09）；
// - downloadUrl/dataBase64/localPath 三选一透传，适配器不替上层选择取字节的方式。
// 这里不对 downloadUrl 做协议/域名白名单校验：真正发起请求的是 botsService 的解析路径，
// HTTP 状态、大小上限和超时的判定都由那一侧负责（INV-04），本文件只搬运字段。
function parseWebhookAttachment(
  value: unknown,
  index: number,
): BotInboundAttachment | null {
  // 外部 payload 的 attachments 元素可能是 null 或字符串，直接读 value.kind 会抛 TypeError 并让整条回调 500。
  if (!isRecord(value)) {
    return null;
  }
  // kind 直接取原始值且不做 trim/小写：白名单是精确字面量，宽松化会让 image2 之类混进来。
  const kind = value.kind;
  if (
    kind !== "image" &&
    kind !== "audio" &&
    kind !== "video" &&
    kind !== "file"
  ) {
    return null;
  }
  // 只有非空字符串才当作 id；空白串会被下游当成无效键，合成 webhook-<序号> 更安全。
  const id =
    typeof value.id === "string" && value.id.trim()
      ? value.id
      : `webhook-${index + 1}`;
  // 文件名缺失时退回 <id>.<kind>，保证落盘层能推断扩展名；真实路径净化仍由落盘侧负责（INV-09）。
  const filename =
    typeof value.filename === "string" && value.filename.trim()
      ? value.filename
      : `${id}.${kind}`;
  // 缺 mimeType 时给 application/octet-stream，而不是按扩展名猜；猜错会让下游预览器拒绝打开。
  const mimeType =
    typeof value.mimeType === "string" && value.mimeType.trim()
      ? value.mimeType
      : "application/octet-stream";
  return {
    id,
    // id/kind/filename/mimeType 四项无条件写入，它们是 BotInboundAttachment 的必填字段。
    kind,
    filename,
    mimeType,
    // sizeBytes 只在类型为 number 时写入；字符串大小会让下游预算判断参与字符串比较而失真。
    ...(typeof value.sizeBytes === "number"
      ? { sizeBytes: value.sizeBytes }
      : {}),
    ...(typeof value.providerFileId === "string"
      ? { providerFileId: value.providerFileId }
      : {}),
    ...(typeof value.downloadUrl === "string"
      ? { downloadUrl: value.downloadUrl }
      : {}),
    ...(typeof value.dataBase64 === "string"
      ? { dataBase64: value.dataBase64 }
      : {}),
    // localPath 由接入方在本地部署时给出，适配层不校验路径存在性，越权访问防护在读取侧。
    ...(typeof value.localPath === "string"
      ? { localPath: value.localPath }
      : {}),
  };
}

// attachments 非数组按空处理而不是报错：多数 webhook 事件不带附件，
// 把"字段缺失"与"格式错误"都归为空，纯文本回调才不会因附件字段失败。
// 逐项过滤 null 会压缩下标，但附件在消息内只按顺序展示，不承担寻址职责。
// 若将来需要"回复第 N 个附件"，必须先改为保留占位，不能直接复用当前下标语义。
function parseWebhookAttachments(
  payload: Record<string, unknown>,
): BotInboundAttachment[] {
  // attachments 非数组一律当空：纯文本回调不带附件是常态，把缺字段当格式错误会拒掉所有普通消息。
  return Array.isArray(payload.attachments)
    ? payload.attachments
        // 下标在 filter 之前就已确定，后面压缩数组不会改变 id 里 webhook-<序号> 与原始 payload 的对应关系。
        .map((attachment, index) => parseWebhookAttachment(attachment, index))
        .filter(
          (attachment): attachment is BotInboundAttachment =>
            attachment !== null,
        )
    : [];
}

// 结构化问答应答（Accept/Decline/Cancel）走独立事件类型，必须按 type 精确匹配：
// 普通消息也可能带 action 字段，若不看 type 就会把用户文字误判成"接受了某个请求"。
// requestId 与 action 都是必填且取值受白名单约束，任一不合法返回 undefined，
// 由上层把这条 payload 当作普通消息（或直接丢弃），不做"猜测式"修复。
// content 只在是对象时透传，保留 runtime 需要的原始答案结构。
// 这里不校验 content 的内容形状：答案字段由具体 question schema 决定，
// 适配层没有 schema 上下文，越权校验会让合法的自定义问答被误拒。
function parseWebhookElicitationResponse(
  payload: Record<string, unknown>,
): BotStructuredElicitationResponse | undefined {
  // 必须按 type 精确匹配：普通消息也可能带 action 字段，不看类型就会把用户文字误判成接受请求。
  if (payload.type !== "zcode.bot.elicitation_response") {
    return undefined;
  }
  const requestId =
    typeof payload.requestId === "string" && payload.requestId.trim()
      ? payload.requestId
      : "";
  // action 保持原始类型再进白名单比较；先转 String 会让对象意外变成 "[object Object]" 之类的命中值。
  const action = payload.action;
  if (
    !requestId ||
    // action 白名单之外一律返回 undefined，不做大小写纠正或同义词映射，避免猜错用户真实意图。
    (action !== "accept" && action !== "decline" && action !== "cancel")
  ) {
    return undefined;
  }
  return {
    requestId,
    action,
    // content 只在是对象时透传：具体答案形状由 question schema 决定，适配层没有上下文可校验。
    ...(isRecord(payload.content) ? { content: payload.content } : {}),
  };
}

// 出站请求的统一重试。判据：
// - 2xx 直接成功返回；
// - 4xx 立即返回（不重试）：鉴权/参数错误重试必然再失败，还会放大对端日志与限流；
// - 5xx 与网络异常进入下一轮，共 3 次 retry（0/500/1500ms 递增退避）。
// [权衡] 5xx 重试对非幂等下游可能造成重复投递；这里接受该风险，
// 因为 webhook 约定接收方需按 providerMessageId/sentAt 自行去重。
// 三轮都失败时：有 lastResponse 就返回最后一个响应（让调用方读到状态码），
// 否则抛出最后一次异常；lastError 非 Error 时包装成 Error，保证返回类型稳定（INV-10）。
// 同一个 init/body 被重复使用是合法的：body 已是字符串，fetch 每次重新读取不会消费流。
// [失败路径] 没有整体超时：若对端接受连接后永不返回，fetch 会一直挂到系统超时；
// 当前调用方（test/send）本身处于 Bot 串行队列中，这个缺口会让后续消息排队等待。
async function postWebhookWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  // 三轮固定退避：数组长度就是总尝试次数，改成 push 动态长度会让重试次数不可预测。
  for (const retryDelayMs of [0, 500, 1_500]) {
    // 首轮延迟为 0 直接发；若统一先等 500ms，test 探测会平白多出半秒。
    if (retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    try {
      const response = await fetch(url, init);
      // 4xx 立即返回不重试：鉴权或参数错误再发必然同样失败，只会放大对端限流。
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      // 只记 5xx 响应；若把 4xx 也记下，循环结束会返回一个已经明确失败的响应而不是重试结果。
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }
  // 有响应就返回最后一个 5xx，让调用方读到状态码；否则只能抛出原始异常，丢失 HTTP 信息。
  if (lastResponse) {
    return lastResponse;
  }
  // 网络异常可能是字符串或 DOMException，统一包装成 Error，保证返回类型稳定。
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// 工厂只捕获 loadCredential，必须保持无模块级状态：同一 bot 的并发调用互不影响，
// 也不存在需要释放的连接/定时器（INV-12）。
export function createWebhookBotProvider(
  deps: WebhookProviderDeps,
): BotProviderAdapter {
  return {
    // 配置自检。四种结论：
    // - 未启用 -> 直接不可用（不探测远端，避免停用后仍在发测试请求）；
    // - 缺 secret -> 拒绝，因为对外暴露回调端点却没有校验等于开放写入口（INV-05）；
    // - 配了 webhookUrl -> 发一条 zcode.bot.test 探测，2xx 才算可达（非 2xx 文案带状态码）；
    // - 只有入站 -> 视为 inbound-only 可用（出站不是必需能力）。
    // 探测请求也会带 secret 头，使用的是配置里的自定义头名，缺省 x-zcode-bot-secret。
    // secret 为 null 时仍写入空串而不是省略头：让对端稳定看到"鉴权头存在但为空"，
    // 比时有时无的 header 更容易在接入方日志里定位配置问题。
    async test(bot: BotConfig) {
      // 停用的 bot 直接判不可用：继续发测试请求会让用户以为关闭没生效。
      if (!bot.enabled) {
        return { ok: false, message: "Webhook bot is disabled." };
      }
      // 没有 secret 就拒绝：对外暴露回调端点却不校验，等于给任何知道 URL 的人开写入通道（INV-05）。
      if (!bot.webhookSecretRef) {
        return {
          ok: false,
          message:
            "Webhook secret is missing. Configure a secret before exposing the callback endpoint.",
        };
      }
      if (bot.webhookUrl) {
        // 现读现用不缓存：换绑 secret 后下一次 test 立即生效，缓存会让旧凭证一直可用。
        const secret = await deps.loadCredential(bot.webhookSecretRef);
        const response = await postWebhookWithRetry(bot.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // secret 为 null 时仍写空串：让对端稳定看到鉴权头存在但为空，便于在接入方日志里定位配置问题。
            [bot.webhookAuthHeaderName || "x-zcode-bot-secret"]: secret ?? "",
          },
          // 探测报文带 sentAt 与 botId，对端可据此在日志里区分探测流量与真实消息，避免误触发业务。
          body: JSON.stringify({
            // 固定事件名 zcode.bot.test，对端应按它返回 2xx 且不落地任何内容。
            type: "zcode.bot.test",
            botId: bot.id,
            provider: "webhook",
            sentAt: Date.now(),
          }),
        });
        return {
          // ok 直接取 HTTP 结果而非猜测：非 2xx 时把状态码拼进 message，调用方能一眼看出 401 还是 500。
          ok: response.ok,
          message: response.ok
            ? "Webhook outbound endpoint is reachable."
            : `Webhook outbound endpoint returned HTTP ${response.status}.`,
        };
      }
      return {
        ok: true,
        message: "Webhook bot is enabled for inbound callbacks.",
      };
    },

    // 出站发送。未配置 webhookUrl 视为"只收入站"，静默返回而不是抛错：
    // 这是合法配置形态，抛错会让上层把每条回复都记成投递失败。
    // 请求体字段口径：
    // - text 已把选择项渲染成可手敲命令（buildSelectionText），对端无需理解 SelectionPrompt；
    // - selection 仍原样附带，供对端想做原生按钮时使用；
    // - elicitation 存在时先展开再覆盖 type 为 elicitation_request，
    //   因为对象展开在前、覆盖在后，最终 type 一定是请求类型而不是 message；
    // - sentAt 会用本机时间，仅作展示/去重辅助，不作为幂等键。
    // 非 2xx 抛错（含 4xx），由上层决定是否重试或落 failed（INV-02/INV-10）。
    // secret 为空时省略鉴权头（与 test 不同）：正常发送不能带一个空凭证去冒充已认证，
    // 对端若要求鉴权会返回 401，这条错误会如实冒泡，而不会被本地静默吞掉。
    async send(bot, message) {
      // 未配 webhookUrl 表示只收入站，静默返回：抛错会让上层把每条回复都记成投递失败。
      if (!bot.webhookUrl) {
        return;
      }
      const secret = bot.webhookSecretRef
        ? await deps.loadCredential(bot.webhookSecretRef)
        : null;
      // 先固定 content-type 再按需追加鉴权头；用可变对象是因为头名由 bot 配置决定，无法写进字面量。
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      // secret 为空时省略鉴权头（与 test 相反）：正常发送不能带空凭证冒充已认证，401 应如实冒泡。
      if (secret) {
        headers[bot.webhookAuthHeaderName || "x-zcode-bot-secret"] = secret;
      }
      const response = await postWebhookWithRetry(bot.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          // 出站事件名与入站 elicitation_response 分属不同命名空间，混用会让对端把普通回复当结构化应答。
          type: "zcode.bot.message",
          botId: bot.id,
          provider: "webhook",
          userId: message.providerUserId,
          // text 已把 selection 渲染成可手敲命令，对端即使用纯文本客户端也能作答。
          text: buildSelectionText(message),
          selection: message.selection,
          elicitation: message.elicitation,
          // 展开在前、覆盖在后：对象字面量里后面的 type 一定覆盖前面的 zcode.bot.message，最终发的是请求类型。
          ...(message.elicitation
            ? { type: "zcode.bot.elicitation_request" }
            : {}),
          sentAt: Date.now(),
        }),
      });
      // 2xx 只代表对端接收了这次 POST，不代表用户已读或业务已处理；
      // 上层不得据此写出“已送达”终态，否则对端稍后失败时无法回退。
      // 4xx 也在这里抛错：发送路径没有本地降级，投递失败必须让上层落 failed 并展示给用户（INV-02）。
      if (!response.ok) {
        throw new Error(
          `Webhook outbound endpoint returned HTTP ${response.status}`,
        );
      }
    },

    // 入站解析。丢弃条件必须三条同时成立才放行失败，尽可能不丢用户内容：
    // 缺 botId（无法归属配置，INV-01 不允许猜）或缺 userId（无法定位身份）都会导致整条回调被丢弃，
    // 且 text/attachments/elicitationResponse 全为空（没有可处理的内容）。
    // 注意 elicitationResponse 能让空正文消息通过：结构化应答本身就是一次有效交互。
    // chatType 只认 "group"，其余一律 private——webhook 没有平台侧可信会话类型，
    // 失败方向选择更保守的私聊语义，避免群专属能力被单聊回调误开。
    // providerMessageId 顺序为 messageId -> id，两者都没有时留空并 fail-open（INV-03）；
    // 上层用它做重试去重，所以绝不能在这里合成。
    // 一次回调固定产出 0 或 1 条消息：payload 没有批次语义，若对端把多条消息塞进
    // 一个数组，会在这里被整体丢弃而不是拆开，接入方需逐条投递。
    parseCallback(payload: unknown): BotInboundMessage[] {
      // 回调 payload 可能为 null 或数组；数组是 object，用它索引 botId 会拿到 undefined 而静默丢消息。
      if (!isRecord(payload)) {
        return [];
      }
      // botId 决定这条消息归属哪个 bot 配置，类型不符时留空并让整条回调被拒，绝不按 URL 猜归属（INV-01）。
      const botId = typeof payload.botId === "string" ? payload.botId : "";
      const text = typeof payload.text === "string" ? payload.text : "";
      const userId = typeof payload.userId === "string" ? payload.userId : "";
      // 先解析附件再判空：只有附件没有正文的图片消息也必须算有效内容。
      const attachments = parseWebhookAttachments(payload);
      // text 为空时只靠 elicitationResponse 也要放行，因此判空分支里两者是 OR 关系而不是 AND。
      const elicitationResponse = parseWebhookElicitationResponse(payload);
      // 三个条件任一缺失就返回空数组：缺 userId 无法做 ownership 判定，缺内容则没有可处理的输入。
      if (!botId || (!text && attachments.length === 0 && !elicitationResponse) || !userId) {
        return [];
      }
      return [
        {
          botId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(elicitationResponse ? { elicitationResponse } : {}),
          actor: {
            provider: "webhook",
            botId,
            providerUserId: userId,
            displayName:
              typeof payload.displayName === "string"
                ? payload.displayName
                : undefined,
            // 只认字面量 group，其余一律 private：webhook 没有平台侧可信会话类型，保守的私聊语义能避免误开群能力。
            chatType: payload.chatType === "group" ? "group" : "private",
            // chatId 只在字符串时透传，undefined 表示无会话分组；空串会被下游当成有效 id 并生成空目录。
            chatId:
              typeof payload.chatId === "string" ? payload.chatId : undefined,
            // Bugfix: webhook 回调也需要携带消息 id 进入通用幂等层。
            // 否则上游重试同一条消息时，Bot 会重复创建/发送任务。
            // messageId 优先、id 兜底，两者都缺时留 undefined：上层靠它做重试去重，此处合成等于伪造幂等键（INV-03）。
            providerMessageId:
              // 必须限定 string：数值 id 超过 2^53 时已丢精度，拿去比较会漏判重复。
              typeof payload.messageId === "string"
                ? payload.messageId
                : typeof payload.id === "string"
                  ? payload.id
                  : undefined,
          },
        },
      ];
    },
  };
}
