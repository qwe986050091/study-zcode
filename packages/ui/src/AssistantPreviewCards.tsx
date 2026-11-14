// INV 不变量表（18 条；破坏任一条都是静默 UI 故障）：
// INV-01 只有校验定稿且可见卡片非空才渲染容器；守住位置：AssistantPreviewCards 的早退分支；改错故障：未定稿的候选先闪出来，随后整块消失
// INV-02 分派按 type 与 kind 两层判别，未知 kind 必须落回通用文件图标；守住位置：Row 的图标三段三元链；改错故障：新增文件类型渲染成空白方块
// INV-03 卡片 key 必须取 card.id，禁止改用下标；守住位置：visibleCards 的 map key；改错故障：删除中间一张后动画延迟与 DOM 状态错位到别的卡片
// INV-04 可见集合与定稿位必须同源于一次校验结果；守住位置：hasCurrentValidation 的合取；改错故障：上一轮 stat 结果配上这一轮卡片，展示已删除的文件
// INV-05 只有语义签名变化才替换校验快照，数组引用变化不得触发 RPC；守住位置：validationCardsRef 的签名比较；改错故障：timeline 每次重建都发一轮批量 stat
// INV-06 无 stat 需求时走同步快路径且定稿位恒为真；守住位置：statFreeVisibleCards 的两个分支；改错故障：纯网站卡消息停在未定稿，卡片永不出现
// INV-07 校验结果必须同时匹配签名与 fileService 才算当前；守住位置：hasCurrentValidation 的双重比较；改错故障：切换 workspace 后沿用旧服务的可见集合
// INV-08 effect 清理后禁止再写状态；守住位置：disposed 标志与两个 then 分支；改错故障：历史消息快速切换时对已卸载组件设置状态
// INV-09 校验失败必须发布空集而不是保留上一次结果；守住位置：then 的失败分支；改错故障：stat 抛错后旧卡片继续显示，用户点开不存在的文件
// INV-10 自动打开 PPTX 只在定稿后消费，且一次性 key 必须含最终卡片签名；守住位置：buildAssistantPreviewPptxAutoOpenRequest 与消费 effect；改错故障：晚到的候选把已消费结果再打开一遍
// INV-11 没有 PPTX 卡片时返回 null 而不是空 sources；守住位置：pptxCards.length 判断；改错故障：宿主收到空请求仍打开一次空面板
// INV-12 网站卡与文件卡的分派由 shouldRenderAssistantPreviewCardAsFile 单点决定，图标与打开目标必须同源；守住位置：该函数与 Row 的两次调用；改错故障：显示地球图标却按文件打开
// INV-13 file 分支的 path 非空由 getAssistantPreviewCardFilePath 保证；守住位置：renderAsFile 与 filePath 的合取；改错故障：path 为空串，预览器打开空白
// INV-14 file 协议的 html 只有允许调用系统浏览器时才降级成文件卡；守住位置：shouldOpenAssistantHtmlInBrowser 取反；改错故障：本地 html 预览被强制塞进代码预览器
// INV-15 网站卡 target 的 localPath 仅对 file 协议生效；守住位置：target 的 website 分支；改错故障：localhost 活服务被当本地文件直开，丢路由与动态内容
// INV-16 传给代码预览器的 source 必须带 workspace 作用域；守住位置：fileSource 与 previewSource；改错故障：远程 Linux 路径被当宿主本地路径打开
// INV-17 标题与副标题只允许单行截断，靠 min-w-0 与 truncate 两处同时成立；守住位置：Row 的文本容器；改错故障：长标题撑破卡片，把右侧按钮挤出可视区
// INV-18 图标是纯装饰，唯一点击目标是注入的 button；守住位置：FileDisplayIcon 的 aria-hidden 与 renderCard；改错故障：读屏重复朗读图标，或卡片本体不可键盘触发
import { FileTextIcon, GlobeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  type AssistantPreviewCard,
  type AssistantPreviewCardFileStatService,
  type AssistantPreviewCardsAutoOpenRequest,
  getAssistantPreviewCardFilePath,
  shouldOpenAssistantHtmlInBrowser,
} from "@/lib/assistantPreviewCards.js";
import {
  getAssistantPreviewCardsValidationSignature,
  resolveAssistantPreviewCardsWithoutFileStat,
  resolveValidatedAssistantPreviewCards,
} from "@/lib/assistantPreviewCardValidation.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";

