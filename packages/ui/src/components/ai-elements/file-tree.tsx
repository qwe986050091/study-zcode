"use client";

// INV-01 展开态与节点树数据分离：FileTree 只持有 Set 形式的路径集合，不复制任何节点结构；守住位置：FileTree 的 internalExpanded 与 expandedPaths；改错故障：节点树刷新后展开态丢失或残留无效路径，目录被莫名收拢
// INV-02 路径 path 是唯一身份键，name 仅供显示；守住位置：FileTreeFolder 与 FileTreeFile 的展开判定和选中判定；改错故障：两个同名目录被同时展开或同时高亮，选择回调收到错误路径
// INV-03 受控模式下外部 expanded 是唯一真源，内部 state 只能是副本；守住位置：controlledExpanded 空值合并处；改错故障：父组件回写旧集合后界面抖动，展开态在两帧之间来回跳
// INV-04 每次切换都构造新的 Set 实例，禁止原地增删后复用旧引用；守住位置：togglePath 中的 newExpanded；改错故障：React 依赖引用比较跳过重渲染，点击箭头毫无反应
// INV-05 onExpandedChange 在一次切换后只调用一次，且与内部写入共用同一份集合；守住位置：togglePath 尾部的回调；改错故障：受控父组件与内部集合分叉，子树已展开而父层记录仍是旧值
// INV-06 展开与选中是两条独立通道，展开动作不得触发 onSelect；守住位置：折叠按钮与 handleSelect 的分工；改错故障：点开目录即触发文件加载，误报选中并拉取内容
// INV-07 context 默认值必须无副作用：空 Set 加 noop；守住位置：FileTreeContext 的初始值；改错故障：子树脱离 FileTree 使用时抛异常，整块面板白屏
// INV-08 目录图标严格由 isExpanded 派生，不额外保存图标状态；守住位置：FolderOpenIcon 与 FolderIcon 的二选一分支；改错故障：图标与实际折叠状态相反，用户按图标判断层级时判断错
// INV-09 子层缩进只由 CollapsibleContent 内的 ml-4 与左边框提供，节点不得自算 depth；守住位置：FileTreeFolder 的内容容器；改错故障：多层嵌套后缩进累加错位，树形结构在视觉上坍缩成平铺
// INV-10 目录子节点为空时仍渲染缩进容器，空状态占位需由调用方补齐；守住位置：CollapsibleContent 内的 div；改错故障：空目录展开后既无内容也无提示，用户以为加载失败并反复点击
// INV-11 每个 treeitem 的 tabIndex 固定为 0，没有 roving tabindex；守住位置：FileTreeFolder 与 FileTreeFile 的 role 与 tabIndex 属性；改错故障：Tab 键要穿过全部节点才能到达下一个控件，长树上键盘无法使用
// INV-12 role=tree 只出现在最外层容器，treeitem 之间不得插入破坏树语义的中间层；守住位置：FileTree 外层 div 与各节点 div；改错故障：读屏器把整棵树读成单个叶节点，子树内容被整段跳过
// INV-13 键盘激活只认 Enter 与空格，且必须与鼠标点击走同一个 onSelect；守住位置：FileTreeFile 的 handleKeyDown；改错故障：键盘用户能聚焦却打不开文件，出现可聚焦但无操作的空壳
// INV-14 目录行的操作区必须同时阻断 click 与 keydown 冒泡；守住位置：stopPropagation 及其在两处事件上的绑定；改错故障：点重命名或删除按钮时同时选中该文件，误触发预览或下载
// INV-15 FileTreeFile 的 children 一旦提供就完全接管渲染，默认占位、图标与名称全部不渲染；守住位置：FileTreeFile 的 children 空值合并分支；改错故障：自定义行出现重复图标与重复文件名，行高翻倍
// INV-16 名称区域必须 truncate，图标必须 shrink-0，宽度约束交给父级；守住位置：FileTreeName 与 FileTreeIcon 的类名；改错故障：超长文件名撑破侧栏，整棵树出现横向滚动条
// INV-17 未提供 icon 时必须回退到 FileIcon，不能渲染空占位；守住位置：FileTreeFile 的 icon 空值合并分支；改错故障：文件行与目录行左边缘不对齐，层级看起来错行串位
// INV-18 折叠动画与箭头旋转只依赖 CSS transition，禁止用挂载延迟模拟展开；守住位置：ChevronRightIcon 的 transition-transform 与 rotate-90；改错故障：展开时子节点先出现再位移，长列表出现整段跳动
// INV-19 所有节点必须处于 FileTree 提供的 context 内，不得为 togglePath 与 onSelect 写本地兜底；守住位置：FileTreeFolder 与 FileTreeFile 的 useContext；改错故障：漏包 provider 后点击静默无效，且没有任何报错线索可查
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface FileTreeContextType {
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
  selectedPath?: string;
  onSelect?: (path: string) => void;
}

