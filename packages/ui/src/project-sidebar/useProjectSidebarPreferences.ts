// INV-01 单键持久化：守住位置 存储键；改错故障：三块偏好分散存储，更新不同步。
// INV-02 读写不抛：守住位置 两个捕获；改错故障：禁用存储时目录渲染中断。
// INV-03 读取归一：守住位置 解析后的对象判断；改错故障：非对象内容被当成偏好。
// INV-04 写入尽力：守住位置 写失败的静默；改错故障：写盘异常冒泡到交互回调。
// INV-05 首次同步读：守住位置 初始化函数；改错故障：首帧闪出默认顺序再跳变。
// INV-06 加载期不追键：守住位置 加载时的空列表；改错故障：未加载完的新键被排到末尾。
// INV-07 升级映射：守住位置 旧标识到新键；改错故障：升级后项目顺序丢失。
// INV-08 跨窗只收不写：守住位置 存储事件回调；改错故障：两窗口回写互相覆盖。
// INV-09 非法整体忽略：守住位置 顺序校验；改错故障：半截顺序被应用，列表错乱。
// INV-10 视图白名单：守住位置 取值判断；改错故障：未知视图值进入界面。
// INV-11 展开缺省继承：守住位置 事件里的回退；改错故障：其他窗口的展开状态被清空。
// INV-12 序列依赖：守住位置 项目键字符串；改错故障：数组引用每次新建，效果反复触发。
// INV-13 未变不写：守住位置 顺序比较；改错故障：每次渲染都写盘并触发更新。
// INV-14 删除留给权威：守住位置 排序归一不提前裁剪；改错故障：刷新前的旧行被追加到末尾跳动。
// INV-15 改序即存：守住位置 changeOrder；改错故障：拖拽结果仅当前窗口可见。
// INV-16 旧收起兼容：守住位置 单根本地项目分支；改错故障：升级后旧目录全部展开。
// INV-17 批量合并：守住位置 批量展开的一次写入；改错故障：逐项更新互相覆盖。
// INV-18 依赖完整：守住位置 返回对象依赖；改错故障：闭包持有旧偏好，操作作用到旧状态。
//
// 模块职责：维护项目侧栏的顺序、视图与展开偏好，并同步同源其他窗口。
// 状态所有权：偏好归本 hook；项目目录与可用性由调用方传入。
// 阅读顺序：常量 → 读写辅助 → 升级映射 → 初始状态 → 跨窗同步 → 顺序同步 → 变更动作 → 返回值。
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProjectAvailability,
  ProjectSidebarView,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { projectKey } from "@/project-sidebar/view.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";
import { readWorkspaceExpansionState } from "@/lib/workspaceExpansionPreference.js";

import { reconcileProjectOrder, moveProjectOrder } from "@/project-sidebar/projectOrder.js";

import { readProjectSidebarView } from "@/project-sidebar/view-preference.js";

