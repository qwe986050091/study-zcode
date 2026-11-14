// INV-01 组件只做截图的收集、预览与转发，不持有文件事实；守住位置：FeedbackScreenshotPicker 的 onChange 与 onAddFiles 两个出口；改错故障：组件内部另存截图数组，与父层草稿形成两份真相，提交时漏图。
// INV-02 拖放入口只接受图片；守住位置：handleScreenshotDrop 中对 dataTransfer.files 的 image/ 前缀过滤；改错故障：文本或 PDF 被当作截图读取，得到坏图并占满配额。
// INV-03 空投放必须早退；守住位置：handleScreenshotDrop 中 files.length 为 0 的提前返回；改错故障：以空数组回调父层，触发一次无意义的读取批次并清掉已有错误提示。
// INV-04 拖拽高亮只在真正移出容器时熄灭；守住位置：外层 div 的 onDragLeave 里 currentTarget 与 relatedTarget 的包含判断；改错故障：指针滑过子元素就熄灭，高亮高频闪烁。
// INV-05 进入与悬停都维持高亮；守住位置：外层 div 的 onDragEnter 与 onDragOver 各自阻止默认并置真；改错故障：只处理其中一个，drop 事件收不到，浏览器直接打开被拖入的图片。
// INV-06 文件输入必须先清空值再接续；守住位置：隐藏 input 的 onChange 中先取文件、再置空 value、最后调用 onAddFiles；改错故障：省略置空后连续选择同一文件不再触发变更事件，添加按钮看起来失灵。
// INV-07 读取失败必须拒绝而非空数据；守住位置：readScreenshotDraft 中 reader.onerror 的 reject；改错故障：以空串 resolve，产出类型正常但载荷为空的草稿，直到上传才报错。
// INV-08 data URL 必须含分隔逗号；守住位置：readScreenshotDraft 中 commaIndex 小于 0 的分支；改错故障：缺失逗号时切片越界得到空载荷，缩略图空白且无任何提示。
// INV-09 图像不生成需释放的对象 URL；守住位置：getScreenshotDataUrl 直接用 contentType 与 dataBase64 拼串；改错故障：改用 Blob 链接却不回收，反复选择后内存只增不减。
// INV-10 每条草稿的 id 必须唯一；守住位置：readScreenshotDraft 用时间戳加随机后缀生成 id；改错故障：同毫秒批量选择出现重复 key，删除一张却消失两张。
// INV-11 文件名与类型都要有回落；守住位置：readScreenshotDraft 中 filename 与 contentType 的或运算兜底；改错故障：拖拽或粘贴时名称为空，预览标题与图像替代文本一起变空，读屏丢失说明。
// INV-12 体积取原始文件而非载荷长度；守住位置：readScreenshotDraft 返回对象的 size 字段；改错故障：改用 base64 长度会膨胀约三分之一，上限校验提前误判超限。
// INV-13 删除必须返回新数组；守住位置：removeScreenshot 里对 screenshots 的 filter 与随后的 onChange；改错故障：原地修改再回调，父层引用未变不重渲染，缩略图删不掉。
// INV-14 预览保存的是条目快照；守住位置：缩略图点击回调里把 item 直接交给 setPreviewScreenshot；改错故障：改存索引会在删除后错位显示另一张图，改存 id 则需额外查表且删除后要主动关闭弹窗。
// INV-15 关闭预览必须清空选中；守住位置：Dialog 的 onOpenChange 在 open 为假时置 null；改错故障：只关弹窗不清状态，再次点击同一条目 open 仍为真，弹窗打不开。
// INV-16 弹窗开关由状态派生；守住位置：Dialog 的 open 取 previewScreenshot 的布尔化结果；改错故障：另设布尔开关会出现两个真相，内容已空而弹窗仍开。
// INV-17 缩略图区只在有截图时挂载；守住位置：screenshots.length 大于 0 的三元分支；改错故障：空列表也渲染网格，占位挤压提示文案并在移动端留下大片空白。
// INV-18 删除键必须有可读标签且桌面按需显现；守住位置：ScreenshotThumb 里 removeLabel 的 aria-label 与悬停显现类；改错故障：只剩图标时读屏读不出操作，漏掉键盘聚焦类则键盘用户看不到按钮。
//
// 模块职责：反馈表单中的截图选择器，统一收口拖放与文件选择两种添加方式，展示缩略图、支持删除与点击放大，并按 data URL 把图像以草稿形式交给父层。
// 状态所有权：截图数组归 FeedbackSubmitForm 所有，本组件只持有输入框 ref、待预览条目与拖拽高亮这三个瞬时状态。
// 阅读顺序：先看类型与 props，再看两个 useCallback 收口的用户动作，随后是缩略图网格、提示与添加入口，最后是预览弹窗、缩略图组件与读取工具。
import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { FeedbackSubmissionAttachmentDraft } from "@/feedback/feedbackSubmissionJob.js";
import { ImageIcon, TriangleAlertIcon, XIcon } from "lucide-react";