// Default noop for context default value
// oxlint-disable-next-line eslint(no-empty-function)
const noop = () => {};

const FileTreeContext = createContext<FileTreeContextType>({
  // oxlint-disable-next-line eslint-plugin-unicorn(no-new-builtin)
  expandedPaths: new Set(),
  togglePath: noop,
});

// [权衡] FileTreeProps 从 HTMLAttributes 中剔除原生 onSelect，避免与自定义的选择回调签名冲突。
// 若保留原生 onSelect，调用方传入的路径回调会被类型合并成事件处理器，选中逻辑静默失效。
// expanded 用于受控，defaultExpanded 只在首次挂载生效，两者同时出现时后者被完全忽略。
// defaultExpanded 的默认值是每次渲染新建的空 Set，仅在 useState 初值处消费，不产生额外重建成本。
// onExpandedChange 是展开态唯一的外溢通道，父组件据此镜像状态，不能反向读取子组件内部集合。
// selectedPath 与 expanded 分开声明，选中单个文件不需要改动展开集合，两者可以独立受控。
// className 与其余属性原样透传到外层 div，组件不吞掉 id、style、data-* 等字段。
export type FileTreeProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  expanded?: Set<string>;
  defaultExpanded?: Set<string>;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onExpandedChange?: (expanded: Set<string>) => void;
};

export const FileTree = ({
  expanded: controlledExpanded,
  defaultExpanded = new Set(),
  selectedPath,
  onSelect,
  onExpandedChange,
  className,
  children,
  ...props
}: FileTreeProps) => {
  // [权衡] 受控与非受控共用一份内部 state：受控时它只是被丢弃的副本，非受控时才是唯一真源。
  // 只有 controlledExpanded 为 undefined 才走内部集合，空 Set 属于合法受控值，不能被当成未受控。
  // [失败路径] 受控模式下切换仍会写入 internalExpanded 并调用 onExpandedChange，内部与外部同时变动。
  // 父组件若不回写 expanded，界面保持收拢而内部集合已变，两侧分叉且没有任何告警可查。
  // useState 初值取 defaultExpanded，后续 prop 变化不再重算，改默认值对已挂载节点无效。
  // expandedPaths 每帧直接解引用，折叠更新无需额外 effect 同步，首帧不会先展开再收拢。
  // 内部集合与父组件集合是两份独立对象，禁止绕过 togglePath 直接修改，否则引用不变导致漏渲染。
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expandedPaths = controlledExpanded ?? internalExpanded;

  const togglePath = useCallback(
    (path: string) => {
      // [权衡] 先整份复制再修改，是为了让 React 看到新引用；原地 delete 后回传旧对象不触发重渲染。
      // 复制成本与展开节点数同阶，单次折叠最多几十项，换来的是所有展开判定保持 O(1)。
      // 复制出的集合与 expandedPaths 不共享元素，父组件收到的对象可安全缓存或再派生。
      // [事务] 判定与写入必须基于同一份快照：has 与 delete 之间不能插入 await，否则并发的两次切换互相覆盖。
      // 同一路径连续切换两次内容回到原样，但引用不同，因此不能用引用相等当作无变化判据。
      // Set 的插入顺序即展开顺序，顺序展开深链时新目录总在末尾追加，已有节点不重排。
      // 路径必须与节点 path 逐字符一致，带尾斜杠或反斜杠会生成两个互不相认的展开项。
      const newExpanded = new Set(expandedPaths);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      setInternalExpanded(newExpanded);
      onExpandedChange?.(newExpanded);
    },
    [expandedPaths, onExpandedChange]
  );

  const contextValue = useMemo(
    // [权衡] 一个 context 同时承载展开、选中与选择回调，少一层嵌套，代价是任一字段变化都重渲染整棵树。
    // 依赖数组逐项列出四元组，其中 expandedPaths 与 togglePath 同变，实际以展开集合作为主要开关。
    // onSelect 若在父组件内联定义，每次渲染都换新引用，进而击穿 contextValue 的稳定性。
    // 仅选中项变化时展开集合保持原引用，节点不需要重算折叠，只有选中比较结果改变。
    // 拆成多个 context 能缩小更新面，但每个节点会多读一层 provider，此处选择了更少的嵌套。
    () => ({ expandedPaths, onSelect, selectedPath, togglePath }),
    [expandedPaths, onSelect, selectedPath, togglePath]
  );

  return (
    <FileTreeContext.Provider value={contextValue}>
      <div
        className={cn(
          "rounded-lg border bg-background font-mono text-ui-base",
          className
        )}
        role="tree"
        {...props}
      >
        <div className="p-2">{children}</div>
      </div>
    </FileTreeContext.Provider>
  );
};

