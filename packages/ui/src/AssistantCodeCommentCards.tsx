// INV-01 空评论列表直接返回空：守住位置 组件首个判断；改错故障 消息流里出现空壳卡片。
// INV-02 标题展示前要剥掉已有的优先级前缀：守住位置 displayTitle；改错故障 徽标与标题重复出现优先级标记。
// INV-03 优先级徽标只对零使用警示色：守住位置 priorityClassName；改错故障 高优先级告警被中性色淹没。
// INV-04 文本选择中点击不触发跳转：守住位置 选择检测与点击处理；改错故障 用户复制路径时被强制打开查看器。
// INV-05 选择检测必须容错：守住位置 区间判断的捕获；改错故障 跨影子边界时点击直接抛错。
// INV-06 折叠状态由本地状态持有，默认折叠：守住位置 isOpen 初值；改错故障 长列表默认展开撑爆消息流。
// INV-07 折叠头必须是无障碍按钮：守住位置 展开态与无障碍标签；改错故障 读屏无法感知展开状态。
// INV-08 展开与收起使用同一条切换路径：守住位置 点击取反；改错故障 状态机出现第三个中间态。
// INV-09 列表容器仅在展开时加分隔线：守住位置 容器类名条件；改错故障 折叠态残留一条空边框。
// INV-10 位置标签的区间只在起止不同时展示：守住位置 行号拼接；改错故障 单行评论显示成区间。
// INV-11 打开查看器用评论源而不是差异源：守住位置 打开函数的类型字段；改错故障 未提交状态成为打开前置条件。
// INV-12 每次打开生成新的请求标识：守住位置 全局序号自增；改错故障 同一评论连续打开时复用旧请求，查看器不刷新。
// INV-13 工作区身份与远程会话标识按存在性展开：守住位置 两处条件展开；改错故障 本地场景带上空身份字段。
// INV-14 仅在有起始行时传评论行号区间：守住位置 区间条件展开；改错故障 查看器定位到文件首行。
// INV-15 行元素用按钮语义且支持回车与空格：守住位置 键盘处理；改错故障 键盘用户无法打开评论。
// INV-16 背景分层必须与 Git 文件行一致：守住位置 父层与内层类名；改错故障 悬浮色替换基础底色，浅色主题下对比度不足。
// INV-17 每行用评论标识作为键：守住位置 列表映射的键；改错故障 列表重排时选中状态错位。
// INV-18 组件不修改传入的评论数据：守住位置 全部读取路径；改错故障 上游快照被就地改写，重渲染不一致。
//
// 模块职责：把助手产出的代码评论渲染成可折叠卡片列表，并负责跳转到代码查看器。
// 状态所有权：展开状态由组件本地持有；评论数据与查看器导航归上游。
// 阅读顺序：先看三个纯函数，再读组件签名与折叠头，最后看展开列表与单行点击路径。
import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getPathLeaf } from "@/lib/path.js";

// 导航请求序号在模块级自增，保证同一评论多次打开得到不同请求标识。
// 查看器据此判断是否需要重新定位，而不是复用上一次的滚动位置。
// 序号只增不减，不做回绕处理，会话生命周期内足够用。
// [权衡] 用模块级变量而非组件引用：跨卡片实例也需要全局唯一。
let navigationRequestSequence = 0;

// 有优先级时才考虑剥离前缀，无优先级直接返回原标题。
// 只剥离 [P{priority}] 形态的前缀，其余方括号内容保持原样。
// 剥离后对 title 再 trimStart，避免标题以空白开头。
// displayTitle 是纯函数，供徽标与标题共用。
function displayTitle(card: AssistantCodeCommentCard): string {
  if (card.priority === undefined) return card.title;
  const prefix = `[P${card.priority}]`;
  return card.title.startsWith(prefix) ? card.title.slice(prefix.length).trimStart() : card.title;
}

function priorityClassName(priority: AssistantCodeCommentCard["priority"]): string {
  if (priority === 0) {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  return "border-border bg-background text-foreground-subtle";
}

// 服务端渲染或没有选择对象时视为未选中。
// 折叠的选择与零区间都视为未选中，减少无谓计算。
// 区间判断可能抛错，捕获后按未选中处理，保证点击不被阻断。
function hasTextSelectionInCard(card: HTMLElement): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  try {
    return selection.getRangeAt(0).intersectsNode(card);
  } catch {
    return false;
  }
}

