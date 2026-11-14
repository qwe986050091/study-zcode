"use client";

// MicSelector 组件族：把媒体输入设备枚举封装成 useAudioDevices，并提供基于 Radix Popover 与 cmdk 的麦克风选择 UI。
// 职责边界：设备枚举、权限申请时机、展开与选中状态、下拉宽度测量；不负责录音、采样率协商、选中值的业务落库。
// 不负责：热插拔后重建录音流、权限被撤销后的提示、多语言文案；这些由调用方或其他模块承担。
//
// INV-01 断言：设备枚举只在 hook 内发生一次，子组件不得另起数据源 —— 守住它的位置：useAudioDevices 与 MicSelectorContext —— 改错故障：两份 devices 不一致，列表与触发器显示不同设备。
// INV-02 断言：未授权时只走无权限枚举，挂载阶段禁止直接请求麦克风 —— 守住它的位置：首个 useEffect —— 改错故障：一进页面就弹权限框，拒绝后 error 常驻且列表为空。
// INV-03 断言：授权探测拿到的临时流必须逐轨 stop —— 守住它的位置：loadDevicesWithPermission 的 for 循环 —— 改错故障：麦克风指示灯常亮，其他应用无法占用设备。
// INV-04 断言：两次枚举都必须由 finally 复位 loading —— 守住它的位置：两个 loadDevices 的 try 与 finally —— 改错故障：loading 卡在 true，打开面板再也不会触发授权请求。
// INV-05 断言：hasPermission 只在 getUserMedia 成功后置 true 且不回退 —— 守住它的位置：loadDevicesWithPermission 成功分支 —— 改错故障：devicechange 反复走无权限分支，设备标签持续为空。
// INV-06 断言：devicechange 监听必须成对增删且依赖完整 —— 守住它的位置：第二个 useEffect 的注册与 cleanup —— 改错故障：热插拔后列表不刷新，或监听重复注册导致多次枚举。
// INV-07 断言：选中值以 deviceId 为唯一标识，禁止存 label —— 守住它的位置：MicSelectorValue 的 find 与 Item 的回写 —— 改错故障：设备改名或重连后选中丢失。
// INV-08 断言：选中时先回写 value 再关闭面板 —— 守住它的位置：handleSelect 的两行顺序 —— 改错故障：cmdk 关闭时卸载，选中回调丢失。
// INV-09 断言：展开态与选中值必须走 useControllableState —— 守住它的位置：MicSelector 的两处状态声明 —— 改错故障：受控调用方无法同步面板开关，选中不生效。
// INV-10 断言：宽度只由 Trigger 的 ResizeObserver 测量，200 仅为兜底 —— 守住它的位置：width 初值与 Content 的内联样式 —— 改错故障：首帧面板宽度为 0 或明显抖动。
// INV-11 断言：测量结果为 0 时必须丢弃 —— 守住它的位置：ResizeObserver 回调的 if 判断 —— 改错故障：面板收起时宽度被写成 0，再次展开不可见。
// INV-12 断言：context 默认值与 Provider 形状必须一致 —— 守住它的位置：createContext 的默认对象 —— 改错故障：脱离 Provider 使用时读到 undefined 并崩溃。
// INV-13 断言：设备 id 正则必须行尾锚定且只认两段四位十六进制 —— 守住它的位置：deviceIdRegex —— 改错故障：把设备名里的括号内容当作 id 拆走。
// INV-14 断言：props 透传顺序必须是默认值在前、调用方在后 —— 守住它的位置：各 UI 原语的展开位置 —— 改错故障：调用方覆盖不了占位符、宽度与 className。
// INV-15 断言：不打开面板就不申请权限 —— 守住它的位置：MicSelector 内 open 的副作用 —— 改错故障：仅渲染选择器就触发隐私提示。
// INV-16 断言：错误只写 error state 与 logger，不向上抛出 —— 守住它的位置：两个 catch 分支 —— 改错故障：一次枚举失败让整个选择面板白屏。
//
// 结构：useAudioDevices（设备数据源）→ MicSelector（状态容器）→ Trigger/Content/List/Item（UI 原语）→ Label/Value（展示）。
// 状态所有权：设备列表归 hook；选中值与展开态归 MicSelector 的 useControllableState；宽度归 Trigger 测量后经 context 下发。
// 数据流：挂载枚举或 devicechange → hook 刷新 devices → context → List 渲染 → Item 回写 value 并关闭面板。
// 所有跨层通信只走 MicSelectorContext；子组件不得自行调用 useAudioDevices，否则会出现两份不一致的设备列表。
// 本文件不做国际化：占位符与兜底文案是英文常量，需要其他语言时由调用方通过 props 覆盖。
// 兼容性：逻辑直接依赖 navigator.mediaDevices；非安全上下文或旧环境里该对象可能不存在，本文件不做存在性判断与降级。
// 阅读顺序：先看两个 loadDevices 的权限与失败分支，再看 open 副作用，最后看各 UI 原语的 props 透传顺序。
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Button } from "../ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover.js";
import { cn } from "../lib/utils.js";
import { ChevronsUpDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { logger } from "@/logger.js";

// [契约] 只匹配 label 末尾形如 (1a2b:3c4d) 的设备标识：两段四位十六进制加行尾锚定缺一不可。
// 放宽成任意括号内容会把「麦克风 (USB)」这类名称一起吞掉，Label 与 Value 的展示会同时出错。
// 该正则被 MicSelectorLabel 与 MicSelectorValue 共用，改这里等于改两处展示。
const deviceIdRegex = /\(([\da-fA-F]{4}:[\da-fA-F]{4})\)$/;

// [契约] 这是 Trigger/Content/List/Item 与 MicSelector 之间唯一的数据通道，字段增减必须同步 createContext 的默认对象。
// setWidth 声明为可选：Content 可能在 Trigger 尚未测量时渲染，此时宽度回落到默认值。
// data 存的是 MediaDeviceInfo 原对象而非字符串，Item 依赖 deviceId 回写选中值，别在这里提前映射成 label。
interface MicSelectorContextType {
  data: MediaDeviceInfo[];
  value: string | undefined;
  onValueChange?: (value: string) => void;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  width: number;
  setWidth?: (width: number) => void;
}

// [契约] 默认值只服务脱离 Provider 的孤岛渲染（例如单独挂一个 List），width 兜底 200，回调留空表示静默。
// 字段集合必须与接口完全一致；少了任何一项，useContext 拿到的是 undefined 而不是编译期报错。
const MicSelectorContext = createContext<MicSelectorContextType>({
  data: [],
  onOpenChange: undefined,
  onValueChange: undefined,
  open: false,
  setWidth: undefined,
  value: undefined,
  width: 200,
});

export const useAudioDevices = () => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  // [失败路径] 未授权时 enumerateDevices 不抛错，只返回 label 为空的设备，因此成功分支也可能得到一组无名设备。
  // 捕获分支只把 message 写进 error state 与 logger，不抛出也不重试，面板表现为空列表而不是崩溃。
  // 空依赖数组让回调身份永久稳定，这是挂载副作用只跑一次的前提，不要顺手补依赖。
  const loadDevicesWithoutPermission = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const deviceList = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = deviceList.filter(
        (device) => device.kind === "audioinput"
      );

      // [契约] 只保留 audioinput：videoinput 与 audiooutput 混入会让用户选到摄像头，随后请求音频流必然失败。
      // `setDevices` 整表覆盖而非追加，拔掉麦克风后列表减少也能正确反映。
      setDevices(audioInputs);
    // [失败路径] 兜底文案是英文常量，与当前界面语言无关；调用方要本地化只能读 error state 自行渲染。
    // 这里不清空 devices：保留上一次列表，避免枚举偶发失败时设备突然全部消失。
    // 日志走 ui 包统一 logger，改成 console 会让桌面端日志文件缺这一条。
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to get audio devices";

      setError(message);
      logger.error("Error getting audio devices:", message);
    } finally {
      setLoading(false);
    }
  }, []);

  // [资源] 该回调会真实占用麦克风：getUserMedia 成功即弹系统权限框并点亮指示灯，只允许在用户显式打开面板后调用。
  // [权衡] 依赖里带 loading，回调身份会随 loading 翻转，从而让 devicechange 的订阅副作用重建一次；这是为了让监听器拿到最新状态。
  // 进来先清 error，保证上一次的「用户拒绝」提示不会残留到这次成功之后。
  const loadDevicesWithPermission = useCallback(async () => {
    // [并发] 直接 return 而不是排队重试：devicechange 可能连发多次，重入只会堆出重复权限请求。
    // 被丢弃的刷新由新回调在 loading 归 false 后补偿，因为 loading 在依赖里，别把这段守卫改掉。
    if (loading) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // [事务] 必须先 getUserMedia 再枚举：只有授权后 enumerateDevices 才返回带 label 的设备。
      // 只请求 audio，加上 video 会多弹一次摄像头权限并多占一路设备。
      const tempStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      for (const track of tempStream.getTracks()) {
        track.stop();
      }

      const deviceList = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = deviceList.filter(
        (device) => device.kind === "audioinput"
      );

      setDevices(audioInputs);
      // [契约] 只有走到这里才算真拿到授权；置位后 devicechange 分支改走带权限路径，标签才不会退化成空串。
      // 该标志只增不减：浏览器侧权限被撤销时，下一次枚举自然变回空标签，不需要额外状态机。
      setHasPermission(true);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to get audio devices";

      setError(message);
      logger.error("Error getting audio devices:", message);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  // [契约] 挂载时只做一次无权限枚举，让选择器在用户打开面板前就知道设备数量，哪怕还没有 label。
  // 依赖是稳定回调，实际只执行一次；删掉依赖会破坏 lint 约束，也失去这层显式说明。
  useEffect(() => {
    loadDevicesWithoutPermission();
  }, [loadDevicesWithoutPermission]);

  // [资源] 监听注册在 mediaDevices 上，cleanup 必须用同一个函数引用 removeEventListener，否则永远摘不掉。
  // [并发] 依赖含 hasPermission 与两个回调，任一变化都会先摘旧监听再挂新监听，顺序由 React 保证。
  // 没有做防抖：一次批量设备变更会触发多次枚举，但每次都被 loading 守卫挡掉。
  useEffect(() => {
    const handleDeviceChange = () => {
      if (hasPermission) {
        loadDevicesWithPermission();
      } else {
        loadDevicesWithoutPermission();
      }
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    // [资源] 卸载时只摘监听，不 stop 任何轨道：请求成功后临时流已逐轨释放，这里没有长驻资源。
    // 将来若在此补 stop，注意别波及调用方自己持有的录音流。
    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange
      );
    };
  }, [hasPermission, loadDevicesWithPermission, loadDevicesWithoutPermission]);

  return {
    devices,
    error,
    hasPermission,
    loadDevices: loadDevicesWithPermission,
    loading,
  };
};