export interface ScreenshotAttachmentDraft extends FeedbackSubmissionAttachmentDraft {
  id: string;
}

// [来源] 草稿类型继承 feedbackSubmissionJob 的附件契约，本文件只追加 id 作为列表键，不新增序列化字段。
// [契约] 附件字段为 filename、contentType、dataBase64、size 四项，上传时原样编码，缺一项服务端即拒绝。
// [生命周期] 图像自选择起以 base64 常驻内存，不落磁盘、不生成对象 URL，删除或提交成功时随草稿数组释放。
// [边界] 本文件不发起请求也不判断数量上限，读取成功只把草稿交回父层，配额与提示统一在 FeedbackSubmitForm。
// [契约] 组件完全受控：screenshots 是父层草稿的渲染投影，onChange 以整数组覆盖写回，内部不留副本。
// [契约] onAddFiles 只接收原始 File 数组，读取与配额由父层收口，组件不解析附件内容。
// [状态] 本地只有三样东西：输入框 ref、待预览条目、拖拽高亮，前者跨渲染保留，后两者是渲染态。
// [顺序] 删除经 onChange 覆盖写回，新增经 onAddFiles 异步读取后回灌，两条路径最终收敛到父层同一数组。
export function FeedbackScreenshotPicker({
  screenshots,
  screenshotHint,
  screenshotPrivacyHint,
  addScreenshotLabel,
  removeScreenshotLabel,
  onChange,
  onAddFiles,
}: {
  screenshots: ScreenshotAttachmentDraft[];
  screenshotHint: string;
  screenshotPrivacyHint: string;
  addScreenshotLabel: string;
  removeScreenshotLabel: string;
  onChange: (screenshots: ScreenshotAttachmentDraft[]) => void;
  onAddFiles: (files: File[]) => void;
}) {
  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const [previewScreenshot, setPreviewScreenshot] = useState<ScreenshotAttachmentDraft | null>(
    null,
  );
  const [dragActive, setDragActive] = useState(false);

  // [事务] 拖放入口先阻止默认并熄灭高亮，再读取文件列表，顺序反了会让浏览器接管本次投放。
  // [事务] 投放的条目按 image/ 前缀过滤，非图片直接丢弃，不让读取工具去解析文本或 PDF。
  // [失败路径] 过滤后为空必须早退且不回调，空数组会让父层误触发一次无意义的读取批次。
  // [并发] 该回调依赖只有 onAddFiles，父层换引用只会重建函数，不影响已经发出的读取。
  // [事务] 删除按 id 过滤出全新数组再回调，父层因此拿到新引用，列表才会重渲染。
  // [事务] 删除依赖 screenshots 的最新值，若用闭包里的旧列表，会把刚新增的截图一并覆盖掉。
  // [顺序] 容器上的 dragenter、dragover 置真，dragleave 仅在指针真正离开时置假，drop 同时收起高亮并转发。
  const handleScreenshotDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      onAddFiles(files);
    },
    [onAddFiles],
  );

  const removeScreenshot = useCallback(
    (id: string) => {
      onChange(screenshots.filter((item) => item.id !== id));
    },
    [onChange, screenshots],
  );

  return (
    <>
      <div
        tabIndex={0}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragActive(false);
          }
        }}
        onDrop={handleScreenshotDrop}
        className={cn(
          "flex flex-col gap-3 rounded-xl border border-dashed border-border bg-surface p-3 outline-none transition-colors hover:border-border-hover focus-visible:ring-2 focus-visible:ring-primary/30",
          dragActive ? "border-border-hover bg-surface-hover" : "",
        )}
      >
        {screenshots.length > 0 ? (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {screenshots.map((item) => (
              <ScreenshotThumb
                key={item.id}
                item={item}
                removeLabel={removeScreenshotLabel}
                onPreview={() => setPreviewScreenshot(item)}
                onRemove={() => removeScreenshot(item.id)}
              />
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5 text-ui-sm leading-5">
            <div className="flex items-center gap-2 text-foreground-subtle">
              <ImageIcon className="size-3.5 shrink-0" />
              <span className="min-w-0">{screenshotHint}</span>
            </div>
            <div className="flex items-center gap-2 text-feedback-privacy-hint">
              <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{screenshotPrivacyHint}</span>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => screenshotInputRef.current?.click()}
            className="h-7 shrink-0 rounded-lg"
          >
            {addScreenshotLabel}
          </Button>
          <input
            ref={screenshotInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              onAddFiles(files);
            }}
          />
        </div>
      </div>

      <Dialog
        open={Boolean(previewScreenshot)}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewScreenshot(null);
          }
        }}
      >
        <DialogContent className="rounded-xl max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate text-ui-base">
              {previewScreenshot?.filename}
            </DialogTitle>
          </DialogHeader>
          {previewScreenshot ? (
            <div className="max-h-[72vh] overflow-auto rounded-lg border border-border bg-background p-2">
              <img
                src={getScreenshotDataUrl(previewScreenshot)}
                alt={previewScreenshot.filename}
                className="mx-auto max-h-[68vh] max-w-full rounded-md object-contain"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

// [契约] 缩略图是纯展示组件，只接收条目、删除文案与两个动作，不持有状态也不读外部数据。
// [渲染] 图片源由 getScreenshotDataUrl 现场拼接，同一份 base64 既供缩略图也供大图预览。
// `ScreenshotThumb` 的删除按钮同时挂 `aria-label` 与 `title`，读屏与悬停各取所需。
// [权衡] 桌面端默认隐藏删除键，靠 group-hover 与 group-focus-within 显现，触屏无悬停因此常显。
// [渲染] 外层列表项用 group 类承载悬停范围，删除键绝对定位不参与文档流。
function ScreenshotThumb({
  item,
  removeLabel,
  onPreview,
  onRemove,
}: {
  item: ScreenshotAttachmentDraft;
  removeLabel: string;
  onPreview: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="group relative min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={onPreview}
        className="block aspect-square w-full text-left outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary/50"
        title={item.filename}
      >
        <img
          src={getScreenshotDataUrl(item)}
          alt={item.filename}
          className="size-full object-cover"
        />
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-foreground-subtle opacity-90 shadow-sm transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        aria-label={removeLabel}
        title={removeLabel}
      >
        <XIcon className="size-3" />
      </button>
    </li>
  );
}

// [资源] 读取走 FileReader 的 data URL 通道，单次 Promise 包住回调，读完即弃，无需显式关闭。
// [失败路径] 读取错误直接拒绝并给出中文原因，父层捕获后展示，不会产出空载荷草稿。
// [失败路径] 成功回调先确认结果是字符串，再查找分隔逗号，缺逗号即判定格式不正确并拒绝。
// [事务] 通过校验后一次性构造全部字段，id 由时间戳加随机后缀生成，同批次也不会重复。
// [契约] filename 与 contentType 都有回落值，粘贴或无名文件不会留下空标题与空类型。
// [契约] 载荷只取逗号之后的部分，size 沿用原始文件体积，展示与上限判断都不受 base64 膨胀影响。
// [渲染] 末尾的 data URL 组装函数用 contentType 与 dataBase64 拼串，缩略图与预览共用同一份载荷。
// [资源] 全链路不产生对象 URL，因此没有 revoke 时机，释放只依赖草稿数组被父层丢弃。
export function readScreenshotDraft(file: File): Promise<ScreenshotAttachmentDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("截图读取失败"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      if (commaIndex < 0) {
        reject(new Error("截图数据格式不正确"));
        return;
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        filename: file.name || `screenshot-${Date.now()}.png`,
        contentType: file.type || "image/png",
        dataBase64: result.slice(commaIndex + 1),
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

function getScreenshotDataUrl(item: ScreenshotAttachmentDraft) {
  return `data:${item.contentType};base64,${item.dataBase64}`;
}