export type FileTreeIconProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeIcon = ({
  className,
  children,
  ...props
}: FileTreeIconProps) => (
  <span className={cn("shrink-0", className)} {...props}>
    {children}
  </span>
);

export type FileTreeNameProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeName = ({
  className,
  children,
  ...props
}: FileTreeNameProps) => (
  <span className={cn("truncate", className)} {...props}>
    {children}
  </span>
);

interface FileTreeFolderContextType {
  path: string;
  name: string;
  isExpanded: boolean;
}

const FileTreeFolderContext = createContext<FileTreeFolderContextType>({
  isExpanded: false,
  name: "",
  path: "",
});

export type FileTreeFolderProps = HTMLAttributes<HTMLDivElement> & {
  path: string;
  name: string;
};

export const FileTreeFolder = ({
  path,
  name,
  className,
  children,
  ...props
}: FileTreeFolderProps) => {
  const { expandedPaths, togglePath, selectedPath, onSelect } =
    useContext(FileTreeContext);
  // path 是唯一身份键：展开判定、选中判定、回调参数全部用它，name 只参与显示。
  // [失败路径] 兄弟目录同名而 path 不同时互不牵连；若把 path 写成裸名字则会一起被展开。
  // expandedPaths 是 Set，判定为 O(1)，节点总数增加不影响单次渲染成本。
  // [权衡] 选中态与展开态分别计算，点选目录不改变折叠，两个交互不会互相污染。
  // isSelected 用全等比较，父组件传入新的字符串实例不影响结果，大小写差异则判定为不同文件。
  // 路径唯一性由调用方保证，组件既不做去重也不做父子路径推导，重复路径即视为同一节点。
  // [失败路径] 同一 path 渲染两个节点时无法区分，展开一个会连带展开另一个，选中也同步联动。
  const isExpanded = expandedPaths.has(path);
  const isSelected = selectedPath === path;

  // [失败路径] Collapsible 的 onOpenChange 会带入目标布尔值，这里选择忽略并直接取反当前状态。
  // 若 UI 与 expandedPaths 不同步，例如外部强制折叠，取反得到的方向会与用户期望相反。
  // 依赖项只有 togglePath 与 path，回调身份稳定，不会因每次渲染重建而让 Collapsible 反复回调。
  // [权衡] 不读回调参数，换来单一真源：展开方向永远由当前集合推出，不出现两份布尔状态。
  // 点击箭头与点击整行都进入这里，路径相同即视为同一次切换，不区分触发来源。
  // 出现点了没反应时，应先检查父级 expanded 是否与内部集合不同步，而不是怀疑事件绑定。
  // [并发] React 的自动批处理让同一次事件里的多次切换只提交最后一次结果，中间集合不外泄。
  const handleOpenChange = useCallback(() => {
    togglePath(path);
  }, [togglePath, path]);

  const handleSelect = useCallback(() => {
    onSelect?.(path);
  }, [onSelect, path]);

  // [权衡] 目录上下文只带 isExpanded、name、path，子组件无需重复读全局 context 即可拿到自身信息。
  // 缩进由 CollapsibleContent 内固定的 ml-4 实现，层级完全由 DOM 嵌套表达，不引入 depth 变量。
  // [失败路径] 目录为空时 CollapsibleContent 仍渲染带左边框的容器，展开后只剩一段空白缩进。
  // 需要空状态提示时必须由调用方补占位节点，组件不会自动生成暂无内容之类的文案。
  // 缩进按每层固定像素累加，五六层后可用宽度急剧下降，超长名称由 truncate 兜住。
  const folderContextValue = useMemo(
    () => ({ isExpanded, name, path }),
    [isExpanded, name, path]
  );

  return (
    <FileTreeFolderContext.Provider value={folderContextValue}>
      <Collapsible onOpenChange={handleOpenChange} open={isExpanded}>
        <div
          className={cn("", className)}
          role="treeitem"
          tabIndex={0}
          {...props}
        >
          <div
            className={cn(
              "flex w-full items-center gap-1 rounded px-2 py-1 text-left transition-colors hover:bg-muted/50",
              isSelected && "bg-muted"
            )}
          >
            <CollapsibleTrigger asChild>
              <button
                className="flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0"
                type="button"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    isExpanded && "rotate-90"
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <button
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left"
              onClick={handleSelect}
              type="button"
            >
              <FileTreeIcon>
                {isExpanded ? (
                  <FolderOpenIcon className="size-4 text-blue-500" />
                ) : (
                  <FolderIcon className="size-4 text-blue-500" />
                )}
              </FileTreeIcon>
              <FileTreeName>{name}</FileTreeName>
            </button>
          </div>
          <CollapsibleContent>
            <div className="ml-4 border-l pl-2">{children}</div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </FileTreeFolderContext.Provider>
  );
};