// 入参包含评论数组与打开查看器所需的全部地址信息。
// 地址字段都是可选的：手机首页等场景只展示不可点击的行。
// 评论数组是只读的，组件不复制也不排序，顺序即上游顺序。
// 返回空而不是空容器，避免宿主布局出现多余间距。
// 组件不订阅任何全局状态，折叠状态完全本地。
export function AssistantCodeCommentCards({
  cards,
  onOpenCodeViewer,
  workspaceIdentity,
  workspacePath,
  workspaceRemoteSessionId,
}: {
  cards: readonly AssistantCodeCommentCard[];
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  workspaceIdentity?: string;
  workspacePath: string;
  workspaceRemoteSessionId?: string;
}) {
  const { intl } = useZCodeIntl();
  const [isOpen, setIsOpen] = useState(false);
  // visibleCards 就是 cards 全量，折叠只影响渲染不影响数据。
  // 单独取名 visibleCards 是为了让后续筛选逻辑有明确落点。
  // isOpen 为真时才 map visibleCards，折叠态不做任何映射。
  const visibleCards = cards;

  if (cards.length === 0) return null;

  return (
    <section
      data-testid="assistant-code-comment-cards"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
    >
      <div
        data-testid="assistant-code-comment-header"
        className="flex h-10 items-center gap-2 px-3 transition-colors hover:bg-hover"
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left"
          aria-expanded={isOpen}
          aria-label={intl.formatMessage(
            {
              id: isOpen ? "chat.codeCommentCards.collapseAll" : "chat.codeCommentCards.expandAll",
            },
            { count: cards.length },
          )}
          onClick={() => setIsOpen((value) => !value)}
        >
          <span
            data-testid="assistant-code-comment-toggle-icon"
            aria-hidden="true"
            className={cn(
              "inline-block size-1.5 shrink-0 -rotate-45 border-r border-b border-foreground-subtlest transition-transform",
              isOpen && "rotate-45",
            )}
          />
          <h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              {
                id: cards.length === 1 ? "chat.codeComments.one" : "chat.codeComments.many",
              },
              { count: cards.length },
            )}
          </h3>
        </button>
      </div>
      <div
        data-testid="assistant-code-comment-list"
        className={cn("flex flex-col", isOpen && "border-t border-border")}
      >
        {isOpen
          ? visibleCards.map((card) => {
              // card.startLine 存在时才拼行号，单行不显示区间。
              // startLine 与 endLine 不同时用短横连接，相同则只显示 startLine。
              // 两者都为空时 locationLabel 退化为纯 displayPath。
              const locationLabel = card.startLine
                ? `${card.displayPath}:${
                    card.endLine && card.endLine !== card.startLine
                      ? `${card.startLine}–${card.endLine}`
                      : card.startLine
                  }`
                : card.displayPath;
              const title = displayTitle(card);
              // 每次打开都生成新请求标识，交给查看器去重与定位。
              // 用评论源：评论描述的是工作区文件，不是未提交差异。
              // 标题沿用剥离前缀后的展示标题，保证卡片与查看器一致。
              // 身份与远程会话标识只在存在时注入，避免空字段污染路由。
              const openReview = () => {
                navigationRequestSequence += 1;
                const requestId = `${card.id}:${navigationRequestSequence}`;
                // 设计原因：模型评论描述的是 workspace 文件，不是 Git diff。直接打开独立的
                // code-review source，既保留远程 workspace 路由，也避免未提交状态成为前置条件。
                onOpenCodeViewer?.({
                  type: "code-review",
                  title: getPathLeaf(card.path),
                  path: card.path,
                  workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
                  review: {
                    requestId,
                    title,
                    body: card.body,
                    ...(card.priority !== undefined ? { priority: card.priority } : {}),
                    ...(card.startLine
                      ? {
                          startLine: card.startLine,
                          endLine: card.endLine ?? card.startLine,
                        }
                      : {}),
                  },
                });
              };

              return (
                <div key={card.id} className="bg-background/50">
                  <div
                    role="button"
                    tabIndex={0}
                    data-code-comment-path={card.displayPath}
                    // Git 文件行把半透明基础面放在父层，hover 放在内层；若把
                    // 两个背景放到同一元素，hover 会替换基础背景而不是在其上叠加，
                    // 浅色主题下对比度几乎不可见。因此这里保持与 Git 文件行相同的分层。
                    className="flex min-h-10 w-full min-w-0 cursor-pointer select-text items-center gap-3 px-6 py-2 text-left whitespace-nowrap transition-colors hover:bg-hover/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    aria-label={intl.formatMessage(
                      { id: "chat.codeCommentCards.openReview" },
                      { title },
                    )}
                    onClick={(event) => {
                      if (hasTextSelectionInCard(event.currentTarget)) return;
                      openReview();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      openReview();
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
                      {card.priority !== undefined ? (
                        <span
                          className={cn(
                            "shrink-0 rounded border px-1.5 py-0.5 text-ui-xs font-medium",
                            priorityClassName(card.priority),
                          )}
                        >
                          P{card.priority}
                        </span>
                      ) : null}
                      <span className="min-w-0 shrink truncate text-ui-base font-medium text-foreground">
                        {title}
                      </span>
                      <span className="min-w-0 shrink truncate text-ui-base text-foreground-subtle">
                        {locationLabel}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          : null}
      </div>
    </section>
  );
}
