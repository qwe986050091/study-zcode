// INV-01 本组件不持有业务状态，扫描、导入、勾选与错误全部由迁移 hook 持有；守住位置：MigrationSection 函数体；改错故障：组件内再存一份候选或勾选，与 hook 派生值漂移，提交的集合与界面不符
// INV-02 能力判定只看 supportState.supported，禁用与提示统一由它派生；守住位置：扫描按钮与三个筛选控件的 disabled；改错故障：Web 端入口仍可点击，发起注定失败的本机扫描
// INV-03 扫描按钮只受能力与 isScanning 约束，导入期间仍可点击，与三处筛选控件不同；守住位置：扫描按钮的 disabled 表达式；改错故障：误以为两者互斥，扫描与导入并发改写同一份勾选
// INV-04 工作区、时间范围、数量上限三个筛选控件在扫描与导入期间同时禁用；守住位置：三处 disabled 表达式；改错故障：请求在飞时改筛选，结果与界面标签对不上
// INV-05 扫描进行中只换图标不换文字，按钮宽度保持不变；守住位置：按钮内的 isScanning 三元；改错故障：文字跳动导致连点落在不同位置
// INV-06 扫描入口用空操作丢弃 Promise，异常由 hook 内部转成 scanError；守住位置：onClick 中的 void 调用；改错故障：外层再加一层错误处理，提示出现两次或永远不出现
// INV-07 扫描失败后 isScanning 由 hook 的 finally 复位，按钮自动回到可点，重试无需额外状态；守住位置：scanError 分支与按钮 disabled；改错故障：失败后按钮永久禁用，只能刷新整页
// INV-08 扫描失败只新增 scanError 提示，不清空已展示的候选与勾选；守住位置：scanError 的告警条件渲染；改错故障：一次失败把用户已经挑好的列表清空
// INV-09 不支持时只渲染一条能力说明，三个筛选控件仍在但全部禁用；守住位置：unsupportedDescription 与 !supported 分支；改错故障：整块隐藏后用户找不到原因，或控件可点却无声失败
// INV-10 不可用原因目前只覆盖 desktopOnly，其他原因渲染空正文；守住位置：supportState.reason 的三元；改错故障：新增原因时提示条只剩标题，没有正文
// INV-11 「当前工作区」选项仅在有工作区时出现，与派生值归一化共用同一份判据；守住位置：hasCurrentWorkspaceFilter 分支；改错故障：选项消失但值仍是 current，下拉显示空白
// INV-12 空字符串工作区被两处判据分别解读：选项可见，写入即归一化为 all；守住位置：hasCurrentWorkspaceFilter 与 setWorkspaceFilterMode；改错故障：用户选了当前工作区，实际检索全部历史
// INV-13 时间范围由 RANGE_OPTIONS 单一数组驱动，文案 key 由选项值拼接；守住位置：RANGE_OPTIONS.map；改错故障：数组与 hook 的时长表脱节，选中值取不到对应时长
// INV-14 数量上限以原始字符串受控，界面显示的不是真正下发的 limit；守住位置：limitInput 与 onChange；改错故障：清空或负数时界面留着原值，请求已回落到默认一百
// INV-15 上限提示中的 max 取自已解析的 scanLimit，不是输入框原文；守住位置：limitHint 的插值；改错故障：提示与真实上限不一致，用户按错误数字估量扫描量
// INV-16 两个下拉的取值都做字面量断言，取值域来自本地常量数组；守住位置：两个 onValueChange；改错故障：新增选项忘记进数组，运行时把非法值写进筛选状态
// INV-17 本组件无 effect 与本地状态，但卸载不会取消 hook 中的异步动作；守住位置：组件函数体与两个 void 调用；改错故障：以为卸载即中止，导入完成仍会建标签并失效缓存
// INV-18 子卡片的导入回调是内联箭头，每次渲染都是新引用，只因它未做记忆化才无开销；守住位置：onImportSelected 属性；改错故障：给子卡片加上 memo 后回调频繁变化，记忆化完全失效
// 本区块只做迁移前的筛选编排：能力说明、三个筛选控件、扫描入口与扫描错误，候选与导入结果交给下方子卡片。
// 迁移读的是本机 ~/.claude/projects，改动前先想清楚扫描失败、导入中途、卸载之后三种情况下界面停在什么状态。
//
import { useMemo } from "react";
import { Loader2, RefreshCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MigrationCandidatesCard } from "@/settings/MigrationCandidatesCard.js";