// [契约] 该类型把 Popover 的全部 props 透出，open 与 onOpenChange 再被组件内部显式覆盖为受控语义。
// value 允许 undefined 表示未选择；用空串代替会让受控回调里拿到空串而非 undefined，类型上出现分叉。
export type MicSelectorProps = ComponentProps<typeof Popover> & {
  defaultValue?: string;
  value?: string | undefined;
  onValueChange?: (value: string | undefined) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const MicSelector = ({
  defaultValue,
  value: controlledValue,
  onValueChange: controlledOnValueChange,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  ...props
}: MicSelectorProps) => {
  // [契约] 同时传 value 与 defaultValue 时以 value 为准，defaultValue 只在首次渲染生效。
  // onChange 的入参就是新的选中值，与对外暴露的 onValueChange 同签名；子组件拿到的是包装后的 setter。
  // 受控方若不在 onValueChange 里回写，选中会在下一次渲染被重置回 value，表现为点了没反应。
  const [value, onValueChange] = useControllableState<string | undefined>({
    defaultProp: defaultValue,
    onChange: controlledOnValueChange,
    prop: controlledValue,
  });
  const [open, onOpenChange] = useControllableState({
    defaultProp: defaultOpen,
    onChange: controlledOnOpenChange,
    prop: controlledOpen,
  });
  // [权衡] 200 只是首帧兜底，Trigger 挂载后 ResizeObserver 会立刻用真实按钮宽度覆盖。
  // 调大初值会让面板首帧偏宽、调小则闪窄；同一个数字还写在 createContext 默认值里，改要同步。
  const [width, setWidth] = useState(200);
  const { devices, loading, hasPermission, loadDevices } = useAudioDevices();

  // [契约] 只在面板打开的瞬间申请权限：open 为 false 时绝不触碰 getUserMedia，这是隐私边界。
  // 条件里带 !loading，既避免与挂载枚举并发，也避免一次打开重复弹窗。
  // loadDevices 依赖 loading，本副作用会随之重跑，但 hasPermission 为 true 后不会再发请求。
  useEffect(() => {
    if (open && !hasPermission && !loading) {
      loadDevices();
    }
  }, [open, hasPermission, loading, loadDevices]);

  // [契约] 依赖必须列全七个值，漏掉 open 会让子组件长期看到初始开关态。
  // 这里不排序也不过滤：顺序完全等于 enumerateDevices 返回顺序，改排序会改变默认首项与实际默认设备。
  const contextValue = useMemo(
    () => ({
      data: devices,
      onOpenChange,
      onValueChange,
      open,
      setWidth,
      value,
      width,
    }),
    [devices, onOpenChange, onValueChange, open, setWidth, value, width]
  );

  return (
    <MicSelectorContext.Provider value={contextValue}>
      <Popover {...props} onOpenChange={onOpenChange} open={open} />
    </MicSelectorContext.Provider>
  );
};

export type MicSelectorTriggerProps = ComponentProps<typeof Button>;

export const MicSelectorTrigger = ({
  children,
  ...props
}: MicSelectorTriggerProps) => {
  const { setWidth } = useContext(MicSelectorContext);
  // [资源] ref 同时交给 Button 与 ResizeObserver；Button 换实现时必须继续把 ref 转发到真实 DOM，否则测量静默失效。
  // 用普通对象 ref 而非 state，避免测量结果引起额外渲染。
  const ref = useRef<HTMLButtonElement>(null);

  // [资源] ResizeObserver 必须在卸载时 disconnect，否则被观察节点被 retain，热更新会累积多个观察者。
  // 观察触发按钮而不是 PopoverContent：浮层按需挂载且宽度受控，观察它会形成测量回环。
  // 依赖只有 setWidth，它是 Provider 里稳定的 setter，因此观察器不会因其他状态变化而重建。
  useEffect(() => {
    // Create a ResizeObserver to detect width changes
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // [失败路径] 收起动画或隐藏期间 offsetWidth 为 0，靠 if (newWidth) 丢弃，避免把面板宽度写成 0。
        // 取整数像素用 offsetWidth 而非带小数的矩形宽度，防止亚像素值让浮层抖动。
        const newWidth = (entry.target as HTMLElement).offsetWidth;
        if (newWidth) {
          setWidth?.(newWidth);
        }
      }
    });

    if (ref.current) {
      resizeObserver.observe(ref.current);
    }

    // Clean up the observer when component unmounts
    return () => {
      resizeObserver.disconnect();
    };
  }, [setWidth]);

  return (
    <PopoverTrigger asChild>
      <Button variant="outline" {...props} ref={ref}>
        {children}
        <ChevronsUpDownIcon
          className="shrink-0 text-muted-foreground"
          size={16}
        />
      </Button>
    </PopoverTrigger>
  );
};

