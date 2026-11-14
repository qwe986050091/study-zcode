// INV-01 [权衡] media-chrome 组件是唯一渲染出口，本模块不接管播放状态；守住位置：AudioPlayer 与全部 Audio* 包装组件的纯 JSX 返回体；改错故障：出现第二份播放状态，按钮显示与真实音频脱节。
// INV-02 [资源] 媒体元素只能由 AudioPlayerElement 产出且必须带 slot 为 media 的插槽属性；守住位置：AudioPlayerElement 内的 audio 元素；改错故障：MediaController 找不到媒体子节点，全部控件退化为不可用。
// INV-03 [权衡] AudioPlayerProps 以 Omit 去掉 audio 字段；守住位置：AudioPlayerProps 类型声明；改错故障：调用方把 audio 传成 false 时控制器切成视频语义，控件栏布局与图标错乱。
// INV-04 [事务] 默认样式变量先写入、调用方 style 后展开；守住位置：AudioPlayer 的 style 对象内 style 展开位于默认变量之后；改错故障：主题令牌被默认值覆盖，暗色主题下控件文字与轨道对比度丢失。
// INV-05 [失败路径] style 需以 CSSProperties 断言承载 --media-* 自定义属性；守住位置：style 对象尾部的 as 断言；改错故障：类型检查拒绝自定义属性，或删掉断言后丢失 CSS 变量注入。
// INV-06 [并发] 属性展开位于 data-slot 之后；守住位置：MediaController 上的剩余属性展开顺序；改错故障：外部 data-slot 覆盖测试选择器，E2E 与样式钩子同时失效。
// INV-07 [事务] AudioPlayerElementProps 必须以 data 或 src 二选一，不允许两者皆空；守住位置：AudioPlayerElementProps 的联合类型；改错故障：两个分支都不成立时 src 表达式取到 undefined，audio 元素静默无源。
// INV-08 [资源] data 分支只能消费 SpeechResult 音频对象上的 mediaType 与 base64；守住位置：src 表达式的模板字符串；改错故障：字段名漂移后拼出带 undefined 的坏数据 URI，播放立即失败。
// INV-09 [资源] 不创建对象 URL，因此无需回收；守住位置：src 表达式选择内联 base64 而非 Blob 分支；改错故障：改为 createObjectURL 却不清理，切换消息时泄漏 Blob 直至页面关闭。
// INV-10 [并发] 每次渲染都会重建 base64 字符串；守住位置：src 表达式的模板字符串求值时机；改错故障：父层高频重渲染时反复设置同一 src，触发多余加载并打断播放进度。
// INV-11 [权衡] 大音频走内联 base64 会放大约三分之一的内存占用；守住位置：AudioPlayerElementProps 的 data 分支；改错故障：长语音被整段解码进内存，移动端出现明显卡顿甚至崩溃。
// INV-12 [失败路径] 无障碍豁免只针对字幕缺失，字幕责任交给调用方；守住位置：audio 元素前的 oxlint-disable-next-line 注释；改错故障：删除该注释后 lint 直接失败，或误以为组件自带字幕而漏做可访问性。
// INV-13 [并发] src 属性与展开属性中的 src 必须同源；守住位置：audio 元素上 src 先于剩余属性展开的位置；改错故障：外部再传 src 时静默覆盖计算结果，data 分支实际播放另一段音频。
// INV-14 [事务] 所有控件插槽名统一以 audio-player 为前缀；守住位置：各包装组件 data-slot 的字面量；改错故障：选择器与快照断言大面积失效，排查时无法区分控件层级。
// INV-15 [权衡] 图标按钮统一走 Button 的 asChild 而非自绘；守住位置：Play、SeekBackward、SeekForward 三个包装组件的 asChild 结构；改错故障：样式与焦点环脱离设计系统，键盘可达性回退。
// INV-16 [事务] className 先合并设计令牌再由调用方追加；守住位置：cn 调用的参数顺序，内建令牌在前、className 在后；改错故障：外部覆盖丢失等宽数字，时间显示随秒数跳动导致布局抖动。
// INV-17 [事务] seekOffset 默认 10 秒，显式传 0 必须保留；守住位置：SeekBackward 与 SeekForward 的解构默认值；改错故障：改用逻辑或兜底会把 0 变成 10，调用方无法禁用跳转。
// INV-18 [资源] 组件不注册定时器、监听器与副作用，清理责任在 media-chrome；守住位置：全文件无 effect 与事件绑定的纯函数式写法；改错故障：私自加订阅却不返回清理，卸载后仍向已销毁控制器写入。
//
// 模块职责：把 media-chrome 的控制器与按钮封装成项目统一命名的音频播放器组件族，只负责结构组织与设计令牌映射。
// 状态所有权：播放、进度、音量与静音全部由 MediaController 内部的媒体状态机持有，本模块不保存任何播放状态。
// 阅读顺序：先看 AudioPlayerProps 与 AudioPlayer 的样式覆盖顺序，再看 AudioPlayerElement 的 data 与 src 二选一，最后看各控件包装的 asChild 与插槽命名。
"use client";

