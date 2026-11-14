// INV-01 有界投影：守住位置 PAGE_SIZE 与分页切片；改错故障：全量记录一次挂载，长会话直接卡死。
// INV-02 轮询归视图：守住位置 组件内的定时器；改错故障：采集生命周期被挪进页面，窗口切换后采集中断。
// INV-03 卸载即停：守住位置 disposed 标记；改错故障：卸载后仍安排下一轮请求。
// INV-04 代际防旧：守住位置 generation 的比较；改错故障：清空前的在途快照覆盖新状态。
// INV-05 清空先递增：守住位置 generation 自增的位置；改错故障：递增晚于清空，旧快照仍能写回。
// INV-06 清空期停轮询：守住位置 clearing 判断；改错故障：清空过程中的快照把列表又填满。
// INV-07 失败可恢复：守住位置 成功分支里的复位；改错故障：一次失败后再也不显示数据。
// INV-08 失败不炸页：守住位置 捕获分支；改错故障：桥接异常冒泡到渲染树。
// INV-09 桥缺失降级：守住位置 未传桥接时的文案；改错故障：页面空白且没有任何说明。
// INV-10 页号收敛：守住位置 当前页与总页数的取小；改错故障：筛选后页号越界显示空表。
// INV-11 筛选即回首页：守住位置 onChange 里的重置；改错故障：过滤后停在旧页看不到结果。
// INV-12 倒序稳定：守住位置 toSorted 的次键；改错故障：同毫秒记录顺序跳动。
// INV-13 计数含丢弃：守住位置 计数文案的两个参数；改错故障：丢弃条数不展示，用户以为采全了。
// INV-14 文案走字典：守住位置 label 函数；改错故障：界面出现硬编码语言。
// INV-15 时间本地化：守住位置 timeFormat 的依赖；改错故障：切换语言后时间格式不变。
// INV-16 清空必收尾：守住位置 finally；改错故障：清空失败后按钮永久禁用。
// INV-17 空态区分：守住位置 有无筛选条件的文案分支；改错故障：无匹配与完全无记录显示同一句话。
// INV-18 提交不阻塞：守住位置 void 调用；改错故障：模板里直接调用异步函数产生悬空承诺。
//
// 模块职责：渲染网络采集的有界快照表，负责筛选、分页与清空入口。
// 状态所有权：快照归采集桥；本组件只持有筛选、页码、清空与失败标记。
// 阅读顺序：常量 → 时间格式 → 轮询 effect → 筛选与分页 → 清空 → 视图。
import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkCaptureBridge, NetworkCaptureSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/index.js";

// 每页条数固定，只渲染当前页，避免长列表拖垮渲染。
// PAGE_SIZE 只影响内存切片，桥接始终返回全量快照。
//
const PAGE_SIZE = 100;

/** 网络页只轮询有界投影；采集生命周期属于 Main 中的窗口。 */
// bridge 缺省时整块降级为不可用提示，不发起任何请求。
// 采集生命周期属于主窗口，本组件只读快照。
//
export function NetworkSection({ bridge }: { bridge?: NetworkCaptureBridge }) {
  const { intl, locale } = useZCodeIntl();
  // locale 变化时重建 Intl 实例，其余渲染复用同一个。
  // 固定两位数字与二十四小时制，列宽稳定不跳动。
  //
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    [locale],
  );
  const [snapshot, setSnapshot] = useState<NetworkCaptureSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  // 轮询按固定间隔自调度，避免并发请求叠加。
  // clearing 为真时跳过请求，卸载时清掉待执行的 timer。
  //
  useEffect(() => {
    if (!bridge || clearing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const startedGeneration = generation.current;
      try {
        const next = await bridge.getSnapshot();
        if (!disposed && startedGeneration === generation.current) {
          setSnapshot(next);
          setFailed(false);
        }
      } catch {
        if (!disposed && startedGeneration === generation.current) setFailed(true);
      }
      if (!disposed) timer = setTimeout(refresh, 500);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [bridge, clearing, revision]);
  // filter 只作用在投影后的 rows 上，不写回采集侧快照。
  // 排序按时间倒序，同毫秒用编号兜底保证稳定。
  //
  const records = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (snapshot?.records ?? [])
      .filter(
        (record) =>
          !query ||
          `${record.processType} ${record.pid} ${record.method} ${record.url}`
            .toLowerCase()
            .includes(query),
      )
      .toSorted((left, right) => right.timestamp - left.timestamp || right.id - left.id);
  }, [snapshot, filter]);
  // pageCount 至少为 1，空列表也能显示第一页。
  // currentPage 取 page 与 pageCount-1 的较小值，筛选收缩后自动收敛。
  //
  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  // 先递增代际再清空，在途快照返回时会被识别为过期。
  // finally 里解除 busy 并递增 revision，成败路径都会触发刷新。
  //
  const clear = async () => {
    if (!bridge) return;
    // 清空前已发出的快照不能在返回后把旧列表写回来。
    generation.current++;
    setClearing(true);
    try {
      await bridge.clear();
      setSnapshot(null);
      setPage(0);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setClearing(false);
      setRevision((value) => value + 1);
    }
  };
  // 所有可见文案都经同一前缀取字典，缺键会在开发期暴露。
  // 函数只做键拼接，不缓存语言，切换后自然更新。
  //
  const label = (id: string) => intl.formatMessage({ id: `resourceManager.network.${id}` });
  return (
    <section
      className="space-y-3"
      aria-label={intl.formatMessage({ id: "resourceManager.network" })}
    >
      <p className="text-ui-sm text-muted-foreground">{label("description")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
          aria-label={label("filter")}
          placeholder={label("filter")}
        />
        <Button variant="outline" disabled={!bridge || clearing} onClick={() => void clear()}>
          {label("clear")}
        </Button>
      </div>
      {!bridge || failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {label("unavailable")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm text-muted-foreground">
        <span>
          {intl.formatMessage(
            { id: "resourceManager.network.count" },
            { count: records.length, dropped: snapshot?.dropped ?? 0 },
          )}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {label("previous")}
          </Button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            variant="ghost"
            disabled={currentPage + 1 === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            {label("next")}
          </Button>
        </div>
      </div>
      <div
        data-testid="resource-network-list"
        className="overflow-x-auto rounded-xl border border-border bg-background"
      >
        <table className="w-full table-fixed text-left text-ui-sm">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="w-24 px-3 py-2 font-medium">{label("time")}</th>
              <th className="w-28 px-3 py-2 font-medium">{label("process")}</th>
              <th className="w-20 px-3 py-2 font-medium">{label("method")}</th>
              <th className="px-3 py-2 font-medium">URL</th>
            </tr>
          </thead>
          <tbody>
            {records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((record) => (
              <tr key={record.id} className="border-b border-border last:border-0 hover:bg-hover">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {timeFormat.format(record.timestamp)}
                </td>
                <td className="px-3 py-2">
                  <div>{record.processType}</div>
                  <div className="text-muted-foreground tabular-nums">{record.pid}</div>
                </td>
                <td className="px-3 py-2 font-mono">{record.method}</td>
                <td className="break-all px-3 py-2 select-text" title={record.url}>
                  {record.url}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 ? (
          <p className="p-6 text-center text-ui-sm text-muted-foreground">
            {label(filter ? "noMatches" : "empty")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