export type MicSelectorContentProps = ComponentProps<typeof Command> & {
  popoverOptions?: ComponentProps<typeof PopoverContent>;
};

// [契约] 展开顺序决定覆盖权：className 先与 p-0 合并，再叠调用方的 popoverOptions，因此宽度与内边距都能被覆盖。
// 子组件 Command 的 value 与 onValueChange 接的是 context，props 在后展开可以覆盖，但覆盖后选择逻辑就与 MicSelector 脱钩。
export const MicSelectorContent = ({
  className,
  popoverOptions,
  ...props
}: MicSelectorContentProps) => {
  const { width, onValueChange, value } = useContext(MicSelectorContext);

  return (
    <PopoverContent
      className={cn("p-0", className)}
      style={{ width }}
      {...popoverOptions}
    >
      <Command onValueChange={onValueChange} value={value} {...props} />
    </PopoverContent>
  );
};

export type MicSelectorInputProps = ComponentProps<typeof CommandInput> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

// [权衡] 占位符是写死的英文，props 在其后展开所以调用方可以覆盖，但默认不会跟随语言切换。
// 该组件只做透传，不接 context；搜索状态归 cmdk 内部管理，不要在这里再接一份 value。
export const MicSelectorInput = ({ ...props }: MicSelectorInputProps) => (
  <CommandInput placeholder="Search microphones..." {...props} />
);

