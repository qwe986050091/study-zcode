// INV-01 失败态与迁移进度都视为可见：守住位置 可见性组合；改错故障 迁移中没有任何反馈。
// INV-02 未可见时仍渲染静默占位：守住位置 早退分支；改错故障 自动化缺少启动状态锚点。
// INV-03 计时器只在可见且未失败时启动：守住位置 副作用条件；改错故障 静默期每秒重渲染。
// INV-04 计时器必须随条件变化清理：守住位置 清理函数；改错故障 定时器叠加泄漏。
// INV-05 尝试标识变化时清空复制提示：守住位置 第二个副作用；改错故障 上次复制结果残留到新尝试。
// INV-06 已用时长必须有下界 0：守住位置 上下界夹取；改错故障 时钟回拨显示负数。
// INV-07 失败态使用最后更新时间而不是当前时间：守住位置 时间选择；改错故障 失败后计时继续增长。
// INV-08 缺失状态按下发起始态处理：守住位置 阶段兜底；改错故障 文案键为空。
// INV-09 重试入口只由共享判定决定：守住位置 可重试计算；改错故障 不可恢复错误仍显示重试。
// INV-10 复制内容使用完整状态快照：守住位置 序列化入参；改错故障 诊断信息不完整。
// INV-11 复制失败必须给出可见反馈：守住位置 捕获分支；改错故障 用户重复点击无响应。
// INV-12 主标题在失败时使用告警角色：守住位置 角色属性；改错故障 读屏不播报失败。
// INV-13 服务装配阶段失败使用专用文案：守住位置 失败阶段判断；改错故障 用户只看到通用 SQL 错误。
// INV-14 等待锁提示只在等待阶段出现：守住位置 标签与阶段双重判断；改错故障 其他阶段出现锁提示。
// INV-15 长耗时提示只在超过十分钟时出现：守住位置 阈值判断；改错故障 刚启动就提示耗时过长。
// INV-16 诊断行只在失败时展示尝试标识：守住位置 失败判断；改错故障 运行中泄漏内部标识。
// INV-17 退出按钮始终可用：守住位置 无条件渲染；改错故障 卡死时用户无法离开。
// INV-18 标签推导优先级固定：守住位置 startupLabelId；改错故障 迁移与收尾文案互相覆盖。
//
// 模块职责：渲染数据库启动的进度、等待、失败与诊断界面。
// 状态所有权：启动状态来自入参；计时与复制反馈由组件本地持有。
// 阅读顺序：先看可见性与计时，再读复制与早退分支，最后看标签推导。
import { useEffect, useState } from "react";
import { canRetryDatabaseStartup, type DatabaseStartupState } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";

