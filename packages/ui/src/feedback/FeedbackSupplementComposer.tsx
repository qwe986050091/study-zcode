// feedback/FeedbackSupplementComposer.tsx —— 工单补充反馈输入框：草稿采集、附件读取、提交编排
//
// INV-01 附件占用上限 6 条同时由 appendFiles 的 remaining 检查与 setAttachments 的 slice 约束，两处都必须保留；守住位置：appendFiles 与合并分支；改错故障：任一处理被删后列表可突破上限，提交时后端拒绝整条补充，已写正文一并丢失
// INV-02 单附件 100MB 上限必须在 readSupplementAttachment 之前用 File.size 拦截；守住位置：appendFiles 的 tooLarge 分支；改错故障：超大文件先被读成 base64 再判大小，内存峰值翻倍并可能直接卡死渲染进程
// INV-03 attachments 只能通过 setAttachments 的函数式更新器写入，不允许基于闭包快照整体覆盖；守住位置：appendFiles 与 removeAttachment；改错故障：粘贴与选文件并发时后写覆盖先写，用户刚添加的附件凭空消失
// INV-04 submitting 期间必须同时禁用输入框、添加附件按钮、删除按钮与发送按钮；守住位置：四处 disabled 表达式；改错故障：提交中仍可再次点击发送，同一草稿被提交两次，工单出现重复正文与重复附件
// INV-05 提交成功必须先清空 comment 与 attachments，再 await onSubmitted；守住位置：handleSubmit 成功分支；改错故障：刷新列表导致组件卸载后再清空，setState 落到已卸载实例，草稿残留并可被二次提交
// INV-06 提交失败必须原样保留 comment 与 attachments，只写 error；守住位置：handleSubmit 的 catch；改错故障：失败即清空，用户已写的补充说明与已选附件全部蒸发，只能从头重来
// INV-07 正文 trim 后为空且附件为 0 时 handleSubmit 必须直接返回；守住位置：handleSubmit 首个判断；改错故障：空提交产生一条无意义评论，浪费工单时间线并可能触发通知
// INV-08 有附件时必须先创建评论并取得 message_id，缺失即抛错且终止整个上传；守住位置：submitSupplementFeedback 的 message_id 分支；改错故障：附件被绑定到工单初始消息，用户在补充里上传的截图出现在错误位置
// INV-09 附件上传必须串行，且任一条失败后不再上传剩余附件；守住位置：submitSupplementFeedback 的上传循环；改错故障：半套附件散落在工单上，用户无法判断哪些已成功、重试还会产生重复附件
// INV-10 评论正文中的附件清单由 formatUploadedAttachments 依据上传文件名生成并追加在用户正文之后；守住位置：submitSupplementFeedback 的 body 拼装；改错故障：正文与附件脱节，读者无法把「见附件」对应到具体文件
// INV-11 附件数据必须保存去掉 data URL 前缀后的纯 base64；守住位置：readSupplementAttachment 的 commaIndex 切片；改错故障：前缀随数据一起上传，后端解码失败，全部附件损坏
// INV-12 FileReader 失败与 data URL 缺少逗号两条路径都必须 reject；守住位置：reader.onerror 与 commaIndex 分支；改错故障：空数据被当作合法草稿提交，工单出现 0 字节附件
// INV-13 kind 由 file.type 的 image/ 前缀判定，之外一律回落 other；contentType 缺失回落 application/octet-stream；守住位置：readSupplementAttachment 的 resolve；改错故障：图标与真实类型不一致，后端按错误 MIME 存储导致预览失败
// INV-14 剪贴板含文件时必须 preventDefault，且只处理 clipboardData.files；守住位置：handlePaste；改错故障：粘贴截图时输入框被塞入二进制乱码，正文被污染且无法撤销
// INV-15 文件选择 input 在每次 change 读取后必须把 value 置空；守住位置：input 的 onChange；改错故障：再次选择同一文件不触发 change，用户以为附件没加上而反复点击
// INV-16 列表 key 必须用草稿 id（时间戳加随机后缀），不能用文件名；守住位置：附件列表的 map；改错故障：同名文件复用同一 DOM 节点，删除一条时另一条的图标与禁用态被错误复用
// INV-17 删除按钮只有图标，必须带含文件名的 aria-label 才能被读屏识别；守住位置：删除按钮的 aria-label；改错故障：屏幕阅读器只读出「按钮」，用户无法知道删的是哪个附件
// INV-18 所有用户可见文案必须走 intl key，标题与描述仅在调用方显式传入时才覆盖默认 key；守住位置：displayTitle、displayDescription 与各处 formatMessage；改错故障：非中文界面混入中文片段，且文案无法随语言切换
import { useCallback, useRef, useState, type ClipboardEvent } from "react";
import { FileText, ImageIcon, Loader2, Paperclip, Send, X } from "lucide-react";
import type { FeedbackAttachmentKind } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { FeedbackErrorTip } from "@/feedback/feedbackBadges.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 数量与体积上限是编辑态与提交态共用的唯一真源，后端校验阈值必须与此处一致
// 6 条对应工单补充场景的实际截图数量，而不是接口硬限制；超出部分由 appendFiles 显式报错
// 100MB 覆盖单张高分辨率截图与常见日志包，同时低于 Electron IPC 单条消息的实际上限
// [权衡] 做成 props 会让每个调用点各自定义，出现同一工单两种口径，因此固定为模块常量
// 两个常量被导出，测试与后端契约校验直接引用，避免在测试里再抄一份魔数
// 进制取 1024 而非 1000，与系统文件管理器显示一致，用户看到的数值不会与提示矛盾
// 上限只拦新增，不回溯已存在的附件：历史上传超过当前上限的工单仍可查看与删除
export const MAX_SUPPLEMENT_ATTACHMENTS = 6;
export const MAX_SUPPLEMENT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface SupplementAttachmentDraft {
  id: string;
  filename: string;
  contentType: string;
  dataBase64: string;
  size: number;
  kind: FeedbackAttachmentKind;
}

