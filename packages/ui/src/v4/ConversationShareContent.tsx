// INV-01 只读快照：所有交互只改本地 Dialog 选中态，不向 blocks 与 payload 写回，也不发起任何变更请求；守住位置：WorkflowContent 的 selected 与 runOpen、SharedArtifact 的 text 与 failed；改错故障：观众在分享页的操作被当成编辑回写，只读页变成可篡改入口
// INV-02 块级渲染隔离：每个 block 各自包一层 ContentBoundary，异常只能在块内降级为 fallback 文本；守住位置：blocks.map 内的 ContentBoundary；改错故障：单个畸形 workflow 块抛出后整份分享白屏，其余可读内容全部消失
// INV-03 错误边界的 key 必须是 block.id，不能用数组下标；守住位置：ContentBoundary 的 key 属性；改错故障：块增删或顺序变化时 React 复用旧边界状态，已失败的块把新块也渲染成旧 fallback
// INV-04 fallback 按 fallback_row_id 取原始行文本，不能按 block.id 或 payload 内字段取；守住位置：fallbacks.get(block.fallback_row_id)；改错故障：兜底恒为空，块渲染失败时读者看到空白而不是原文
// INV-05 块的渲染顺序必须严格等于 blocks 的入参顺序，禁止排序、去重或按 type 分组；守住位置：blocks.map 直接产出节点；改错故障：对话顺序被重排，前因后果颠倒，读者误读结论
// INV-06 只渲染 workflow 块：CONTENT_RENDERERS 只登记 workflow，其他 type 必须落到边界兜底，不能静默返回空节点；守住位置：CONTENT_RENDERERS 常量与 Renderer 取值处；改错故障：未支持的新块被当成空内容跳过，读者完全不知道那里有内容
// INV-07 资源 URL 只能来自 artifactUrls 映射，禁止在组件内拼接 file、data、zcode-artifact 等协议地址；守住位置：SharedArtifact 的 url 与下载链接的 href；改错故障：观众点击后访问到本机路径，本地绝对路径也被写进页面源码
// INV-08 拉取预览时 credentials 必须为 omit，不能带上读者的会话 Cookie；守住位置：fetch 的 credentials 选项；改错故障：签名对象存储域名收到分享页的登录凭据，或跨域请求被凭证模式拦下导致预览恒失败
// INV-09 每个 useEffect 必须返回 abort 清理，且依赖要覆盖 url、readable、unavailable、previewText；守住位置：effect 的 return 与依赖数组；改错故障：切换工件后旧请求继续写 text，显示的是上一个工件的正文
// INV-10 请求结果写回前必须检查 aborted，成功与失败两条分支都要检查；守住位置：setText 与 setFailed 前的判断；改错故障：卸载或切换后仍写 state，旧工件的失败提示盖掉新工件的正常预览
// INV-11 切换工件时必须先把 text 重置为 previewText、failed 重置为 false，再决定是否请求；守住位置：effect 开头的两次 set；改错故障：新工件没有 preview_text 时残留上一个工件的正文，用户以为内容串了
// INV-12 只有 kind 为 markdown 或 content_type 以 text/ 开头才走文本预览，不得按文件扩展名嗅探；守住位置：readable 表达式；改错故障：二进制被当文本渲染成乱码，或可读文本被当图片渲染成破图
// INV-13 unavailable 的工件只渲染原因文案，绝不发起 fetch、也不渲染预览；守住位置：effect 的提前返回与 unavailable 分支；改错故障：已声明不可用的工件仍去请求，页面同时出现两条矛盾提示，读者以为链接坏了
// INV-14 图片分支只认 content_type 的 image/ 前缀且必须有 url，缺一不可；守住位置：img 所在的三元分支；改错故障：没有声明类型的资源被渲染成破图，或可用图片被静默丢弃
// INV-15 预览文本不得在本文件内二次截断或改写，长度上限由发布端 schema 承担；守住位置：MessageResponse 直接消费 text；改错故障：截断落在代码围栏或表格中间，markdown 结构崩坏，读者看到半截代码
// INV-16 正文预览必须关闭 zcode 文件引用渲染，不能把分享正文里的路径变成可点击入口；守住位置：MessageResponse 的 renderZCodeFileCitations 属性；改错故障：公开页出现指向分享者工作区的文件链接，泄漏目录结构并诱导观众点击
// INV-17 选中态只存 artifact id，不存工件对象，Dialog 是否打开由查表结果推导；守住位置：selected 与 selectedArtifact；改错故障：快照更新后对话框仍显示旧对象，或引用过期无法随 payload 刷新
// INV-18 run 的 runId 必须用 block.id 覆盖，不能沿用 payload.run 里缺失或来自发布端的值；守住位置：run 的 useMemo；改错故障：时间线节点 key 为空或冲突，展开状态串到另一个块
// INV-19 从 run 对话框打开工件时必须先关 run 再设 selected，不能同时开两层 Dialog；守住位置：WorkflowArtifactStrip 的 onOpenArtifact；改错故障：两层遮罩叠加，关闭上层后滚动锁未释放，页面卡死无法滚动
// INV-20 快照署名与采集时间必须渲染在内容块之外的独立节点，禁止拼进正文或工件预览文本；守住位置：capturedSnapshot 段落及其 title；改错故障：水印混进可复制的代码与正文，用户复制出去带脏数据，或被当成模型输出
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ConversationShareWorkflowContentBlock,
  ShareWorkflowArtifact,
  Locale,
} from "@zcode/shared";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { WorkflowCompletionCard } from "@/components/workflow-timeline/WorkflowCompletionCard.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import { buildPresetLabels } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  WorkflowCardHeader,
  workflowRunKindMessageId,
} from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import { workflowCardDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
// 块级错误边界：一个 workflow 块在渲染期抛错时只替换这一块，不打断整份分享的列表渲染
// 边界只接住渲染期异常，effect 里的 fetch 拒绝与事件回调异常都不会到这里，必须由各自分支处理
// 这类异常的唯一来源是快照结构超出组件假设，属于数据与代码版本错配，而不是用户操作失误
// fallback 由调用方传入，边界本身不认识文案，保证降级内容仍是该块在原始对话里的那一行
// [权衡] 不做重试或自动恢复：同一份快照重渲染只会再次抛出，重试会退化成无限循环
// 边界不写日志、不上报，分享页是公开页面，上报会把访问者上下文带出去
// 若改成整页只包一个边界，单个坏块会让所有 turn 一起变成纯文本，读者失去其余可用的富内容
class ContentBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  // failed 一旦为 true 就保持到该边界被卸载，React 不会在 props 变化时自动清回 false
  // 这个静态方法只在子树抛错时被调用，不能读 this，也不允许有副作用
  // 只置一个布尔值而不记录 error 对象：错误信息可能含快照内部字段，公开页不应把它留在 React 树里
  // [失败路径] 恢复只能靠换 key 重新挂载，也就是块身份变了，这正是 key 必须绑 block.id 的原因
  // 若在这里返回带 error 的 state，任何消费方都可能把它渲染进页面，等于把内部堆栈暴露给读者
  // 没有 componentDidCatch 是刻意的：不记录、不上报、不打印，避免公开页在控制台泄漏 payload 片段
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function SharedArtifact({
  artifact,
  url,
  onOpenResource,
}: {
  artifact: ShareWorkflowArtifact;
  url?: string;
  onOpenResource?: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 用 in 收窄而不是直接取属性：board、table、metrics、chart 四个变体根本没有 preview_text 字段
  // 直接读该属性在联合类型上编译不过，强转则会在非文本工件上拿到 undefined 并掩盖变体错误
  // preview_text 的长度上限由发布端 schema 固定，本文件不再截断，整段交给 markdown 渲染
  // preview_text 存在不代表一定渲染文本，还要再过 kind 与 content_type 两道判断
  // 该值同时作为 effect 的依赖与重置初值，必须全程同一来源，不能另外再读一次 artifact
  // 若改成给所有变体统一加可选字段，schema 的 discriminatedUnion 会失去对未知键的拦截能力
  // 分享快照的 version 1 不允许出现 preview_text，能读到它说明发布端已按 version 2 编码
  const previewText = "preview_text" in artifact ? artifact.preview_text : undefined;
  const [text, setText] = useState<string | undefined>(previewText);
  const [failed, setFailed] = useState(false);
  const contentType = "content_type" in artifact ? artifact.content_type : undefined;
  // markdown 一律按文本读，因为它本身就是文本；file 必须由发布端声明 text/ 才允许当文本
  // 不按扩展名推断：扩展名来自不可信输入，而且同名文件的内容类型可能与后缀不符
  // content_type 缺失时 file 退化为不可读，页面只保留打开或下载入口，不猜测内容
  // 这个布尔值同时决定是否发起 fetch 与是否渲染文本分支，两处必须用同一个值，不能各算一次
  // [权衡] 保守到连 application/json 都不当文本：宁可少一个预览，也不把任意响应体灌进 markdown 渲染器
  // 若把判断放宽成只要 content_type 非空，图片分支会被文本分支抢走，读者看到二进制乱码
  const readable = artifact.kind === "markdown" || contentType?.startsWith("text/");
  useEffect(() => {
    setText(previewText);
    setFailed(false);
    // 四条提前返回覆盖：已有内联文本、没有 URL、不可读、工件已被标记不可用
    // 已有 preview_text 时不再请求远程：快照自带文本就是为了让公开页在没有对象存储时也能读完
    // 没有 url 时请求必然失败，提前返回可以省掉一次注定失败的往返与失败提示闪烁
    // unavailable 优先于一切：发布端已判定源缺失或超限，再请求只会得到无意义的错误
    // [资源] 提前返回发生在创建 AbortController 之前，因此不需要清理函数，也不会留下悬挂请求
    // [失败路径] 若漏掉 unavailable 这一条，页面会同时出现不可用说明与预览失败两条互相矛盾的文案
    if (previewText !== undefined || !url || !readable || artifact.unavailable) return;
    const controller = new AbortController();
    // [资源] 请求绑定 AbortSignal，effect 清理时 abort，切换工件或卸载都不会留下后台请求
    // credentials 必须是 omit：工件 URL 通常是签名地址，带上读者的 Cookie 等于把分享页登录态发给存储域
    // 也不用 same-origin 或 include：跨源对象存储下 include 会被 CORS 拒绝，omit 才是唯一可移植的取值
    // void 前缀表明故意不等待 Promise，错误全部在链式 catch 里收敛，不能让它变成未处理的拒绝
    // 只发 GET，不带 body、不带自定义头，避免触发预检请求，也不把本地上下文写进请求
    // [并发] 每次 url 变化都会新建 controller，旧 controller 已在上一次清理中 abort，不会有两个请求同时写回
    // 若改成在渲染期直接调用 fetch，每次重渲染都会打一次对象存储，公开页的请求量将不可控
    void fetch(url, { signal: controller.signal, credentials: "omit" })
      .then(async (response) => {
        // [失败路径] 非 2xx 一律转成异常交给下方的 catch，统一走预览失败分支，而不是把错误页 HTML 当正文渲染
        // 只在 response.ok 时读取 body：对象存储的错误响应常是 XML 或 HTML，读进来会被 markdown 渲染成乱码
        // 抛出的错误不带 URL 与状态文本：这条消息可能进日志或页面，公开页不应把签名地址带出去
        // 异常在同一 Promise 链上被 catch 接住，不会冒泡到 ContentBoundary，也不会成为未处理的拒绝
        // 这里不区分 404 与 5xx：读者能做的动作相同，细分只会暴露存储端细节
        // [权衡] 不重试：签名 URL 过期后重试同样失败，重试循环只会把无意义的请求放大到对象存储
        if (!response.ok) throw new Error("Artifact unavailable");
        const body = await response.text();
        // [并发] 写回前必须确认本请求仍是最新的一次，abort 之后到达的响应一律丢弃
        // 只判断 aborted 而不判断组件是否挂载：abort 已经覆盖卸载与依赖变化两种失效来源
        // 成功分支与失败分支各自判断一次，缺任何一处都会让过期结果覆盖当前工件的状态
        // 成功时只改 text，不动 failed；进入本分支就意味着这次请求是有效的
        // 失败分支把 failed 置真，渲染落到预览失败文案，而不是抛异常交给错误边界
        // [失败路径] 若省略这个判断，先发的慢请求会在后发的快请求之后覆盖正文，读者看到内容对不上标题
        if (!controller.signal.aborted) setText(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [url, readable, artifact.unavailable, previewText]);
  if (artifact.unavailable)
    return (
      <p>
        {intl.formatMessage({ id: "conversationShare.artifact.notIncluded" })} ·{" "}
        {intl.formatMessage({
          id: {
            source_unavailable: "conversationShare.artifact.sourceUnavailable",
            unsupported: "conversationShare.artifact.unsupported",
            limit_exceeded: "conversationShare.artifact.limitExceeded",
          }[artifact.unavailable],
        })}
      </p>
    );
  if (artifact.kind !== "file" && artifact.kind !== "markdown")
    return (
      <ArtifactPresetBody
        artifact={artifact}
        items={artifact.items ?? []}
        labels={buildPresetLabels(intl.formatMessage.bind(intl))}
        missingLabel={intl.formatMessage({ id: "conversationShare.artifact.dashboardUnavailable" })}
        invalidLabel={intl.formatMessage({ id: "conversationShare.artifact.dashboardInvalid" })}
      />
    );
  const resourceId = artifact.resource_id;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {intl.formatMessage({ id: "conversationShare.artifact.openDownload" })}
        </a>
      ) : resourceId && onOpenResource ? (
        <button
          type="button"
          onClick={() => onOpenResource(resourceId)}
          className="self-start text-primary underline"
        >
          {intl.formatMessage({ id: "conversationShare.artifact.openFile" })}
        </button>
      ) : (
        <p>{intl.formatMessage({ id: "conversationShare.artifact.resourceUnavailable" })}</p>
      )}
      {failed ? (
        <p>{intl.formatMessage({ id: "conversationShare.artifact.previewFailed" })}</p>
      ) : readable && (url || previewText !== undefined) ? (
        text === undefined ? (
          <p>{intl.formatMessage({ id: "conversationShare.artifact.loading" })}</p>
        ) : (
          <MessageResponse renderZCodeFileCitations={false}>{text}</MessageResponse>
        )
      ) : contentType?.startsWith("image/") && url ? (
        <img src={url} alt={artifact.title} className="max-w-full" />
      ) : null}
    </div>
  );
}

function WorkflowContent({
  block,
  artifactUrls,
  locale,
  onOpenResource,
}: {
  block: ConversationShareWorkflowContentBlock;
  artifactUrls: ReadonlyMap<string, string>;
  locale: Locale;
  onOpenResource?: (id: string) => void;
}) {
  const { payload } = block;
  // 选中态只存工件 id，不存工件对象：快照不可变，存 id 让 dialog 每次渲染都从 payload 重新查找
  // 对话框是否打开由 selectedArtifact 是否为 undefined 推导，不用第二个布尔值，避免两个状态互相矛盾
  // 从 run 对话框里打开工件时先关 run 再设 selected，保证同一时刻只有一层 dialog 抢占滚动锁
  // id 查不到时查表返回 undefined，对话框不打开，页面保持原样，不会渲染无标题的空壳
  // 关闭工件对话框只清 selected，不动 runOpen；从 run 跳转过来时 run 已主动关闭，不会残留两层遮罩
  // [权衡] 不用受控的 open 布尔值：两个状态源迟早不同步，出现遮罩已关但内容仍在的残影
  const [selected, setSelected] = useState<string>();
  const [runOpen, setRunOpen] = useState(false);
  const run = useMemo(
    () => (payload.run ? { ...payload.run, runId: block.id } : undefined),
    [payload.run, block.id],
  );
  const model = useMemo(
    () => (payload.graph && run ? buildWorkflowTimeline(payload.graph, run) : undefined),
    [payload.graph, run],
  );
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const detail = workflowCardDetail(format, model, payload.graph, run);
  const selectedArtifact = payload.artifacts.find((artifact) => artifact.id === selected);
  const figures = {
    ...(payload.duration_ms === undefined ? {} : { durationMs: payload.duration_ms }),
    ...(run
      ? { tokens: run.usage.spentTokens, subagents: run.actors.length, phases: run.phases?.length }
      : {}),
  };
  return (
    <div className="min-w-0" data-share-content-block={block.id}>
      {payload.completion ? (
        <WorkflowCompletionCard
          name={payload.name}
          figures={figures}
          artifacts={payload.artifacts.map((artifact) => ({
            ...artifact,
            ...(artifact.kind === "file" || artifact.kind === "markdown"
              ? { contentType: artifact.content_type }
              : { itemCount: artifact.items?.length ?? 0 }),
          }))}
          onOpenArtifact={setSelected}
          onOpenRun={model ? () => setRunOpen(true) : undefined}
          testIdKey={block.id}
        />
      ) : (
        <section
          className="wf-motion flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-2 pt-1.5"
          data-share-workflow-run
        >
          <WorkflowCardHeader
            name={payload.name}
            kind={
              run
                ? format({ id: workflowRunKindMessageId(run) })
                : intl.formatMessage({ id: "conversationShare.workflowUnavailable" })
            }
            detail={detail?.detail}
            expanded
            live={false}
            onOpenDetails={model ? () => setRunOpen(true) : undefined}
          />
          {model ? <WorkflowTimeline model={model} /> : null}
          <WorkflowArtifactStrip
            artifacts={payload.artifacts}
            onOpenArtifact={setSelected}
            className="pb-0.5 pt-0.5"
          />
        </section>
      )}
      {payload.unavailable ? (
        <p className="mt-2 text-ui-sm">
          {intl.formatMessage({ id: "conversationShare.workflowPartial" })}
        </p>
      ) : null}
      <p
        className="mt-1 text-ui-xs text-foreground-subtlest"
        title={new Date(block.captured_at).toLocaleString(locale)}
      >
        {intl.formatMessage({ id: "conversationShare.capturedSnapshot" })}
      </p>
      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto">
          <DialogTitle>{payload.name}</DialogTitle>
          {model ? <WorkflowTimeline model={model} /> : null}
          <WorkflowArtifactStrip
            artifacts={payload.artifacts}
            onOpenArtifact={(id) => {
              setRunOpen(false);
              setSelected(id);
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={selectedArtifact !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto">
          <DialogTitle>{selectedArtifact?.title}</DialogTitle>
          {selectedArtifact ? (
            <SharedArtifact
              artifact={selectedArtifact}
              url={
                "resource_id" in selectedArtifact && selectedArtifact.resource_id
                  ? artifactUrls.get(selectedArtifact.resource_id)
                  : undefined
              }
              onOpenResource={onOpenResource}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 注册表只接入经过公开 schema 的类型；未知块由时间线保留原摘要。 */
const CONTENT_RENDERERS = { workflow: WorkflowContent };
export function ConversationShareContent({
  blocks,
  fallbacks,
  ...props
}: {
  blocks: readonly ConversationShareWorkflowContentBlock[];
  fallbacks: ReadonlyMap<number, string>;
  artifactUrls: ReadonlyMap<string, string>;
  locale: Locale;
  onOpenResource?: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {blocks.map((block) => {
        // 注册表只登记经过公开 schema 校验的块类型，新增类型必须先有 schema 才能接入渲染
        // 查表失败时 Renderer 为 undefined，React 渲染抛错并被外层 ContentBoundary 接住，最终落到 fallback 文本
        // 不写判空后返回 null：静默返回空节点会让读者以为这一段没有内容，比降级成纯文本更糟
        // 查表在 map 内完成而不是模块顶层一次性算好，新增类型时不需要改渲染循环
        // 边界 key 用 block.id 而不是 map 下标，块增删时错误边界与 dialog 状态都不会错配到别的块
        // [权衡] 不用 switch 穷举：switch 在新增类型时容易漏分支且没有默认兜底，注册表把未知类型统一交给边界
        const Renderer = CONTENT_RENDERERS[block.type];
        const fallback = (
          <div className="whitespace-pre-wrap">{fallbacks.get(block.fallback_row_id)}</div>
        );
        return (
          <ContentBoundary key={block.id} fallback={fallback}>
            <Renderer block={block} {...props} />
          </ContentBoundary>
        );
      })}
    </div>
  );
}