// GlobalDatabaseStartupLoading 的入参只有 state 与 onRetry/onCopy/onExit 三个回调；now 本地每秒刷新用于分钟级计时，copyStatus 分 "copied"/"copyFailed"/null 三态，failed 与 showProgress 共同决定整块是否可见，组件不主动发起任何请求。
export function GlobalDatabaseStartupLoading({
  state,
  onRetry,
  onCopy,
  onExit,
}: {
  state: DatabaseStartupState | null;
  onRetry: () => void;
  onCopy: (details: string) => Promise<void>;
  onExit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(Date.now);
  const [copyStatus, setCopyStatus] = useState<"copied" | "copyFailed" | null>(null);
  const failed = state?.phase === "failed";
  const showProgress = state?.migration !== undefined && state.migration.kind !== "none";
  const visible = failed || showProgress;
  useEffect(() => {
    if (failed || !visible) return;
    // 该 effect 仅在 !failed && visible 时启动 setInterval(() => setNow(Date.now()), 1000)，依赖 [failed, visible]；失败后停止计时并把显示冻结在 state.updatedAt，清理函数 clearInterval(timer) 防止跨状态泄漏定时器，避免在渲染期读时间。
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [failed, visible]);
  useEffect(() => setCopyStatus(null), [state?.attemptId]);
  // elapsed 用 (failed ? state.updatedAt : Math.max(now, state?.updatedAt ?? now)) - (state?.startedAt ?? now) 计算，再 Math.max(0, ...) 夹非负：失败后冻结在 updatedAt，正常运行取 now 与 updatedAt 较大值，缺 startedAt 时以 now 为基准；该值同时驱动分钟数与长耗时提示。
  const elapsed = Math.max(
    0,
    (failed ? state.updatedAt : Math.max(now, state?.updatedAt ?? now)) - (state?.startedAt ?? now),
  );
  const phase = state?.phase ?? "starting";
  const labelId = startupLabelId(state, visible);
  const label = intl.formatMessage({ id: labelId });
  const errorCode = state?.errorCode ?? "sql_failed";
  const canRetry = state ? canRetryDatabaseStartup(state) : false;
  // copy 把 JSON.stringify(state, null, 2) 交给 onCopy，完整状态而非错误摘要；成功 setCopyStatus("copied")，异常 setCopyStatus("copyFailed") 且不 rethrow，避免打断渲染；state?.attemptId 的 effect 会在下次尝试时把 copyStatus 清回 null。
  const copy = async () => {
    try {
      await onCopy(JSON.stringify(state, null, 2));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("copyFailed");
    }
  };
  if (!visible)
    return (
      <RootStartupLoading label={label}>
        <span
          hidden
          data-testid="database-startup-silent"
          data-phase={phase}
          data-database-phase={state?.databasePhase}
        />
      </RootStartupLoading>
    );
  return (
    <RootStartupLoading label={label} busy={!failed}>
      <div
        className="flex w-full max-w-md flex-col items-center gap-3 px-6 text-center"
        data-testid="database-startup-status"
        data-phase={phase}
        data-database-phase={state?.databasePhase}
        data-error-code={state?.errorCode}
      >
        <h1 className="text-ui-lg font-medium" role={failed ? "alert" : undefined}>
          {label}
        </h1>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: failed
              ? state.failedPhase === "starting_services"
                ? "startup.global.servicesFailed"
                : `startup.global.error.${errorCode}`
              : "startup.global.help",
          })}
        </p>
        {!failed && labelId === "startup.global.waiting" ? (
          <p className="text-ui-base">
            {intl.formatMessage({ id: "startup.database.waiting_for_lock" })}
          </p>
        ) : null}
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage(
            { id: "startup.database.elapsed" },
            {
              minutes: Math.floor(elapsed / 60_000),
              seconds: Math.floor(elapsed / 1000) % 60,
            },
          )}
        </p>
        {!failed && elapsed >= 10 * 60_000 ? (
          <p className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "startup.database.longRunning" })}
          </p>
        ) : null}
        {failed ? (
          <p className="break-all text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "startup.global.diagnostic" })}: {state.attemptId}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          {canRetry ? (
            <Button data-testid="database-startup-retry" onClick={onRetry}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          ) : null}
          {failed ? (
            <Button variant="outline" onClick={() => void copy()}>
              {intl.formatMessage({ id: "startup.global.copy" })}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onExit}>
            {intl.formatMessage({ id: "startup.global.exit" })}
          </Button>
        </div>
        {copyStatus ? (
          <p role="status" className="text-ui-caption">
            {intl.formatMessage({ id: `startup.global.${copyStatus}` })}
          </p>
        ) : null}
      </div>
    </RootStartupLoading>
  );
}

/** 迁移提示覆盖本次准备；最后一个库之前不展示保存/收尾，避免跨库倒序。 */
// startupLabelId 的优先级固定：phase === "failed" 先返回 startup.global.failed，!visible 返回 startup.global.silent，starting_services/ready/finalDatabase+ready 归入 finishing，currentMigration 再按种类区分初始化与升级；顺序反了会把失败态显示成静默或收尾。
function startupLabelId(state: DatabaseStartupState | null, visible: boolean): string {
  if (state?.phase === "failed") return "startup.global.failed";
  if (!visible) return "startup.global.silent";
  if (
    state?.phase === "starting_services" ||
    state?.phase === "ready" ||
    (state?.finalDatabase && state.databasePhase === "ready")
  )
    return "startup.global.finishing";
  const current = state?.currentMigration;
  if (state?.databasePhase === "waiting_for_lock" && current && current.kind !== "none")
    return "startup.global.waiting";
  if (
    state?.finalDatabase &&
    state.databasePhase === "committing" &&
    current &&
    current.executedCount > current.committedCount
  )
    return "startup.global.saving";
  return state?.migration?.kind === "initialize"
    ? "startup.global.initializing"
    : "startup.global.upgrading";
}