// 三类偏好共用 KEY 一条记录，任何一次写入都会把 order 与 view 及 expanded 一起落盘。
// 读写失败都回退空对象，不阻断目录渲染。
//
const KEY = "zcode-project-sidebar-preferences";
const EMPTY_AVAILABILITY: ReadonlyMap<string, ProjectAvailability> = new Map();
interface Preferences {
  order: string[];
  view: ProjectSidebarView;
  expanded: Record<string, boolean>;
}
// 解析结果不是对象时按空对象处理。
// 损坏内容立即回退，避免异常冒泡。
//
function read(key: string): Record<string, unknown> {
  try {
    return JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
// 写入只做尽力而为，浏览器禁用存储时静默失败。
// 失败仍保留当前窗口偏好，不影响命令执行。
//
function write(key: string, value: unknown) {
  try {
    getSafeLocalStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* 浏览器禁用存储时仍保持当前窗口偏好，不影响 Host 命令。 */
  }
}
// 入参只有 projects、loading 与 availability，读写细节由模块内部的 read 与 write 承担。
// availability 默认取 EMPTY_AVAILABILITY，upgradeKeys 的推导只依赖这个映射。
// useState 的惰性初值同步调用 read(KEY) 并用 reconcileProjectOrder 归一。
//
export function useProjectSidebarPreferences(
  projects: VirtualProject[],
  loading: boolean,
  availability: ReadonlyMap<string, ProjectAvailability> = EMPTY_AVAILABILITY,
) {
  // 升级键把旧条目标识映射到新键。
  // 只在存在升级标识时建映射，避免空键。
  //
  const upgradeKeys = useMemo(
    () =>
      new Map(
        [...availability].flatMap(([key, value]) =>
          value.upgradeEntryId ? [[`legacy:${value.upgradeEntryId}`, key] as const] : [],
        ),
      ),
    [availability],
  );
  const [legacyExpansion] = useState(readWorkspaceExpansionState);
  // 读取顺序、视图与展开三块并做旧值兼容。
  // reconcileProjectOrder 以 loading ? [] : projects.map(projectKey) 为基准，加载期不把新键写进 order。
  //
  const [preferences, setPreferences] = useState<Preferences>(() => {
    const saved = read(KEY);
    return {
      order: reconcileProjectOrder(
        Array.isArray(saved.order)
          ? saved.order.filter((key): key is string => typeof key === "string")
          : [],
        loading ? [] : projects.map(projectKey),
        upgradeKeys,
      ),
      // 视图兼容旧选择；项目/时间线沿用各自排序，分组使用 Host 的手动顺序。
      view: readProjectSidebarView(),
      expanded:
        saved.expanded && typeof saved.expanded === "object"
          ? Object.fromEntries(
              Object.entries(saved.expanded).filter(([, v]) => typeof v === "boolean"),
            )
          : {},
    };
  });
  // 存储事件接收同源其他窗口的更新。
  // 非法顺序整体忽略，视图只接受已知取值。
  //
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key !== KEY || !event.newValue) return;
      try {
        const value = JSON.parse(event.newValue) as Partial<Preferences>;
        if (!Array.isArray(value.order) || !value.order.every((key) => typeof key === "string"))
          return;
        // storage 事件来自同一控制端的其他窗口；接收时不回写，避免相互覆盖新顺序。
        setPreferences((previous) => ({
          ...previous,
          order: [...new Set(value.order)],
          view: value.view === "timeline" || value.view === "grouped" ? value.view : "projects",
          expanded:
            value.expanded && typeof value.expanded === "object"
              ? Object.fromEntries(
                  Object.entries(value.expanded).filter(
                    ([, expanded]) => typeof expanded === "boolean",
                  ),
                )
              : previous.expanded,
        }));
      } catch {
        /* 损坏的偏好不影响当前项目目录。 */
      }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, []);
  // 项目键序列化成字符串作为依赖。
  // 排序未变化时返回原对象，避免无谓写回与重渲。
  //
  const currentKeys = JSON.stringify(projects.map(projectKey));
  useEffect(() => {
    if (loading) return;
    setPreferences((previous) => {
      const order = reconcileProjectOrder(
        previous.order,
        JSON.parse(currentKeys) as string[],
        upgradeKeys,
      );
      if (
        order.length === previous.order.length &&
        order.every((key, index) => key === previous.order[index])
      )
        return previous;
      const next = { ...previous, order };
      write(KEY, next);
      return next;
    });
  }, [currentKeys, loading, upgradeKeys]);
  // changeOrder 先 reconcileProjectOrder(previous.order, [], upgradeKeys) 再应用 change。
  // 变更后立即持久化，保证跨窗口可见。
  //
  const changeOrder = useCallback(
    (change: (order: string[]) => string[]) => {
      setPreferences((previous) => {
        const next = {
          ...previous,
          order: change(reconcileProjectOrder(previous.order, [], upgradeKeys)),
        };
        write(KEY, next);
        return next;
      });
    },
    [upgradeKeys],
  );
  const update = useCallback(
    (patch: Partial<Preferences>) =>
      setPreferences((previous) => {
        const next = { ...previous, ...patch };
        write(KEY, next);
        return next;
      }),
    [],
  );
  const setView = useCallback((view: ProjectSidebarView) => update({ view }), [update]);
  return useMemo(
    () => ({
      order: preferences.order,
      prepend: (project: VirtualProject) =>
        changeOrder((order) => [
          projectKey(project),
          ...order.filter((key) => key !== projectKey(project)),
        ]),
      sort: (items: VirtualProject[]) => {
        // 删除只由权威目录移除行；提前清理排序键会把刷新前的旧行追加到末尾，造成跳动。
        const order = reconcileProjectOrder(preferences.order, items.map(projectKey), upgradeKeys);
        const positions = new Map(order.map((key, index) => [key, index]));
        return [...items].sort(
          (a, b) => positions.get(projectKey(a))! - positions.get(projectKey(b))!,
        );
      },
      reorder: (section: VirtualProject[], active: string, over: string) =>
        changeOrder((order) => moveProjectOrder(order, section.map(projectKey), active, over)),
      view: preferences.view,
      setView,
      isExpanded: (project: VirtualProject) =>
        preferences.expanded[projectKey(project)] ??
        // 重构不能丢掉旧单目录的收起偏好；远端与多 root 不以本机路径猜身份。
        (project.hostId === "local" && project.roots.length === 1
          ? legacyExpansion[project.roots[0]!.rootPath] !== false
          : true),
      setAllExpanded: (items: VirtualProject[], expanded: boolean) =>
        setPreferences((previous) => {
          // 批量操作仍写同一个偏好对象，避免逐项更新覆盖同批次中的其他项目。
          const next = {
            ...previous,
            expanded: {
              ...previous.expanded,
              ...Object.fromEntries(items.map((project) => [projectKey(project), expanded])),
            },
          };
          write(KEY, next);
          return next;
        }),
      setExpanded: (project: VirtualProject, expanded: boolean) =>
        setPreferences((previous) => {
          const next = {
            ...previous,
            expanded: { ...previous.expanded, [projectKey(project)]: expanded },
          };
          write(KEY, next);
          return next;
        }),
    }),
    [preferences, changeOrder, setView, legacyExpansion, upgradeKeys],
  );
}