const RANGE_OPTIONS = ["7d", "30d", "90d", "all"] as const;
const WORKSPACE_FILTER_OPTIONS = ["all", "current"] as const;

// 迁移区块的根组件：入参只有工作区路径、工作区身份与是否桌面，三者在每次渲染时原样转交给 hook
// 组件本身不做能力推断，也不缓存服务实例，所有判定都留在 hook 内单点维护
// 工作区路径可为空，此时「当前工作区」选项不出现，扫描覆盖全部历史
export function MigrationSection({
  workspacePath,
  workspaceIdentity,
  isDesktop,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  // 国际化上下文同时给出文案函数与当前语言标签，后者只被日期格式化器使用
  // 语言标签必须进入格式化器的依赖数组，切换语言后时间列跟着重排
  const { intl, locale } = useZCodeIntl();
  // hook 一次性交出筛选、扫描、勾选与导入的完整接口，本组件只把状态铺到界面上
  // 筛选 setter 直接来自 useState，引用永远稳定；工作区 setter 被包了一层，只随路径变化而重建
  // 动作回调与状态 setter 分开解构，渲染结构里能一眼分清哪些是读、哪些是写
  const {
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    selectedSessionIds,
    selectedCount,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
  } = useClaudeSessionMigration({
    workspacePath,
    workspaceIdentity,
    isDesktop,
  });

  // 日期格式化器按语言缓存，只在 locale 变化时重建，避免候选行逐条新建实例 [资源]
  // 格式化器通过属性下发给子卡片，整页时间列共用同一时区与语言，不会出现两种风格
  // 依赖数组只放 locale：把候选之类的放进去会让每次扫描都重建实例，收益为零 [权衡]
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  // 不可用原因目前只有 desktopOnly 一种，命中才取文案，其余情况渲染空正文
  // 先算成变量再进 JSX，让告警只关心有没有正文，条件判断不散落在结构里
  const unsupportedDescription =
    supportState.reason === "desktopOnly"
      ? intl.formatMessage({ id: "settings.migration.unsupported.desktopOnly" })
      : null;

  return (
    // 整块由一个纵向容器包住：上方筛选卡片，下方候选卡片，两者不共享内部状态
    // 候选卡片始终渲染，能力不可用时由它自己把按钮禁用，区块结构保持不变
    <div className="space-y-6">
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardHeader className="border-b border-border">
          <CardAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              // 扫描按钮只受能力与扫描标记约束，导入进行中并不禁用，与下方三个筛选控件不对称 [并发]
              // 筛选控件在扫描和导入期间都不可改，扫描入口却允许在导入时再触发一次
              // 代价是导入期间再扫描会替换候选并修剪已不存在的勾选，请求本身不写库 [权衡]
              disabled={!supportState.supported || isScanning}
              onClick={() => {
                // 空操作丢弃扫描返回的 Promise，错误已在 hook 内转成 scanError，这里再处理会重复提示 [失败路径]
                // 扫描失败后 hook 的 finally 会复位标记，按钮自动回到可点，重试就是再按一次
                void scan();
              }}
            >
              {isScanning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="size-3.5" />
              )}
              {intl.formatMessage({ id: "settings.migration.scan" })}
            </Button>
          </CardAction>
          <div className="space-y-1">
            <CardTitle>{intl.formatMessage({ id: "settings.migration.filtersTitle" })}</CardTitle>
            <CardDescription>
              {intl.formatMessage({ id: "settings.migration.filtersDescription" })}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-4 py-4">
          {!supportState.supported ? (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>
                {intl.formatMessage({ id: "settings.migration.unsupported.title" })}
              </AlertTitle>
              <AlertDescription>{unsupportedDescription}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.workspaceFilterLabel" })}
              </div>
              <Select
                // 工作区下拉绑定的是 hook 归一化后的派生值，不是本地状态原文
                // 工作区失效时派生值自动落回 all，界面与请求参数始终同源 [事务]
                // 写入时会再做一次归一化，读侧与写侧共用同一个函数，不另写一套判断
                value={workspaceFilterMode}
                // 三处筛选控件共用同一个禁用表达式：能力不可用、扫描中、导入中任一成立即锁定
                // 两个动作都按发起瞬间的筛选参数取数，中途改条件会让结果与界面标签对不上 [事务]
                // 同一表达式在时间范围与数量上限上各出现一次，改其中一处必须同步另两处
                disabled={!supportState.supported || isScanning || isImporting}
                onValueChange={(value) =>
                  setWorkspaceFilterMode(value as (typeof WORKSPACE_FILTER_OPTIONS)[number])
                }
              >
                <SelectTrigger size="lg" className="w-full justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {intl.formatMessage({ id: "settings.migration.workspaceFilter.all" })}
                  </SelectItem>
                  {hasCurrentWorkspaceFilter ? (
                    <SelectItem value="current">
                      {intl.formatMessage({ id: "settings.migration.workspaceFilter.current" })}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.rangeLabel" })}
              </div>
              <Select
                value={range}
                disabled={!supportState.supported || isScanning || isImporting}
                onValueChange={(value) => setRange(value as (typeof RANGE_OPTIONS)[number])}
              >
                <SelectTrigger size="lg" className="w-full justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {intl.formatMessage({ id: `settings.migration.range.${option}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.limitLabel" })}
              </div>
              <Input
                type="number"
                // 数量上限以字符串受控，min 与 max 只约束步进按钮，手输仍可越界
                // 输入框显示的是原始文本，真正下发的是 hook 解析并夹紧后的值
                // 清空或输入负数时界面保留原文，请求已回落到默认一百，差异只在扫描结果里可见 [权衡]
                min={1}
                max={500}
                value={limitInput}
                disabled={!supportState.supported || isScanning || isImporting}
                onChange={(event) => setLimitInput(event.target.value)}
              />
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.migration.limitHint" },
                  // 提示里的上限取自解析后的 scanLimit，与输入框原文可能不同
                  // scanLimit 来自数字输入，产不出「不限」哨兵；哨兵分支只留给 programmatic 调用方
                  { max: String(scanLimit) },
                )}
              </div>
            </div>
          </div>

          {scanError ? (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>
                {intl.formatMessage({ id: "settings.migration.scanFailedTitle" })}
              </AlertTitle>
              <AlertDescription>
                {intl.formatMessage(
                  { id: "settings.migration.scanFailedDescription" },
                  { error: scanError },
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <MigrationCandidatesCard
        supportState={supportState}
        candidates={candidates}
        selectedSessionIds={selectedSessionIds}
        selectedCount={selectedCount}
        importError={importError}
        lastImportResult={lastImportResult}
        isImporting={isImporting}
        dateTimeFormatter={dateTimeFormatter}
        onToggleSelection={toggleSessionSelection}
        onSelectAll={selectAllSessions}
        onClearSelection={clearSelectedSessions}
        onImportSelected={() => {
          // 导入结果由 hook 写回，这里同样空操作丢弃 Promise，失败已经落到 importError
          // 本组件没有任何清理逻辑，卸载后请求仍会跑完并执行建标签与缓存失效 [失败路径]
          void importSelectedSessions();
        }}
      />
    </div>
  );
}