export interface AssistantPreviewCardValidationResult {
  visibleCards: AssistantPreviewCard[];
  settled: boolean;
}

// [契约] 这里只拼装预览器源对象，不校验路径是否存在，存在性已由调用方的 stat 回合确认。
// workspace 三个字段必须条件展开：写成 undefined 值会在源对象里留下自身属性，宿主按字段存在与否判远程，误判成本地。
// workspaceIdentity 与 workspaceRemoteSessionId 不做互斥取舍，两者同时存在时原样交给宿主去决定优先级。
// 返回值是只读描述，不要在内部补默认标题或归一化路径，标题应保持卡片上的展示文本。
// 调用方是自动打开请求的 sources 映射，一次可能构造十余个源，函数本身保持无副作用。
// [权衡] 没有复用 Row 里同构的字面量，因为那条路径还要叠加 renderAsFile 条件，合并会把两个判断绑死。
// 新增作用域字段时必须同步 Row 的同构对象与 CodeViewerSource 类型，否则自动打开的 PPTX 会缺字段。
// 改错后果：PPTX 自动打开在远程会话里被当成本地路径，编辑器报文件不存在。
export function buildAssistantPreviewCardFileSource(
  card: Extract<AssistantPreviewCard, { type: "markdown" | "file" }>,
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
): CodeViewerSource {
  return {
    type: "file",
    title: card.title,
    path: card.path,
    ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}),
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: scope.workspaceRemoteSessionId }
      : {}),
  };
}

// [契约] 自动打开只挑 type 为 file 且 kind 为 pptx 的卡片，markdown 与网站卡即使路径是 pptx 也不参与。
// [权衡] 用 filter 加类型谓词而不是在 map 里判空，让结果数组元素直接收窄成 file 分支，省掉下游的非空断言。
// 筛选依据是卡片最终形态而不是文件扩展名：大小写与重命名差异已由卡片构建阶段归一，这里不再做后缀匹配。
// baseKey 来自调用方的 turn 标识，本函数只负责把本轮卡片签名并进去，不生成也不缓存 key。
// [失败路径] 该函数自身不抛错，候选为空或全部被过滤时由调用方收到 null 并跳过打开。
// 新增卡片形态只改 `buildAssistantPreviewPptxAutoOpenRequest` 一处：自动打开与可见卡片的筛选口径各自独立。
// 改错后果：把网站卡也算进来时，一次自动打开会顺带拉起浏览器多个标签页。
export function buildAssistantPreviewPptxAutoOpenRequest(
  visibleCards: readonly AssistantPreviewCard[],
  baseKey: string,
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
): AssistantPreviewCardsAutoOpenRequest | null {
  const pptxCards = visibleCards.filter(
    (card): card is Extract<AssistantPreviewCard, { type: "file" }> =>
      card.type === "file" && card.kind === "pptx",
  );
  // [失败路径] 没有 PPTX 时返回 null 而不是空 sources，调用方据此完全不调用宿主接口。
  // 空数组若被当成有效请求，宿主会收到一次无内容的打开动作，可能新建空白窗口或弹出空面板。
  // 判断放在构造对象之前，保证返回值只有 null 或完整请求两种形态，不存在只填了 key 的半成品。
  // 同一 turn 出现多张 PPTX 时全部交给宿主，本函数不设数量上限，上限已在候选构建阶段收口。
  // 入参 `visibleCards` 已是校验后的最终投影，不要再按隐藏标记过滤一遍。
  // 该早退也让下面的签名计算不会对空数组产生固定串，避免空请求混进去重键。
  // 改错后果：宿主把上一次的打开结果当成新结果，重复打开同一份演示文稿。
  if (pptxCards.length === 0) return null;

  return {
    // stat 结果对应的最终卡片签名必须进入一次性 key；同一 turn 的候选若晚到，
    // 不会把旧的校验投影误当成已经消费的新结果。
    key: JSON.stringify([baseKey, getAssistantPreviewCardsValidationSignature(pptxCards)]),
    sources: pptxCards.map((card) => buildAssistantPreviewCardFileSource(card, scope)),
  };
}