// 这是提交动作的唯一实现，组件只负责收集草稿与展示错误，便于在不渲染 UI 的情况下单测
// [事务] 两步写操作有先后依赖：先建评论拿到 message_id，再逐条上传附件并携带该 id
// 评论正文把附件名拼在用户输入之后，让工单读者不打开附件也知道传了什么
// 失败不吞异常：任何一步抛错都向上抛给 handleSubmit，由它转成可见错误并保留草稿
// [失败路径] 有附件却拿不到 message_id 时直接抛错，宁可整单失败也不把附件挂到错误的消息上
// 依赖注入只取 comment 与 uploadAttachmentData 两个方法，缩小测试替身的面积
// 函数不持有 React 状态，因此可被重试调用；重试的幂等性由后端评论接口保证
// 返回值只有 void，成功与否通过是否抛异常表达，调用方无需处理部分成功
export async function submitSupplementFeedback({
  ticketId,
  feedbackService,
  comment,
  attachments,
  formatUploadedAttachments,
}: {
  ticketId: string;
  feedbackService: Pick<IFeedbackService, "comment" | "uploadAttachmentData">;
  comment: string;
  attachments: SupplementAttachmentDraft[];
  formatUploadedAttachments: (names: string[]) => string;
}): Promise<void> {
  const trimmed = comment.trim();
  const uploadedNames = attachments.map((attachment) => attachment.filename);
  const body =
    uploadedNames.length > 0
      ? [trimmed, formatUploadedAttachments(uploadedNames)].filter(Boolean).join("\n\n")
      : trimmed;
  const createdComment = await feedbackService.comment(ticketId, body);
  // 只在有附件时才要求 message_id；纯文字补充不依赖消息绑定，不做无谓失败
  // [失败路径] 缺失 message_id 说明后端版本或响应结构不匹配，属于不可自动恢复的错误
  // 抛错发生在任何上传之前，工单与磁盘上都不会留下半套附件
  // 错误用英文常量而非 intl key：它主要被日志与 getErrorMessage 兜底消费
  // 不在本函数里重试评论创建：重试会再写一条评论，产生重复内容
  // 判断必须先于上传循环，否则第一条附件已经挂到工单初始消息上
  if (attachments.length > 0 && !createdComment.message_id) {
    // Bugfix: 新反馈接口要求 message 附件上传凭证携带 message_id；
    // 缺少后端 message_id 时继续上传会错误绑定到工单初始内容。
    throw new Error("Missing feedback message_id");
  }
  // 上传串行执行，任一失败立即中断，剩余附件不会继续写入
  // 串行换来的顺序稳定，工单里附件排列与用户选择顺序一致
  // [权衡] 改并发能缩短总耗时，但失败时已上传的附件无法回滚，错误归属也说不清
  // messageId 逐条传入，保证每条附件都显式携带同一条消息的凭证
  // dataBase64 已是纯 base64，前缀剥离收敛在读取函数，循环内不再处理
  for (const attachment of attachments) {
    await feedbackService.uploadAttachmentData(ticketId, attachment.kind, {
      dataBase64: attachment.dataBase64,
      filename: attachment.filename,
      contentType: attachment.contentType,
      messageId: createdComment.message_id,
    });
  }
}

