// MigrationCandidatesCard.tsx —— Claude 原生历史迁移的候选列表卡片：勾选、全选、批量导入与结果回显
//
// INV-01 本组件是纯受控视图，勾选集合、导入中标志、错误与上次结果全部由父 hook 持有，组件内没有 useState 与本地镜像；守住位置：MigrationCandidatesCard 函数体；改错故障：本地副本与父状态分叉，徽标计数与实际提交的 sessionId 集合不一致
// INV-02 selectedCount 必须恒等于 selectedSessionIds 的长度；守住位置：两个徽标与三个操作按钮的 disabled 表达式；改错故障：按钮可点但没有任何 id 被提交，或列表已无勾选仍允许发起导入
// INV-03 candidates 必须按 sessionId 唯一，组件直接用该字段做 React key 与勾选判据；守住位置：候选行 map 与 isSelected 计算；改错故障：同 id 两行共享 key 与勾选态，点击一行会连带选中另一行
// INV-04 勾选判定只认 sessionId，不认 provider 与 workspacePath；守住位置：isSelected 计算与 onToggleSelection 调用；改错故障：跨 workspace 同 id 的会话无法分别取消，父层按 id 精选时误删另一个工作区的勾选
// INV-05 全选语义是「用候选全集整体替换选中集合」，不是并集累加；守住位置：onSelectAll 对应的按钮；改错故障：二次全选保留已不在候选里的旧 id，提交时混入界面上不可见的会话
// INV-06 三个操作按钮都以 supportState.supported 为前置条件，能力不可用时一律禁用；守住位置：selectAll 与 importSelected 的 disabled；改错故障：非桌面端发起必然失败的导入，并把平台缺能力当成可重试错误展示给用户
// INV-07 行内点击只看 isImporting，不看 supportState，与按钮闸门并不对称；守住位置：候选行 button 的 disabled；改错故障：能力不可用时仍能勾选，计数变化却没有任何出口，用户误以为迁移可用
// INV-08 导入进行中必须同时关闭行点击与三个按钮，提交的是点击瞬间的选中快照；守住位置：isImporting 在所有 disabled 上的出现；改错故障：请求携带旧快照而界面勾选已变化，导入内容与用户所见不符
// INV-09 防重入不能只靠 isImporting，父层 importSessions 没有导入中判断；守住位置：importSelected 的 onClick 与父层入口；改错故障：同一事件循环内的连点各发一次请求，同一批 session 被提交两次并产生重复任务
// INV-10 imported、skipped、failed 三桶互斥，且并集覆盖本次提交的全部 id；守住位置：resultSummary 的三个计数；改错故障：三个数字与选中数对不上，用户无法判断是否还有会话没有落地
// INV-11 导入成功返回后父层会从选中集合里剔除三桶中出现的 id，卡片只负责按新集合重渲染；守住位置：lastImportResult 出现后行的勾选态；改错故障：已处理的会话保持勾选，再次导入全部落入 skipped
// INV-12 lastImportResult 只在成功返回时写入，且只被下一次成功导入覆盖，扫描与筛选都不清空它；守住位置：lastImportResult 条件渲染；改错故障：结果面板描述的会话已不在当前列表，用户把历史结果当成本次扫描结论
// INV-13 importError 与 lastImportResult 可以同时存在，两个 Alert 并列而不是互相覆盖；守住位置：CardContent 内两个 Alert 的独立条件；改错故障：失败时隐藏上一次成功结果，用户以为整批已回滚
// INV-14 候选为空同时意味着「从未扫描」「正在扫描」「扫描后为空」三种语义，组件不做区分；守住位置：candidates.length 决定空态占位；改错故障：扫描进行中显示「没有可迁移会话」，用户提前放弃等待
// INV-15 skipped 与 failed 明细行的 key 由 provider、sessionId、reason 三段构成；守住位置：ImportIssuesList 的 key 表达式；改错故障：同会话同原因重复出现时 key 冲突，React 复用节点后把上一条的 workspacePath 显示到这一条
// INV-16 明细项的 workspacePath 是可选的，缺失时只省略路径的两行、不省略 provider 与跳过原因；守住位置：ImportIssuesList 内两处 workspacePath 条件；改错故障：没有路径的失败项被整条隐去，用户看不到失败原因
// INV-17 所有用户可见文案都来自 intl，未知 reason 原样回退为服务端码而不是变成空白；守住位置：getKnownReasonLabel 与各处 formatMessage；改错故障：新增原因码时界面留白，用户无法判断会话被跳过的原因
// INV-18 时间戳只通过父层注入的 dateTimeFormatter 格式化，组件内不新建 Intl.DateTimeFormat；守住位置：updatedAt 渲染；改错故障：逐行新建格式化器拖慢长列表，且时区与语言可能和页面其余部分不一致
import { Check, Download, Loader2, TriangleAlert } from "lucide-react";
import type {
  ZCodeImportSessionsResult,
  ZCodeImportableSessionCandidate,
  ZCodeImportedSessionSkippedItem,
} from "@zcode/shared";
import type { ClaudeSessionMigrationSupportState } from "@/hooks/useClaudeSessionMigration.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

