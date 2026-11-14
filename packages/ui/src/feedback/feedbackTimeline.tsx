// feedbackTimeline.tsx —— 工单详情页的时间线：事件与用户评论合并成一条按时间升序的记录流
// INV-01 记录流必须按发生时刻升序输出，排序后不得再按 kind 或 id 做二次调整；守住位置：getFeedbackTimelineItems 末尾的 sort；改错故障：最新进展沉到列表底部，用户认为工单长时间没有更新
// INV-02 排序键必须是 Date 解析出的毫秒数，禁止直接比 createdAt 字符串；守住位置：sort 的比较函数；改错故障：时区偏移不同的 ISO 串按字典序错排，跨时区用户看到乱序时间线
// INV-03 同一毫秒的记录必须保持入数组先后（事件在前、兜底评论在后），依赖 sort 的稳定性；守住位置：两段 push 的先后顺序；改错故障：同一秒产生的回复与状态变更互换位置，叙述前后矛盾
// INV-04 已作为事件呈现的评论不得再进兜底循环，判定只认 comment_id 集合；守住位置：eventCommentIds 的构建与第二段循环的 continue；改错故障：同一条回复在时间线上出现两次，用户怀疑消息被重复发送
// INV-05 每个 item 的 id 必须带 event- 或 reply- 前缀且全列表唯一；守住位置：两处 push 的 id 字段与 li 的 key；改错故障：编号空间重叠后 React 复用节点，附件与正文串到另一条记录上
// INV-06 事件的 type 取值域必须与 EVENT_ICON 的键完全一致，新增事件类型要同时补图标；守住位置：EVENT_ICON 常量与 item.type 的传值；改错故障：按 type 取到 undefined 后渲染抛错，整块时间线消失
// INV-07 圆点配色只由 isStaff、user_replied、reply 三个条件决定，不得另开基于其他字段的分支；守住位置：li 内圆点的 cn 条件组；改错故障：同一语义的事件出现两种颜色，用户无法凭颜色区分官方与本人
// INV-08 官方身份必须能同时从回复项的 isStaff 与事件的 staff_replied 类型推出，两条来源缺一不可；守住位置：isStaff 计算与正文卡片底色；改错故障：官方答复被渲染成用户补充样式，用户忽略关键回复
// INV-09 空时间线必须渲染占位段落，不得返回 null 或空的 ol；守住位置：items.length === 0 的提前返回；改错故障：详情页整块留白，用户以为页面加载失败
// INV-10 占位文案只走 feedback.timeline.empty 的 i18n key，禁止在本文件硬编码中文；守住位置：占位段落里的 formatMessage 调用；改错故障：非中文界面出现中文提示，与相邻文案语言不一致
// INV-11 正文必须保留作者原始换行，靠 whitespace-pre-wrap 实现，派生阶段不得 trim 或折叠空白；守住位置：正文段落的 className 与 body 赋值；改错故障：多段回复被压成一行，代码片段与列表失去结构
// INV-12 长文本只允许在容器内折行，禁止截断正文或加固定 max-height；守住位置：正文容器的 className；改错故障：长回复结尾被切掉且没有展开入口，用户看不到完整答复
// INV-13 时间一律用 formatRelativeTime 的相对时间展示，绝对时间不在本文件引入；守住位置：每条记录的时间 span；改错故障：改成本地时区格式化后与工单列表口径不一致，用户对不上发生时刻
// INV-14 相对时间必须在渲染时按当前时刻计算，禁止把结果缓存到 item 上；守住位置：formatRelativeTime 的调用点；改错故障：页面停留数分钟后文案不刷新，刚发生的记录一直显示为几分钟前
// INV-15 单步耗时的起点必须是排序后紧邻的上一条，不能取事件数组里的上一条；守住位置：previousItem 的取值；改错故障：兜底评论夹在中间时耗时算成负数或跳步，时长角标与顺序矛盾
// INV-16 耗时角标只在 showDurations 为真且存在上一条时出现，首条记录永不显示；守住位置：durationLabel 的三元条件；改错故障：首条记录挂上「即时」角标，用户误以为它前面还有一个事件
// INV-17 耗时换算必须把非有限值与零差值收敛为「即时」，不能让 NaN 或负数进入文案；守住位置：formatStepDuration 的首个判断；改错故障：角标显示 NaN 天或负数分钟，用户看不懂进度
// INV-18 附件链接优先取 preview_url、其次 download_url，两者都缺时不得渲染出 undefined 的 href；守住位置：href 的或链表达式；改错故障：空 href 让浏览器按当前页跳转，点击附件把用户带离详情页
// INV-19 图片判定必须同时接受 content_type 前缀与文件名后缀，任一命中即按图片渲染；守住位置：isTimelineImageAttachment；改错故障：服务端未回填 content_type 时图片降级成文件名链接，用户要多点一次
// INV-20 组件对 props 只读：events 与 comments 不得原地排序或追加，所有派生都写进新建的 items 数组；守住位置：getFeedbackTimelineItems 入参处理；改错故障：调用方缓存数组被就地打乱，其他视图的列表顺序随之改变
import type {
  FeedbackComment,
  FeedbackCommentAttachment,
  FeedbackTicketEvent,
  FeedbackTicketEventType,
} from "@zcode/shared";
import {
  CheckCircle2,
  CornerDownRight,
  MessageSquare,
  Sparkle,
  UserCheck2,
  type LucideIcon,
} from "lucide-react";
import { filterUserVisibleComments, formatRelativeTime } from "@/feedback/feedbackUserView.js";
import { getUserFacingEventSummary } from "@/feedback/feedbackTimelineSummary.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type MessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string>,
) => string;