interface AssistantPreviewCardsProps {
  cards: AssistantPreviewCard[];
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop 完成态生成产物：批量打开本轮已通过校验的 PPTX。 */
  autoOpenPptxKey?: string;
  onAutoOpenPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  compactForRemoteControl?: boolean;
}

export function shouldRenderAssistantPreviewCardAsFile(
  card: AssistantPreviewCard,
  scope: {
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
    compactForRemoteControl?: boolean;
  },
): boolean {
  const filePath = getAssistantPreviewCardFilePath(card);
  return (
    // [契约] 返回 true 表示按文件卡处理，false 表示按网站卡处理，这条分派只允许由本函数决定。
    // 网站卡默认走浏览器；只有 file 协议的 html 且当前环境不适合开浏览器时才降级成文件卡。
    // http 或 https 的网站卡不看 filePath，直接返回 false，交给浏览器分支。
    // filePath 判空是必要的第二道闸：URL 是 file 链接但解析不出路径时，降级成文件卡会打开空源。
    // [权衡] 并集判断不拆早退：`shouldRenderAssistantPreviewCardAsFile` 的图标与打开目标两处调用必须拿到同一个布尔值。
    // compactForRemoteControl 参与判定：远控紧凑模式没有系统浏览器，必须落到内置预览。
    // 新增卡片形态时先在这里补分支再改 Row，顺序反了会先出现一次形态错配。
    // 改错后果：图标显示地球而点击走文件打开，用户看到的形态与真实行为不一致。
    card.type !== "website" ||
    (card.url.startsWith("file://") &&
      filePath !== null &&
      !shouldOpenAssistantHtmlInBrowser({ path: filePath, ...scope }))
  );
}