export type MicSelectorListProps = Omit<
  ComponentProps<typeof CommandList>,
  "children"
> & {
  children: (devices: MediaDeviceInfo[]) => ReactNode;
};

// [契约] children 是渲染函数而非节点：每次渲染都用最新 devices 调用一次，调用方不要在内部再 memo 设备数组。
// 空列表交给 MicSelectorEmpty，这里不做长度判断，避免出现两套空态文案。
export const MicSelectorList = ({
  children,
  ...props
}: MicSelectorListProps) => {
  const { data } = useContext(MicSelectorContext);

  return <CommandList {...props}>{children(data)}</CommandList>;
};

export type MicSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const MicSelectorEmpty = ({
  children = "No microphone found.",
  ...props
}: MicSelectorEmptyProps) => <CommandEmpty {...props}>{children}</CommandEmpty>;

export type MicSelectorItemProps = ComponentProps<typeof CommandItem>;

// [契约] 选中即关闭，这是单选麦克风面板的既定交互；多选需求不能在这里改，应另建组件。
// onSelect 由 cmdk 在点击或回车时触发，传入的是该 Item 的 value，也就是 deviceId。
export const MicSelectorItem = (props: MicSelectorItemProps) => {
  const { onValueChange, onOpenChange } = useContext(MicSelectorContext);

  const handleSelect = useCallback(
    (currentValue: string) => {
      // [失败路径] 顺序不能反：先回写选中值再关闭面板，关闭会让 cmdk 卸载列表，后写的回调可能不再执行。
      // 两个回调都是可选，未包 Provider 时静默无操作，不会抛错。
      onValueChange?.(currentValue);
      onOpenChange?.(false);
    },
    [onValueChange, onOpenChange]
  );

  return <CommandItem onSelect={handleSelect} {...props} />;
};