// 把服务端的原因码翻成当前语言，只认识 session_not_found_or_workspace_mismatch 这一个已知码
// 未知原因原样返回而不是返回空串：新增原因码时用户至少能看到可检索的英文标识，便于反馈
// 回退分支不能改成抛错或占位符：跳过项是批量导入的正常结果，一条未知码不该让整张结果卡渲染失败
// [失败路径] 已知码与 i18n key 一一对应，译文缺失由 intl 层兜底，这里不做二次判断
// reason 来自上一次导入的服务端返回，可能是旧版本写入的值，因此不能按联合类型穷举
function getKnownReasonLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  reason: string,
): string {
  if (reason === "session_not_found_or_workspace_mismatch") {
    return intl.formatMessage({
      id: "settings.migration.reason.session_not_found_or_workspace_mismatch",
    });
  }

  return reason;
}

function ImportIssuesList({
  title,
  items,
}: {
  title: string;
  items: ZCodeImportedSessionSkippedItem[];
}) {
  const { intl } = useZCodeIntl();

  // 该桶为空时整块不渲染，返回 null 而不是空 div
  // [权衡] 父层固定渲染 skipped 与 failed 两列，空桶仍占一格，换来两列标题在有无明细时不对齐跳动
  // 不渲染「无」占位文案：imported 桶本来就不展示明细，空桶再补一句只会让结果区更吵
  // 长度判断放在 map 之前而不是在 map 内部过滤，避免空数组也生成外层容器与标题
  // 组件自行调用 useZCodeIntl 而不从 props 接收 intl 实例，保证标题与正文共用同一语言上下文
  // 提前返回位于 hooks 调用之后，不改变 hooks 顺序，因此条件返回是安全的
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <div className="space-y-2">
        {items.map((item) => (
          <div
            // 明细行 key 由 provider、sessionId、reason 三段拼成，刻意不用数组下标
            // 同一次导入里同一会话可能分属 skipped 与 failed，也可能因不同原因重复出现，reason 必须进 key
            // workspacePath 只影响两行文本，放进 key 会让路径变化时整行卸载重建
            // [权衡] 若同 provider 同 id 同 reason 真重复，key 冲突会让 React 复用节点，把上一条的路径显示到这一条
            // 因此上游返回的两个桶在同桶内必须去重，这一约束由服务层保证，本组件不校验
            // 列表只读且不进状态，key 只服务于协调，不参与任何选中与提交逻辑
            // key 不带桶名前缀：两桶分别挂在不同的父节点下，兄弟集合本就隔离
            key={`${item.provider}-${item.sessionId}-${item.reason}`}
            className="rounded-lg border border-border bg-background px-3 py-2"
          >
            <div className="font-mono text-ui-base text-foreground">{item.sessionId}</div>
            {item.workspacePath ? (
              <div className="mt-1 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "settings.migration.workspacePathLabel" })}
              </div>
            ) : null}
            {item.workspacePath ? (
              <div className="break-all font-mono text-ui-xs text-foreground-subtlest">
                {item.workspacePath}
              </div>
            ) : null}
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {getKnownReasonLabel(intl, item.reason)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 受控视图：选中集合、导入中标志、错误与上次结果全部由父 hook 持有，本组件不持有任何状态
// selectedSessionIds 只用于逐行判断是否选中，selectedCount 用于徽标与按钮闸门，两者必须同源
// [权衡] 计数单独传入而不在此对数组求长度，是为了让父层用同一份派生值驱动按钮，代价是存在两值漂移的风险
// 回调除 onToggleSelection 需要 sessionId 外都不带参数，导入目标集合由父层在点击时自行读取
// dateTimeFormatter 由父层注入，避免每行各建一个格式化器，也让整页时区与语言保持一致
// supportState 只承载能力开关，其 reason 字段当前不参与渲染
// isImporting 同时关闭行点击与三个按钮，是本组件唯一的写屏障
// 组件不回传结果：导入产物只经 lastImportResult 回流，父层是唯一事实来源
export function MigrationCandidatesCard({
  supportState,
  candidates,
  selectedSessionIds,
  selectedCount,
  importError,
  lastImportResult,
  isImporting,
  dateTimeFormatter,
  onToggleSelection,
  onSelectAll,
  onClearSelection,
  onImportSelected,
}: {
  supportState: ClaudeSessionMigrationSupportState;
  candidates: ZCodeImportableSessionCandidate[];
  selectedSessionIds: string[];
  selectedCount: number;
  importError: string | null;
  lastImportResult: ZCodeImportSessionsResult | null;
  isImporting: boolean;
  dateTimeFormatter: Intl.DateTimeFormat;
  onToggleSelection: (sessionId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onImportSelected: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Card className="border border-border bg-card py-0 shadow-none">
      <CardHeader className="border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>
                {intl.formatMessage({ id: "settings.migration.candidatesTitle" })}
              </CardTitle>
              <Badge variant="outline">
                {intl.formatMessage(
                  // 两个徽标分别是扫描到的候选总数与当前选中数，数字都直接取自 props
                  // 总数用 candidates.length 而不是选中集合长度，两者语义不同，不能互相推导
                  // 计数先转成字符串再交给 formatMessage，占位符只做插值，不触发本地化的数字分组
                  // 选中数大于总数在当前实现里不该出现，组件不做截断，出现即说明父层状态已经漂移
                  // [权衡] 徽标不提示扫描上限：截断由父层 limit 控制，本组件看不到被截掉的候选
                  // 标题、描述与徽标共处一个 flex-wrap 容器，窄宽度下换行而不是溢出
                  { id: "settings.migration.candidatesCount" },
                  { count: String(candidates.length) },
                )}
              </Badge>
              <Badge variant="outline">
                {intl.formatMessage(
                  { id: "settings.migration.selectedCount" },
                  { count: String(selectedCount) },
                )}
              </Badge>
            </div>
            <CardDescription>
              {intl.formatMessage({ id: "settings.migration.candidatesDescription" })}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              // 全选按钮的三个禁用条件分别是：能力不可用、没有任何候选、导入进行中
              // 全选写入候选全集，父层按 sessionId 映射成数组并整体替换旧集合，因此重复点击结果不变
              // [权衡] 用替换而非并集，代价是清掉用户此前的部分勾选，换来「全选」在任何时刻都可预测
              // 清空按钮只看选中数与导入中状态，不看 supportState：能力不可用时清掉旧勾选仍是有意义的动作
              // 导入按钮额外要求选中数大于零，否则父层收到空数组会直接返回 null，界面没有任何反馈
              // [失败路径] 按钮禁用只覆盖常规路径，父层入口没有导入中判断，连点仍可能各触发一次请求
              // 按钮图标随 isImporting 在旋转图标与下载图标之间切换，文字不变，保证点击位置前后不跳动
              // 三个按钮都显式标注 type=button，避免被外层表单当作提交按钮
              disabled={!supportState.supported || candidates.length === 0 || isImporting}
              onClick={onSelectAll}
            >
              {intl.formatMessage({ id: "settings.migration.selectAll" })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={selectedCount === 0 || isImporting}
              onClick={onClearSelection}
            >
              {intl.formatMessage({ id: "settings.migration.clearSelection" })}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!supportState.supported || selectedCount === 0 || isImporting}
              onClick={onImportSelected}
            >
              {isImporting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {intl.formatMessage({ id: "settings.migration.importSelected" })}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 py-4">
        {importError ? (
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertTitle>
              {intl.formatMessage({ id: "settings.migration.importFailedTitle" })}
            </AlertTitle>
            <AlertDescription>
              {intl.formatMessage(
                { id: "settings.migration.importFailedDescription" },
                { error: importError },
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {lastImportResult ? (
          <Alert>
            <Check className="size-4" />
            <AlertTitle>{intl.formatMessage({ id: "settings.migration.resultTitle" })}</AlertTitle>
            <AlertDescription>
              {intl.formatMessage(
                // 结果条只汇总三桶数量，具体到哪条会话由下方的 skipped 与 failed 明细承担
                // imported 只计数不列表：成功的会话已经出现在任务列表里，再列一遍会把结果区撑长
                // 三个计数取自同一次返回，任一桶为空也照样显示 0，便于用户确认没有遗漏
                // lastImportResult 只在成功返回后写入，扫描与筛选不会清空它
                // [权衡] 因此结果条可能描述已经不在候选列表里的会话，这里是只读展示，不参与勾选与提交
                // 下方两列固定渲染，即便某一桶为空，列宽与标题位置也保持一致
                { id: "settings.migration.resultSummary" },
                {
                  imported: String(lastImportResult.imported.length),
                  skipped: String(lastImportResult.skipped.length),
                  failed: String(lastImportResult.failed.length),
                },
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {candidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-background px-4 py-8 text-center">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.migration.emptyTitle" })}
            </div>
            <div className="mt-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.migration.emptyDescription" })}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {candidates.map((candidate) => {
              // 选中态唯一来源于选中集合的成员判断，边框、底色与勾选方块都由它派生
              // 同一份 isSelected 同时驱动行容器与勾选方块，不存在两处独立计算导致外观不一致
              // [权衡] 逐行线性查找是候选数乘选中数的开销，候选上限由扫描 limit 控制在数百级，换成 Set 会让父层多维护一份派生结构
              // 成员判断只比 sessionId，不看 provider 与 workspacePath，跨 workspace 的同 id 会话无法分别勾选
              // 这里要求 candidates 内部 sessionId 唯一：重复 id 会让两行同时高亮，并在父层被同一次切换同时增删
              // 行没有单独的禁用标志，唯一会阻止点击的是 isImporting，能力不可用时行仍然可勾选
              // 切换交由父层处理，组件不预判切换结果，也不做乐观的本地更新
              // 整行即切换区域，勾选方块不是独立控件，避免出现嵌套按钮与双重点击语义
              const isSelected = selectedSessionIds.includes(candidate.sessionId);

              return (
                <button
                  // 行 key 用 sessionId 而不是数组下标：每次扫描都返回全新对象，下标会让行在筛选变化时错位复用
                  // [资源] 稳定的 key 让滚动位置、hover 与焦点在重扫后仍停留在同一个会话上，而不是跳到相邻行
                  // key 与勾选判据共用同一字段，因此「是哪一行」和「有没有选中」不会引用两个不同的身份
                  // 若候选里出现重复 sessionId，React 会告警并可能丢弃其中一行，用户会看到少一条却无法解释
                  // key 不含 provider：当前只有一个来源 provider，接入第二个来源前必须改成复合 key
                  // 外层列表容器不带 key，重排只影响行节点本身
                  key={candidate.sessionId}
                  type="button"
                  disabled={isImporting}
                  className={cn(
                    "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                    isSelected
                      ? "border-primary bg-accent"
                      : "border-border bg-background hover:bg-surface",
                  )}
                  onClick={() => onToggleSelection(candidate.sessionId)}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-input text-transparent",
                      )}
                    >
                      <Check className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1 text-ui-base font-medium text-foreground">
                          <span className="line-clamp-1 break-all">
                            {candidate.previewTitle || candidate.sessionId}
                          </span>
                        </div>
                        <Badge variant="outline" className="font-mono">
                          {candidate.sessionId.slice(0, 8)}
                        </Badge>
                      </div>
                      <div className="grid gap-2 text-ui-base text-foreground-subtle grid-cols-[minmax(0,1fr)_auto] items-center">
                        <div className="min-w-0 space-y-1">
                          <div className="font-mono text-ui-xs text-foreground-subtle">
                            {candidate.sessionId}
                          </div>
                          <div className="text-ui-xs text-foreground-subtle">
                            {intl.formatMessage({ id: "settings.migration.workspacePathLabel" })}
                          </div>
                          <div className="break-all font-mono text-ui-xs text-foreground-subtlest">
                            {candidate.workspacePath}
                          </div>
                          <div className="line-clamp-1 break-all font-mono text-ui-xs text-foreground-subtlest">
                            {candidate.sourcePath}
                          </div>
                        </div>
                        <div className="text-right text-ui-xs text-foreground-subtle">
                          {intl.formatMessage(
                            { id: "settings.migration.updatedAt" },
                            { time: dateTimeFormatter.format(candidate.updatedAt) },
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {lastImportResult ? (
          <div className="grid grid-cols-2 gap-4">
            <ImportIssuesList
              title={intl.formatMessage({ id: "settings.migration.skippedTitle" })}
              items={lastImportResult.skipped}
            />
            <ImportIssuesList
              title={intl.formatMessage({ id: "settings.migration.failedTitle" })}
              items={lastImportResult.failed}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