export function useAssistantPreviewCardValidation(
  cards: AssistantPreviewCard[],
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  } = {},
): AssistantPreviewCardValidationResult {
  const { fileService } = useWorkspaceServices(
    scope.workspacePath,
    scope.workspaceRemoteSessionId,
    scope.workspaceIdentity,
  );
  // [契约] 签名是卡片的语义身份，覆盖 id、type、kind、标题、副标题键与路径，不覆盖数组引用。
  // 下游的 ref 比较与结果发布都以签名为准，任何展示字段变化都必须进签名，否则卡片内容不刷新。
  // [权衡] 每次渲染重算一次字符串比深比较便宜，长度与卡片数成正比，且避免把引用相等与内容相等混为一谈。
  // useMemo 依赖数组本身，只有数组引用变化才重算；timeline 复用同一数组时连拼接都省掉。
  // 不要把签名缓存到模块作用域，跨会话的卡片会污染同一份字符串。
  // 签名用不可见分隔符拼接，普通可见字符可能出现在标题里，会让两组不同卡片拼出相同签名。
  // stat 结果比对与自动打开 key 都复用它，改签名口径等于同时改这两处的一致性前提。
  // 改错后果：标题被上游修订而签名未变时，可见卡片停留在旧标题，直到下一次真实变化才更正。
  const cardsSignature = useMemo(() => getAssistantPreviewCardsValidationSignature(cards), [cards]);
  const validationCardsRef = useRef({ cards, signature: cardsSignature });
  // timeline 重建时会传入内容相同但引用不同的 cards 数组，effect 若依赖数组引用会重复发起 RPC。
  // 只在语义签名变化时替换校验快照；workspace fileService 变化仍会使用同一快照重新校验。
  if (validationCardsRef.current.signature !== cardsSignature) {
    validationCardsRef.current = { cards, signature: cardsSignature };
  }
  const validationCards = validationCardsRef.current.cards;
  // [契约] 该 memo 返回数组表示无需 stat 即可定稿的可见卡片，返回 null 表示存在需要 stat 的候选。
  // 两种返回值含义完全不同，调用方用真值分流，空数组也是有效结果，不能被当成 null。
  // 快路径只保留合法网站卡并截断到可见上限，文件卡一律视为需要 stat，即使它指向的文件确实存在。
  // [权衡] 没有在这里顺带做路径去重，去重已在卡片构建阶段按路径完成，重复过滤只会多一次遍历。
  // 依赖收敛到校验快照而不是 props 的 cards，避免引用抖动把快路径也重算一遍。
  // [失败路径] 快路径不做任何 IO，因此不会抛错，也不会产生需要清理的订阅。
  // 新增免 stat 的卡片形态时要同步修改无障碍快照解析函数，两处口径必须一致。
  // 改错后果：把 null 与空数组合并成一个返回类型，纯网站卡消息会掉进异步分支，卡片晚一拍出现。
  const statFreeVisibleCards = useMemo(
    () => resolveAssistantPreviewCardsWithoutFileStat(validationCards),
    [validationCards],
  );
  const [validationResult, setValidationResult] = useState<{
    fileService: AssistantPreviewCardFileStatService | null;
    signature: string;
    visibleCards: AssistantPreviewCard[];
  }>(() => ({
    fileService: null,
    signature: "",
    visibleCards: [],
  }));

  useEffect(() => {
    if (statFreeVisibleCards) {
      return;
    }

    let disposed = false;

    // 历史消息切换时，上一条消息的已通过 stat 结果会在 effect 清理前短暂复用。
    // 这里按当前候选签名批量二次校验，全部算完后一次发布，避免文件卡先闪一批再被替换。
    void resolveValidatedAssistantPreviewCards(validationCards, fileService).then(
      (visibleCards) => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards,
        });
      },
      () => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards: [],
        });
      },
    );

    return () => {
      disposed = true;
    };
  }, [cardsSignature, fileService, statFreeVisibleCards, validationCards]);

  if (statFreeVisibleCards) {
    return {
      visibleCards: statFreeVisibleCards,
      settled: true,
    };
  }

  const hasCurrentValidation =
    validationResult.fileService === fileService && validationResult.signature === cardsSignature;

  return {
    visibleCards: hasCurrentValidation ? validationResult.visibleCards : [],
    settled: hasCurrentValidation,
  };
}