interface FileTreeFileContextType {
  path: string;
  name: string;
}

const FileTreeFileContext = createContext<FileTreeFileContextType>({
  name: "",
  path: "",
});

export type FileTreeFileProps = HTMLAttributes<HTMLDivElement> & {
  path: string;
  name: string;
  icon?: ReactNode;
};

export const FileTreeFile = ({
  path,
  name,
  icon,
  className,
  children,
  ...props
}: FileTreeFileProps) => {
  const { selectedPath, onSelect } = useContext(FileTreeContext);
  const isSelected = selectedPath === path;

  const handleClick = useCallback(() => {
    onSelect?.(path);
  }, [onSelect, path]);

  // [失败路径] 只拦截 Enter 与空格，方向键、Home、End 均未处理，键盘用户无法在树内移动焦点。
  // 空格同时会触发浏览器默认滚动，这里没有阻止默认行为，长树上按空格页面会跳动。
  // [权衡] Enter 与空格合并处理并共用 onSelect，保证键盘与鼠标的下游行为完全一致。
  // 默认行为未被阻止，若外层表单监听 Enter 提交，选中文件会顺带提交表单。
  // 键盘激活不改变展开态，目录同样只走 onSelect，展开仍依赖箭头按钮与整行点击。
  // [失败路径] 组合键未过滤，Ctrl 加 Enter 或多键同时按下也会被当成普通激活。
  // 回调依赖 onSelect 与 path，父组件内联回调时每次渲染重建，节点上的监听随之更新。
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        onSelect?.(path);
      }
    },
    [onSelect, path]
  );

  // [权衡] 文件上下文只暴露 name 与 path，图标与选中态留在父层，避免子树跟着选中变化重渲染。
  // 未传 icon 时回退到 FileIcon，不留空位，保证目录行与文件行的左边缘对齐。
  // icon 接受任意 ReactNode，组件不校验尺寸，传入大图会直接撑高单行行高。
  // 名称固定 truncate，路径只作逻辑标识且从不渲染，界面不暴露内部绝对路径。
  // [失败路径] 不同目录下的同名文件上下文完全一致，子组件不能靠 context 区分，只能读 path。
  const fileContextValue = useMemo(() => ({ name, path }), [name, path]);

  return (
    <FileTreeFileContext.Provider value={fileContextValue}>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded px-2 py-1 transition-colors hover:bg-muted/50",
          isSelected && "bg-muted",
          className
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="treeitem"
        tabIndex={0}
        {...props}
      >
        {children ?? (
          <>
            {/* Spacer for alignment */}
            <span className="size-4 shrink-0" />
            <FileTreeIcon>
              {icon ?? <FileIcon className="size-4 text-muted-foreground" />}
            </FileTreeIcon>
            <FileTreeName>{name}</FileTreeName>
          </>
        )}
      </div>
    </FileTreeFileContext.Provider>
  );
};

export type FileTreeActionsProps = HTMLAttributes<HTMLDivElement>;

// [权衡] 操作区用同一个处理器同时阻断 click 与 keyDown，避免按钮上的 Enter 冒泡成整行选中。
// stopPropagation 只在冒泡阶段生效，父级若在捕获阶段监听，仍会收到这些事件。
// [失败路径] 漏掉 keyDown 时，键盘触发操作按钮会让整行被选中，误开预览或触发下载。
// 操作区用 ml-auto 靠外层 flex 推到行尾，不参与整行点击区域，也不改变行高。
// 两个事件绑定复用同一函数引用，不产生额外闭包，也不依赖任何 props。
const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

export const FileTreeActions = ({
  className,
  children,
  ...props
}: FileTreeActionsProps) => (
  <div
    className={cn("ml-auto flex items-center gap-1", className)}
    onClick={stopPropagation}
    onKeyDown={stopPropagation}
    role="group"
    {...props}
  >
    {children}
  </div>
);