import { Button } from "../ui/button.js";
import {
  ButtonGroup,
  ButtonGroupText,
} from "../ui/button-group.js";
import { cn } from "../lib/utils.js";
import type { Experimental_SpeechResult as SpeechResult } from "ai";
import {
  MediaControlBar,
  MediaController,
  MediaDurationDisplay,
  MediaMuteButton,
  MediaPlayButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from "media-chrome/react";
import type { ComponentProps, CSSProperties } from "react";

// AudioPlayerProps 从 MediaController 的入参派生，只裁掉 audio 一个字段。
// [权衡] AudioPlayerProps 从 MediaController 裁掉 audio 字段，调用方无法翻转本组件的音频语义。
// 类型里的 audio 字面量与 JSX 上恒真的 audio 属性必须同时存在，缺一即失效。
// 组件解构出 children 与 style，其余属性全部透传给 MediaController。
// data-slot 固定为 audio-player，是整棵控件树的根选择器。
// [失败路径] 若在此追加受控进度一类属性，会与控件内部状态形成双写。
// 默认观感通过 CSS 变量下发，根节点本身不接收 className 覆盖。
export type AudioPlayerProps = Omit<
  ComponentProps<typeof MediaController>,
  "audio"
>;

export const AudioPlayer = ({
  children,
  style,
  ...props
}: AudioPlayerProps) => (
  // audio 属性恒为布尔真值，MediaController 才会挂载音频控件集而非视频控件集。
  // data-slot 写在剩余属性展开之前，允许调用方按需覆盖根节点标识。
  // style 对象集中映射 --media-* 令牌到设计系统的颜色、字体、图标尺寸与圆角，保持单一来源。
  // 令牌值全部取自 --color-* 与 --radius-md，不硬编码任何具体色值。
  // [事务] 对象的最后一个展开是调用方 style，因此外部令牌始终优先。
  // [失败路径] 若把外部 style 放到最前，主题定制会被默认值吞掉且无任何报错。
  // 字体与字号分别绑定 --font-sans 与 10px，保证与消息正文的紧凑排版一致。
  <MediaController
    audio
    data-slot="audio-player"
    style={
      {
        "--media-background-color": "transparent",
        "--media-button-icon-height": "1rem",
        "--media-button-icon-width": "1rem",
        "--media-control-background": "transparent",
        "--media-control-hover-background": "var(--color-accent)",
        "--media-control-padding": "0",
        "--media-font": "var(--font-sans)",
        "--media-font-size": "10px",
        "--media-icon-color": "currentColor",
        "--media-preview-time-background": "var(--color-background)",
        "--media-preview-time-border-radius": "var(--radius-md)",
        "--media-preview-time-text-shadow": "none",
        "--media-primary-color": "var(--color-primary)",
        "--media-range-bar-color": "var(--color-primary)",
        "--media-range-track-background": "var(--color-secondary)",
        "--media-secondary-color": "var(--color-secondary)",
        "--media-text-color": "var(--color-foreground)",
        "--media-tooltip-arrow-display": "none",
        "--media-tooltip-background": "var(--color-background)",
        "--media-tooltip-border-radius": "var(--radius-md)",
        ...style,
      } as CSSProperties
    }
    {...props}
  >
    {children}
  </MediaController>
);

// 联合类型把有 data 与有 src 建模为互斥的两条入口，而非两个可选字段。
// 外层 Omit 去掉原生 src，避免与自定义 src 声明产生冲突。
// data 分支直接复用 SpeechResult 的音频结构，不在此重新定义媒体字段。
// [事务] 判别式写在 JSX 内部，靠 src 是否在属性对象中来完成窄化。
// [失败路径] 两条分支都不满足时没有兜底源，元素会以空 src 渲染并停在未加载态。
// 组件参数用剩余展开接收，保证除 src 以外的原生音频属性都可透传。
// 该类型 AudioPlayerElementProps 不允许出现第三种来源，避免源优先级在两处实现里各自解释。
export type AudioPlayerElementProps = Omit<ComponentProps<"audio">, "src"> &
  (
    | {
        data: SpeechResult["audio"];
      }
    | {
        src: string;
      }
  );

export const AudioPlayerElement = ({ ...props }: AudioPlayerElementProps) => (
  // oxlint-disable-next-line eslint-plugin-jsx-a11y(media-has-caption) -- audio player captions are provided by consumer
  <audio
    data-slot="audio-player-element"
    slot="media"
    src={
      // 三元分支先判 src 是否存在，再回退到 data 分支的模板字符串拼接。
      // 拼接时先写 data 协议头，再依次拼 mediaType、base64 标记与 base64 主体四段。
      // [资源] 内联 base64 不产生 Blob 与对象 URL，卸载时无需额外回收。
      // [权衡] 代价是整段音频常驻字符串，既不能流式加载也不能分段解码。
      // [并发] data 对象身份变化会让表达式产出新字符串，进而触发媒体重新加载。
      // [并发] 播放中的元素被换源会中断当前进度，父层应避免无谓重渲染。
      // [失败路径] base64 损坏或 mediaType 不支持时由浏览器触发媒体错误，控件停在零时长。
      "src" in props
        ? props.src
        : `data:${props.data.mediaType};base64,${props.data.base64}`
    }
    {...props}
  />
);

export type AudioPlayerControlBarProps = ComponentProps<typeof MediaControlBar>;

export const AudioPlayerControlBar = ({
  children,
  ...props
}: AudioPlayerControlBarProps) => (
  // ControlBar 负责把子控件收拢进横向 ButtonGroup，形成单行工具栏。
  // 播放、快退、快进按钮统一由 Button 的 asChild 承载，样式下沉到媒体按钮。
  // [权衡] asChild 让 media-chrome 保留自身事件与 aria 语义，同时继承设计系统外观。
  // 时间与时长显示用 ButtonGroupText 包裹，并以 tabular-nums 固定数字宽度。
  // [事务] className 先放内建令牌再放调用方值，保证覆盖可控且默认不丢。
  // 音量与静音控件同样走 ButtonGroupText，不额外包一层容器。
  // 每个控件都带独立的 audio-player-* 插槽名，便于逐控件定位与断言。
  <MediaControlBar data-slot="audio-player-control-bar" {...props}>
    <ButtonGroup orientation="horizontal">{children}</ButtonGroup>
  </MediaControlBar>
);

export type AudioPlayerPlayButtonProps = ComponentProps<typeof MediaPlayButton>;

export const AudioPlayerPlayButton = ({
  className,
  ...props
}: AudioPlayerPlayButtonProps) => (
  <Button asChild size="icon-sm" variant="outline">
    <MediaPlayButton
      className={cn("bg-transparent", className)}
      data-slot="audio-player-play-button"
      {...props}
    />
  </Button>
);

export type AudioPlayerSeekBackwardButtonProps = ComponentProps<
  typeof MediaSeekBackwardButton
>;

// 快退与快进共享同一套解构写法，seekOffset 默认都是 10 秒。
// [事务] 默认值写在解构位置而非组件体内，显式传入 0 不会被兜底吃掉。
// [失败路径] 若改成逻辑或运算兜底，步长 0 会被替换成 10，禁用跳转的调用失效。
// AudioPlayerSeekForwardButton 与 AudioPlayerSeekBackwardButton 只改插槽与方向，结构样式完全对称。
// seekOffset 直接透传给 media-chrome，由它换算成目标时间点。
// [权衡] 步长不做上下限校验，越界时由媒体元素自行钳制到有效区间。
// 组件保持无状态而不调用 useState，按压过程中不记录任何本地进度副本。
export const AudioPlayerSeekBackwardButton = ({
  seekOffset = 10,
  ...props
}: AudioPlayerSeekBackwardButtonProps) => (
  <Button asChild size="icon-sm" variant="outline">
    <MediaSeekBackwardButton
      data-slot="audio-player-seek-backward-button"
      seekOffset={seekOffset}
      {...props}
    />
  </Button>
);

export type AudioPlayerSeekForwardButtonProps = ComponentProps<
  typeof MediaSeekForwardButton
>;

export const AudioPlayerSeekForwardButton = ({
  seekOffset = 10,
  ...props
}: AudioPlayerSeekForwardButtonProps) => (
  <Button asChild size="icon-sm" variant="outline">
    <MediaSeekForwardButton
      data-slot="audio-player-seek-forward-button"
      seekOffset={seekOffset}
      {...props}
    />
  </Button>
);

export type AudioPlayerTimeDisplayProps = ComponentProps<
  typeof MediaTimeDisplay
>;

export const AudioPlayerTimeDisplay = ({
  className,
  ...props
}: AudioPlayerTimeDisplayProps) => (
  <ButtonGroupText asChild className="bg-transparent">
    <MediaTimeDisplay
      className={cn("tabular-nums", className)}
      data-slot="audio-player-time-display"
      {...props}
    />
  </ButtonGroupText>
);

export type AudioPlayerTimeRangeProps = ComponentProps<typeof MediaTimeRange>;

export const AudioPlayerTimeRange = ({
  className,
  ...props
}: AudioPlayerTimeRangeProps) => (
  <ButtonGroupText asChild className="bg-transparent">
    <MediaTimeRange
      className={cn("", className)}
      data-slot="audio-player-time-range"
      {...props}
    />
  </ButtonGroupText>
);

export type AudioPlayerDurationDisplayProps = ComponentProps<
  typeof MediaDurationDisplay
>;

export const AudioPlayerDurationDisplay = ({
  className,
  ...props
}: AudioPlayerDurationDisplayProps) => (
  <ButtonGroupText asChild className="bg-transparent">
    <MediaDurationDisplay
      className={cn("tabular-nums", className)}
      data-slot="audio-player-duration-display"
      {...props}
    />
  </ButtonGroupText>
);

export type AudioPlayerMuteButtonProps = ComponentProps<typeof MediaMuteButton>;

export const AudioPlayerMuteButton = ({
  className,
  ...props
}: AudioPlayerMuteButtonProps) => (
  <ButtonGroupText asChild className="bg-transparent">
    <MediaMuteButton
      className={cn("", className)}
      data-slot="audio-player-mute-button"
      {...props}
    />
  </ButtonGroupText>
);

export type AudioPlayerVolumeRangeProps = ComponentProps<
  typeof MediaVolumeRange
>;

export const AudioPlayerVolumeRange = ({
  className,
  ...props
}: AudioPlayerVolumeRangeProps) => (
  <ButtonGroupText asChild className="bg-transparent">
    <MediaVolumeRange
      className={cn("", className)}
      data-slot="audio-player-volume-range"
      {...props}
    />
  </ButtonGroupText>
);