interface FeedbackTimelineItem {
  id: string;
  kind: "event" | "reply";
  createdAt: string;
  // 事件
  type?: FeedbackTicketEventType;
  summary?: string;
  actor?: string | null;
  // 回复
  body?: string;
  attachments?: FeedbackCommentAttachment[];
  isStaff?: boolean;
}

const EVENT_ICON: Record<FeedbackTicketEventType, LucideIcon> = {
  created: Sparkle,
  status_changed: CheckCircle2,
  assignee_changed: UserCheck2,
  staff_replied: MessageSquare,
  user_replied: CornerDownRight,
};

export function getFeedbackTimelineItems(
  events: FeedbackTicketEvent[],
  comments: FeedbackComment[],
  formatMessage?: MessageFormatter,
): FeedbackTimelineItem[] {
  // 先把评论过一遍可见性过滤，后续查评论、补兜底评论都只能在这个结果上做
  // 未通过过滤的评论既不能进 comment_id 集合的来源，也不能进兜底循环，否则内部备注会漏到用户视野
  // 过滤产生新数组，因此下面的按 id 查找与遍历都不会触碰调用方传入的 comments，满足 props 只读
  // [权衡] 这里不建 id 到评论的 Map，单张工单的评论量是个位数，线性查找比建表更省一次分配
  // 若把过滤挪到第二段循环里逐条判断，事件分支仍会读到不可见评论的正文，出现部分泄露
  // 若改到渲染层过滤，items 数量会随重渲染变化，排序与耗时计算失去稳定基准
  // 该结果不做 memo，函数每次调用都重算，避免跨调用的缓存与工单切换后的陈旧数据打架
  // [失败路径] 即便过滤函数返回同一个数组引用，本文件也只用它读和查，不会就地修改
  const visibleComments = filterUserVisibleComments(comments);
  // 用 comment_id 去重：如果事件里已经有 staff_replied/ user_replied 指向某条评论，
  // 评论就以事件形式呈现，不再额外加一条。
  // 这个集合是「哪些评论已经以事件形态出现过」的唯一判据，成员只存数字 id
  // 只登记 staff_replied 与 user_replied 两类，其他事件即便 payload 带 comment_id 也不收
  // payload 可能为 null、可能是旧结构，读 comment_id 前必须先判存在再判真值
  // id 为 0 会被判成假值，这里沿用评论 id 从 1 起算的约定，不额外兼容 0
  // [失败路径] 漏登记会让同一条回复出现两次，一次是事件卡片、一次是评论卡片，用户以为消息重复发送
  // 多登记（例如把状态变更的 payload 也算进来）会误伤 id 恰好相同的真实评论，那条评论直接消失
  // 集合只在本次调用内存活，不跨工单缓存，切换工单后不会残留上一张工单的 id
  // 若改成按评论对象比对的 Set，需要对象引用相等，而事件与评论是两条数据源，永远对不上
  const eventCommentIds = new Set<number>();
  for (const ev of events) {
    const payload = ev.payload as { comment_id?: number } | null | undefined;
    if ((ev.type === "staff_replied" || ev.type === "user_replied") && payload?.comment_id) {
      eventCommentIds.add(payload.comment_id);
    }
  }

  const items: FeedbackTimelineItem[] = [];

  for (const ev of events) {
    items.push({
      id: `event-${ev.id}`,
      kind: "event",
      createdAt: ev.created_at,
      type: ev.type,
      summary: getUserFacingEventSummary(ev, formatMessage),
      actor: getUserFacingEventActor(ev, formatMessage),
    });
    // 如果是回复事件，附带正文（从评论里查）
    const payload = ev.payload as { comment_id?: number } | null | undefined;
    if (payload?.comment_id) {
      const comment = visibleComments.find((c) => c.id === payload.comment_id);
      if (comment) {
        // 事件项先入数组、再回填正文，所以这里按下标取刚 push 的那一项，避免重新查一遍
        // 正文、附件、是否官方三件套必须同时写，缺一个就会渲染出有正文却没有附件的半成品卡片
        // attachments 用空数组兜底，让下游的 length 判断与 map 都不必再判空
        // [权衡] 采用可变回填而不是先组装完整对象，是为了直接复用事件摘要与 actor 的结果，少一次分支
        // 非空断言成立的前提是上一行刚刚 push，若将来把 push 挪进条件分支，这个断言会先失效
        // 找不到对应评论时不回填，事件仍以摘要形态展示，保证旧数据下也有一条可读记录
        // 正文只取自可见评论，因此不可见评论的内容不会经由事件这条路径漏出
        // 若改成 push 时一次性构造完整对象，需要把评论查找提到事件循环之前，等价但多一次遍历
        items[items.length - 1]!.body = comment.body;
        items[items.length - 1]!.attachments = comment.attachments ?? [];
        items[items.length - 1]!.isStaff = comment.is_staff;
      }
    }
  }

  // 兜底：评论里没有对应 event 的（旧数据）也展示
  // 第二段循环只处理「有评论却没有对应事件」的历史数据，新写入的数据一般不会命中
  // 命中判定用事件的 comment_id 集合，而不是评论有没有正文，两者语义不同
  // 兜底项的 id 加 reply- 前缀，与事件项的 event- 前缀分处两个命名空间，避免 id 撞车
  // actor 由 is_staff 推出，官方评论记为产品经理、其余记为用户，不复用事件侧的推断函数
  // 这类项没有 type 与 summary，渲染时落在「官方回复」与「你的补充」两条兜底文案上
  // [失败路径] 若这里也去调事件侧的 actor 推断，缺少事件对象会直接抛错，整块时间线白屏
  // 顺序上兜底项后于事件项入数组，同一毫秒内的稳定排序因此让事件排在评论前面
  // 若省掉这个循环，升级前写入的老工单会丢掉全部用户回复，只剩状态变更记录
  for (const c of visibleComments) {
    if (eventCommentIds.has(c.id)) continue;
    items.push({
      id: `reply-${c.id}`,
      kind: "reply",
      createdAt: c.created_at,
      body: c.body,
      attachments: c.attachments ?? [],
      isStaff: c.is_staff,
      actor: c.is_staff
        ? formatOptionalMessage(formatMessage, "feedback.actor.productManager", "产品经理")
        : formatOptionalMessage(formatMessage, "feedback.actor.user", "用户"),
    });
  }

  // 时间线的唯一排序点：把 createdAt 解析成毫秒后做数值升序，早发生的排在前面
  // 必须转成数字再相减，直接比较 ISO 字符串只在两个时间串时区偏移相同时才碰巧正确
  // [失败路径] Date 解析失败得到 NaN，比较函数返回 NaN 会被当作相等，坏数据被静默留在原位
  // 就地排序是安全的，items 是本次调用新建的本地数组，不是调用方传入的 events
  // [权衡] 依赖 Array.prototype.sort 的稳定性而不是在比较函数里加序号，少一个派生字段
  // 稳定性在这里不可省：同一毫秒的事件与兜底评论靠入数组先后决定次序，事件必须在前
  // 排序后不再按 kind 分组，否则「事件在前」的稳定性被打乱，耗时链也会跳步
  // 若改到渲染层排序，每次重渲染都会重排一次，previousItem 与耗时角标随之抖动
  return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function getUserFacingEventActor(
  event: FeedbackTicketEvent,
  formatMessage?: MessageFormatter,
) {
  switch (event.type) {
    case "created":
    case "user_replied":
      return formatOptionalMessage(formatMessage, "feedback.actor.user", "用户");
    case "assignee_changed":
      return formatOptionalMessage(
        formatMessage,
        "feedback.actor.productManager",
        "产品经理",
      );
    case "staff_replied":
      return formatOptionalMessage(
        formatMessage,
        "feedback.actor.productManager",
        "产品经理",
      );
    case "status_changed": {
      const payload = event.payload as { to?: unknown } | null | undefined;
      const toStatus = typeof payload?.to === "string" ? payload.to : "";
      return ["开发中", "已解决", "已上线"].includes(toStatus)
        ? formatOptionalMessage(formatMessage, "feedback.actor.dev", "研发")
        : formatOptionalMessage(
            formatMessage,
            "feedback.actor.productManager",
            "产品经理",
          );
    }
    default:
      return null;
  }
}

export function FeedbackTimeline({
  events,
  comments,
  showDurations = false,
}: {
  events: FeedbackTicketEvent[];
  comments: FeedbackComment[];
  showDurations?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const items = getFeedbackTimelineItems(events, comments, formatMessage);

  // 空列表是正常业务状态（新工单尚未产生任何记录），必须给出占位而不是空白容器
  // 判断放在 hooks 之后、主渲染之前，保证任何一次渲染的 hooks 调用顺序保持一致
  // 提前返回的是段落而不是 ol，避免留下一条只有竖线、没有任何节点的空轨道
  // 占位文案走 i18n key，缺失时由 intl 兜底，不在本文件写死中文
  // [权衡] 占位做成简单段落而不是带插图的空状态组件，是为了让时间线在窄侧栏里不撑高
  // 若改成返回 null，父级分区的间距会塌陷，用户看到的是布局错位而不是「暂无记录」
  // 判断依据只有 items 长度，不看 events 与 comments，两者全空与全不可见在用户侧等价
  // 该分支不读取 showDurations，空列表下耗时开关没有可展示的对象
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-surface px-3 py-4 text-center text-ui-base leading-6 text-foreground-subtle">
        {formatMessage({ id: "feedback.timeline.empty" })}
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 pl-5">
      <span className="absolute bottom-1 left-[7px] top-1 w-px bg-border" />
      {items.map((item, index) => {
        const Icon =
          item.kind === "event" && item.type
            ? EVENT_ICON[item.type]
            : item.isStaff
              ? MessageSquare
              : CornerDownRight;
        // 官方身份要覆盖两条来源：兜底评论看 isStaff 字段，事件项看类型是否为 staff_replied
        // 这个布尔值同时决定圆点配色与正文卡片底色，两处必须共用同一个值，不能各算一遍
        // 事件项上的 item.isStaff 没有意义，三元的第一支必须限定 kind 为 reply 才读它
        // [失败路径] 若写成只读 item.isStaff 的单条件，状态变更事件会被判成非官方，圆点全变成用户色
        // 配色优先级是官方最高、其次本人操作、最后系统事件，顺序颠倒会让官方答复失去视觉重量
        // 圆点颜色与卡片底色来自同一布尔值，调色时只改 class 不改判定，避免出现半官方样式
        // 该值不参与 key、也不参与排序，身份只影响呈现，不影响时间线结构
        // 若把身份写进 item 由派生函数返回，事件与评论两条数据源都要补字段，收益不抵改动面
        const isStaff = item.kind === "reply" ? item.isStaff : item.type === "staff_replied";
        const previousItem = index > 0 ? items[index - 1] : null;
        const durationLabel =
          showDurations && previousItem
            ? formatStepDuration(previousItem.createdAt, item.createdAt, formatMessage)
            : null;
        return (
          <li key={item.id} className="relative">
            <span
              className={cn(
                "absolute -left-5 top-0.5 flex size-4 items-center justify-center rounded-full ring-4 ring-card",
                isStaff
                  ? "bg-primary text-primary-foreground"
                  : item.type === "user_replied" || item.kind === "reply"
                    ? "bg-secondary text-foreground"
                    : "bg-success text-success-foreground",
              )}
            >
              <Icon className="size-2.5" />
            </span>
            <div className="space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui-xs leading-5">
                <span className="font-medium text-foreground">
                  {item.summary ??
                    (item.isStaff
                      ? formatMessage({ id: "feedback.timeline.officialReply" })
                      : formatMessage({ id: "feedback.timeline.yourSupplement" }))}
                </span>
                {item.actor && item.kind === "event" ? (
                  <span className="text-foreground-subtle">· {item.actor}</span>
                ) : null}
                <span className="text-foreground-subtle">
                  · {formatRelativeTime(item.createdAt, formatMessage)}
                </span>
                {durationLabel ? (
                  <span className="rounded-full bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                    {formatMessage({ id: "feedback.timeline.duration" }, { time: durationLabel })}
                  </span>
                ) : null}
              </div>
              {item.body || item.attachments?.length ? (
                <div
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-ui-base leading-6",
                    isStaff
                      ? "border-primary/25 bg-accent text-foreground"
                      : "border-border bg-surface text-foreground",
                  )}
                >
                  {item.body ? <p className="whitespace-pre-wrap">{item.body}</p> : null}
                  {!!item.attachments?.length && (
                    <div className={cn("grid gap-2 sm:grid-cols-2", item.body ? "mt-2" : "")}>
                      {item.attachments.map((attachment) => {
                        const href = attachment.preview_url || attachment.download_url || undefined;
                        const isImage = isTimelineImageAttachment(attachment);
                        return (
                          <a
                            key={attachment.id}
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-border-hover"
                          >
                            {isImage && href ? (
                              <img
                                src={href}
                                alt=""
                                className="max-h-40 w-full object-cover"
                              />
                            ) : (
                              <span className="block truncate px-3 py-2 text-ui-base text-foreground-subtle">
                                {attachment.filename}
                              </span>
                            )}
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function isTimelineImageAttachment(attachment: FeedbackCommentAttachment) {
  if (attachment.content_type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.filename);
}

function formatStepDuration(from: string, to: string, formatMessage?: MessageFormatter) {
  const diffMs = new Date(to).getTime() - new Date(from).getTime();
  // 这个判断同时挡两类退化输入：时间戳解析失败得到 NaN，以及当前条不晚于上一条
  // 零差值归入「即时」而不是「不到 1 分钟」，同一毫秒的相邻记录确实算同时发生
  // 负差值只可能来自排序被破坏或坏数据，这里不抛错而是降级为「即时」，保证时间线仍可渲染
  // [失败路径] 若漏掉有限性判断，NaN 会穿过后续取整与比较，最终渲染出 NaN 分钟
  // 先挡退化再做分钟、小时、天三段换算，保证非数与负数不会进入任何一段
  // [权衡] 用四舍五入到分钟、小时、天三档而不是精确到秒，避免长工单的时间线被秒级数字淹没
  // 若把判断改成只判 diffMs 小于 0，NaN 比较恒为假，退化输入会被当成有效时长继续换算
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return formatOptionalMessage(formatMessage, "feedback.duration.instant", "即时");
  }
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) {
    return formatOptionalMessage(formatMessage, "feedback.duration.lessThanMinute", "不到 1 分钟");
  }
  if (minutes < 60) {
    return formatOptionalMessage(
      formatMessage,
      "feedback.duration.minutes",
      `${minutes} 分钟`,
      { count: String(minutes) },
    );
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return formatOptionalMessage(
      formatMessage,
      "feedback.duration.hours",
      `${hours} 小时`,
      { count: String(hours) },
    );
  }
  const days = Math.round(hours / 24);
  return formatOptionalMessage(
    formatMessage,
    "feedback.duration.days",
    `${days} 天`,
    { count: String(days) },
  );
}

function formatOptionalMessage(
  formatMessage: MessageFormatter | undefined,
  id: string,
  fallback: string,
  values?: Record<string, string>,
) {
  return formatMessage ? formatMessage({ id }, values) : fallback;
}