export function FeedbackSupplementComposer({
  ticketId,
  feedbackService,
  onSubmitted,
  title,
  description,
}: {
  ticketId: string;
  feedbackService: IFeedbackService;
  onSubmitted: () => Promise<void>;
  title?: string;
  description?: string;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const displayTitle = title ?? formatMessage({ id: "feedback.supplement.title" });
  const displayDescription =
    description ?? formatMessage({ id: "feedback.supplement.description" });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [comment, setComment] = useState("");
  // 附件草稿与正文分开存两份 state，互不派生：正文可独立编辑，附件列表可独立增删
  // 草稿只存在于组件内存，未提交即丢弃；这是有意的，避免在工单里留下半成品附件
  // 顺序即上传顺序，state 数组顺序直接决定工单里附件的排列，不做二次排序
  // 所有写入都走函数式更新器，因为 appendFiles 的闭包可能落后于最新 state
  // 每项都自带 dataBase64，state 体积与附件总大小线性相关，6 条与 100MB 是内存安全阀
  // 提交成功后整体清空，失败时原样保留，用户重试时不需要重新选文件
  // submitting 与 error 是独立两个 state：提交失败不清空草稿，提交中也不清空错误
  // 没有引入 reducer：转换只有增、删、清空三种，额外抽象会掩盖真正的并发点
  const [attachments, setAttachments] = useState<SupplementAttachmentDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appendFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      // remaining 是本次还能接收的条数，用当前 attachments.length 计算，因此 appendFiles 必须依赖该长度
      // [并发] 同一帧内连续两次选择文件时，两次调用读到的 length 可能相同，最终数量靠 setAttachments 的 slice 兜底
      // 先判 remaining 再切片，错误提示才能区分已满与超出的部分被丢弃两种情况
      // [失败路径] 已满时不读取任何文件，直接给出附件数量上限提示，避免白读几十 MB
      // 提示文案用 count 参数注入上限值，改常量后提示自动同步，不会出现写死的 6 条
      // remaining 只在本次调用内有效，不写入 state，避免出现与 attachments 不同步的派生状态
      // [权衡] 合并分支内部再切一次，与这里的判断冗余，但正是这层冗余抵御并发追加
      // 这里的 attachments 来自闭包，可能落后于最新 state；依赖数组只写 length 已足够，其余逻辑幂等
      const remaining = MAX_SUPPLEMENT_ATTACHMENTS - attachments.length;
      if (remaining <= 0) {
        setError(
          formatMessage(
            { id: "feedback.supplement.attachmentLimit" },
            { count: String(MAX_SUPPLEMENT_ATTACHMENTS) },
          ),
        );
        return;
      }
      const accepted = files.slice(0, remaining);
      const tooLarge = accepted.find((file) => file.size > MAX_SUPPLEMENT_ATTACHMENT_BYTES);
      if (tooLarge) {
        setError(
          formatMessage(
            { id: "feedback.supplement.attachmentTooLarge" },
            { name: tooLarge.name || formatMessage({ id: "feedback.supplement.attachment" }) },
          ),
        );
        return;
      }
      try {
        // 读取是纯内存操作，可以并发；失败时没有任何外部副作用，与上传阶段语义不同
        // [失败路径] 任一文件读取失败会让整批拒绝，已读出的其余结果一并丢弃
        // 读取期间添加按钮未禁用，用户可能再次选文件；最终合并交给函数式更新器
        // 合并后再 slice，防止并发追加突破上限
        // 只有整批成功才落 state，保证列表里每个草稿都带完整 dataBase64
        // [权衡] 用 allSettled 能保留部分成功，但残缺草稿无法单独提交，保留只会误导用户
        const next = await Promise.all(accepted.map((file) => readSupplementAttachment(file)));
        setAttachments((current) =>
          [...current, ...next].slice(0, MAX_SUPPLEMENT_ATTACHMENTS),
        );
        if (files.length > remaining) {
          setError(
            formatMessage(
              { id: "feedback.supplement.attachmentLimit" },
              { count: String(MAX_SUPPLEMENT_ATTACHMENTS) },
            ),
          );
        }
      } catch (readError) {
        setError(getErrorMessage(readError));
      }
    },
    [attachments.length],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }, []);

  // [失败路径] 剪贴板没有文件时直接返回，保留默认粘贴行为让纯文本正常进入输入框
  // 有文件时必须 preventDefault，否则浏览器会把文件名或二进制当文本塞进 Textarea
  // 只取 clipboardData.files，不解析 text/html：富文本转附件属于另一套职责
  // 粘贴不区分图片与文件，类型判定统一在 readSupplementAttachment 里完成
  // 复用 appendFiles，因此粘贴与选择文件共享数量、体积与错误提示口径
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      event.preventDefault();
      void appendFiles(files);
    },
    [appendFiles],
  );

  // 提交前重新 trim 一次，防止用户只输入空白也触发请求
  // [并发] setSubmitting 是防重复提交的唯一闸门，置真之后所有入口按钮随即 disabled
  // 依赖数组包含 attachments 与 comment，每次输入都会重建回调；这是必要的，回调必须读到最新草稿
  // 成功路径先清空本地草稿再 await onSubmitted，因为刷新列表可能卸载本组件
  // [失败路径] 捕获后只设置错误、不清空草稿，用户可直接改完再发
  // finally 里复位 submitting，保证失败与异常都不会让发送按钮永久禁用
  // 错误统一走 getErrorMessage，避免把后端原始堆栈直接展示给用户
  // 提交内容是自己 trim 后的副本而非 state 原值，避免首尾空白进入工单正文
  const handleSubmit = useCallback(async () => {
    const trimmed = comment.trim();
    if (!trimmed && attachments.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitSupplementFeedback({
        ticketId,
        feedbackService,
        comment: trimmed,
        attachments,
        formatUploadedAttachments: (names) =>
          formatMessage(
            { id: "feedback.supplement.uploadedAttachments" },
            { names: names.join("、") },
          ),
      });
      setComment("");
      setAttachments([]);
      await onSubmitted();
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [attachments, comment, feedbackService, formatMessage, onSubmitted, ticketId]);

  return (
    <section className="rounded-lg border border-card-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-ui-base font-semibold tracking-wide text-foreground-subtle">
            {displayTitle}
          </h3>
          <p className="mt-1 text-ui-base leading-5 text-foreground-subtle">
            {displayDescription}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={submitting}
          onClick={() => inputRef.current?.click()}
          className="h-8 shrink-0 rounded-lg px-3"
        >
          <Paperclip />
          {formatMessage({ id: "feedback.supplement.addAttachment" })}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void appendFiles(files);
          }}
        />
      </div>
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onPaste={handlePaste}
        placeholder={formatMessage({ id: "feedback.supplement.placeholder" })}
        rows={3}
        disabled={submitting}
        className="min-h-[82px] resize-y rounded-lg border-input-border bg-input px-3 py-3 text-ui-base text-foreground placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused"
      />
      {attachments.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-foreground-subtle">
                {attachment.kind === "image" ? (
                  <ImageIcon className="size-4" />
                ) : (
                  <FileText className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-base font-medium text-foreground">
                  {attachment.filename}
                </span>
                <span className="mt-0.5 block text-ui-xs text-foreground-subtle">
                  {formatBytes(attachment.size)}
                </span>
              </span>
              <button
                type="button"
                disabled={submitting}
                onClick={() => removeAttachment(attachment.id)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={formatMessage(
                  { id: "feedback.supplement.removeAttachment" },
                  { name: attachment.filename },
                )}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <FeedbackErrorTip message={error} /> : null}
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-ui-xs text-foreground-subtle">
          {formatMessage({ id: "feedback.supplement.attachmentHint" })}
        </span>
        <Button
          size="sm"
          disabled={submitting || (!comment.trim() && attachments.length === 0)}
          onClick={() => void handleSubmit()}
          className="h-8 rounded-lg px-3"
        >
          {submitting ? <Loader2 className="animate-spin" /> : <Send />}
          {submitting
            ? formatMessage({ id: "feedback.supplement.sending" })
            : formatMessage({ id: "feedback.supplement.send" })}
        </Button>
      </div>
    </section>
  );
}

// 用 FileReader 而非 file.arrayBuffer，是为了把 data URL 前缀的剥离集中在一处
// [资源] FileReader 一次性使用，读完即失去引用；组件卸载不会留下需要 abort 的句柄
// [失败路径] onerror 与缺少逗号都 reject，调用方据此整批放弃并展示错误
// 结果非字符串时按空串处理，随后落进逗号缺失分支，避免对 ArrayBuffer 调 indexOf
// [权衡] 直接上传完整 data URL 会把 MIME 重复编码一遍，体积与后端解析成本都上升
// id 只要求会话内唯一，时间戳加随机后缀足够；它不参与持久化，也不作为后端主键
function readSupplementAttachment(file: File): Promise<SupplementAttachmentDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Attachment read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      if (commaIndex < 0) {
        reject(new Error("Invalid attachment data"));
        return;
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        filename: file.name || `attachment-${Date.now()}`,
        contentType: file.type || "application/octet-stream",
        dataBase64: result.slice(commaIndex + 1),
        size: file.size,
        kind: file.type.startsWith("image/") ? "image" : "other",
      });
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}