export function AssistantPreviewCards({
  cards,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  autoOpenPptxKey,
  onAutoOpenPptx,
  compactForRemoteControl,
}: AssistantPreviewCardsProps) {
  const { intl } = useZCodeIntl();
  const { visibleCards, settled } = useAssistantPreviewCardValidation(cards, {
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });

  useEffect(() => {
    if (!settled || !autoOpenPptxKey || !onAutoOpenPptx) return;

    const request = buildAssistantPreviewPptxAutoOpenRequest(visibleCards, autoOpenPptxKey, {
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    });
    if (!request) return;

    // 自动打开只能消费最终可见卡片；这样与 15 个候选、10 张上限和 Host stat
    // 完全同源，不会打开卡片中并不存在的文件。
    onAutoOpenPptx(request);
  }, [
    autoOpenPptxKey,
    onAutoOpenPptx,
    settled,
    visibleCards,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);

  // [契约] 未定稿或可见卡片为空时返回 null，连外层 flex 容器一起不渲染。
  // 空数组仍渲染容器会在消息气泡下方留下一条空白带，因为间距与内边距都挂在容器上，看上去像渲染残留。
  // 这里同时挡住未定稿的中间态，避免先出现一批随后被校验剔除的卡片。
  // [权衡] 没有在容器位置放骨架占位，校验通常在数十毫秒内完成，占位反而造成二次布局跳动。
  // 返回 null 不影响上面的自动打开 effect，那个 effect 自己判断定稿位，不依赖本分支的渲染结果。
  // 不要把判断简化成只检查长度，未定稿时可见集合恒为空数组，长度检查会掩盖真正的状态位。
  // [权衡] 容器未声明列表角色，卡片本体也不是列表项语义，读屏只能逐张朗读标题与副标题。
  // 改错后果：整个预览区在消息切换瞬间闪一下容器边框，随后消失。
  if (!settled || visibleCards.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {visibleCards.map((card, index) => (
        <AssistantPreviewCardRow
          // [契约] key 取 card.id，由构建阶段按 type 与路径拼成，跨形态唯一。
          // 不要改成下标：可见集合来自 stat 过滤，删掉中间一项会让后续卡片复用前一张的动画延迟与 DOM 状态。
          // id 里已含 kind 前缀，同一路径在网站、markdown、文件三种形态间不会互相覆盖。
          // [权衡] 不用路径作 key，因为网站卡的 id 有 URL 与 file URL 两种来源，路径解析可能失败。
          // key 变化会让卡片重建而不是更新，入场动画会重播；这是一次性产物展示，重播是预期行为。
          // 入场延迟按序号递增并封顶 240ms，key 稳定才能让延迟与卡片一一对应。
          // 若上游出现重复 id，React 只会告警并留下不可预测的复用，构建阶段的去重键必须与 id 同源。
          key={card.id}
          card={card}
          animationDelayMs={Math.min(index * 36, 240)}
          subtitle={intl.formatMessage({ id: card.subtitleId })}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenFileLink={onOpenFileLink}
          onOpenCodeViewer={onOpenCodeViewer}
          compactForRemoteControl={compactForRemoteControl}
        />
      ))}
    </div>
  );
}

function AssistantPreviewCardRow({
  card,
  animationDelayMs,
  subtitle,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  compactForRemoteControl,
}: {
  card: AssistantPreviewCard;
  animationDelayMs: number;
  subtitle: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  compactForRemoteControl?: boolean;
}) {
  const filePath = getAssistantPreviewCardFilePath(card);
  const renderAsFile = shouldRenderAssistantPreviewCardAsFile(card, {
    workspaceIdentity,
    workspaceRemoteSessionId,
    compactForRemoteControl,
  });
  const descriptor = filePath ? resolveFileDisplayDescriptor(filePath) : null;
  const fileSource =
    renderAsFile && filePath
      ? {
          type: "file" as const,
          title: card.title,
          path: filePath,
          ...(workspacePath ? { workspacePath } : {}),
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
        }
      : null;
  return (
    <OpenSplitButton
      renderCard={(button) => (
        <div
          className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground"
          data-preview-card-title={card.title}
          data-zcode-stream-animate="true"
          style={
            {
              "--zcode-stream-animation-delay": `${animationDelayMs}ms`,
            } as CSSProperties
          }
        >
          <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
            {!renderAsFile && card.type === "website" ? (
              <GlobeIcon className="size-6" />
            ) : descriptor ? (
              <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
            ) : (
              <FileTextIcon className="size-6" />
            )}
          </div>
          <div className="min-w-0 flex flex-1 flex-col gap-1">
            <div className="truncate text-ui-base font-medium leading-5">{card.title}</div>
            <div className="truncate text-ui-base leading-5 text-foreground-subtlest">
              {subtitle}
            </div>
          </div>
          {button}
        </div>
      )}
      target={
        !renderAsFile && card.type === "website"
          ? {
              type: "website",
              url: card.url,
              // website 卡有两个来源——html 引用卡（file://）与 localhost
              // 预览卡（http(s) 活服务）。localPath 直开只对前者生效；localhost 卡
              // 必须继续把 URL 交给浏览器，否则丢路由/动态内容。
              workspacePath,
              localPath: card.url.startsWith("file:") ? card.filePath : undefined,
            }
          : {
              type: "file",
              path: filePath!,
              title: card.title,
              label: card.title,
              // Preview Card 以前没有 CodeViewer scope，远程 Linux path
              // 会被 OpenSplitButton 当成本地路径交给宿主编辑器。
              previewSource:
                card.type === "website"
                  ? fileSource!
                  : buildAssistantPreviewCardFileSource(card, {
                      workspacePath,
                      workspaceIdentity,
                      workspaceRemoteSessionId,
                    }),
            }
      }
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenFileLink={onOpenFileLink}
      onOpenCodeViewer={onOpenCodeViewer}
    />
  );
}