export type MicSelectorLabelProps = ComponentProps<"span"> & {
  device: MediaDeviceInfo;
};

export const MicSelectorLabel = ({
  device,
  className,
  ...props
}: MicSelectorLabelProps) => {
  // [失败路径] 没有后缀时直接渲染原始 label，不做裁剪；无权限枚举下 label 为空也走这条路径。
  // match 结果第 0 项是完整匹配、第 1 项才是 id，下面的解构依赖这个顺序。
  const matches = device.label.match(deviceIdRegex);

  if (!matches) {
    return (
      <span className={className} {...props}>
        {device.label}
      </span>
    );
  }

  const [, deviceId] = matches;
  // [权衡] 这里不 trim：后缀前的空格属于原始 label，裁掉会改变所有设备的显示文本，属无必要的视觉变更。
  // 替换只删后缀本身，因此渲染时会再补一个空格，个别设备名自带空格时会出现双空格。
  // name 可能为空，此时原样渲染空 span，不要兜底成「麦克风」之类的假名称。
  const name = device.label.replace(deviceIdRegex, "");

  return (
    <span className={className} {...props}>
      <span>{name}</span>
      <span className="text-muted-foreground"> ({deviceId})</span>
    </span>
  );
};

export type MicSelectorValueProps = ComponentProps<"span">;

export const MicSelectorValue = ({
  className,
  ...props
}: MicSelectorValueProps) => {
  const { data, value } = useContext(MicSelectorContext);
  // [契约] 用 deviceId 而非 label 匹配：同型号设备 label 可能重复，且 label 会随授权状态变化。
  // data 来自 context，设备被拔掉后 find 失败，界面回落为未选择文案而不是崩溃。
  const currentDevice = data.find((d) => d.deviceId === value);

  // [失败路径] 未匹配时展示英文兜底文案，并保留 flex-1 text-left，让触发器宽度不被内容反向撑开。
  // 这里不回写 value：失效的 deviceId 会一直保留到用户重新选择，别在此处偷偷清空。
  if (!currentDevice) {
    return (
      <span className={cn("flex-1 text-left", className)} {...props}>
        Select microphone...
      </span>
    );
  }

  return (
    <MicSelectorLabel
      className={cn("flex-1 text-left", className)}
      device={currentDevice}
      {...props}
    />
  );
};
