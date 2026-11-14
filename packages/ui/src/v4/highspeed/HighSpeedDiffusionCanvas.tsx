// INV-01 守住位置：本文件只做视觉投影，阶段变化全由三个回调向上汇报；改错故障：组件内直接写 store 会让浮现与真实状态双写。
// INV-02 守住位置：500ms 延迟与 1/30 秒帧间隔是模块级常量；改错故障：挪进 effect 会在依赖变化时重新取值，节奏不稳定。
// INV-03 守住位置：内部画布按 6 CSS px 一格降分辨率；改错故障：按物理像素渲染会让宽屏每帧处理数万像素并阻塞主线程。
// INV-04 守住位置：距离场与三组噪声只在 resize 时计算一次；改错故障：搬回每帧计算会产生秒级 long task。
// INV-05 守住位置：减少动态或取不到 2d 上下文时串行走完三个回调；改错故障：继续排帧会在无画布时空转且永不完成。
// INV-06 守住位置：正常路径的 onComplete 只由 opacity 过渡结束触发；改错故障：用定时器卸载会在 renderer 忙时退化成硬切。
// INV-07 守住位置：过渡结束处理只接受 propertyName 为 opacity；改错故障：其他属性过渡结束会提前终止整个交接。
// INV-08 守住位置：finish 用 completed 标记只放行一次完成信号；改错故障：重复调用会让上层阶段机收到两次完成。
// INV-09 守住位置：翻页与交接共用 startTime 推导的同一进度时钟；改错故障：各自计时会让两个视觉事件失去因果顺序。
// INV-10 守住位置：进度到 0.8 时只发一次 onModelTransitionStart；改错故障：每帧发送会让上层反复触发模型切换。
// INV-11 守住位置：进度到 0.84 先 onHandoffStart 再停止申请动画帧；改错故障：顺序反转会让淡出阶段仍在画像素。
// INV-12 守住位置：不足 1/30 秒的帧只续约下一帧、不写像素；改错故障：去掉节流会在高刷屏上做无效重复计算。
// INV-13 守住位置：cleanup 断开 observer、清定时器、取消动画帧；改错故障：漏任一项都会在卸载后继续写脱离文档的画布。
// INV-14 守住位置：surface 与 accent 从 CSS 变量读取并带兜底色；改错故障：硬编码颜色会让浅色主题出现深色马赛克。
// INV-15 守住位置：内部宽高至少为 1，距离半径也至少为 1；改错故障：0 尺寸会让距离公式产生 NaN 像素。
// INV-16 守住位置：读取缓存场值一律以 ?? 回落到中性值；改错故障：缺省值参与运算会得到全透明或全黑的帧。
// INV-17 守住位置：effect 依赖列出三个回调与 reducedMotion；改错故障：漏依赖会沿用旧闭包，回调指向过期的上层处理器。
// INV-18 守住位置：canvas 标记 aria-hidden 且不接收指针事件；改错故障：保留可聚焦或可点击会让纯装饰层拦截输入。
//
// 模块职责：把 1400ms 的扩散进度映射为马赛克像素，并按 0.8 与 0.84 两个阈值向外发阶段事件。
// 状态所有权：阶段归属上层，本组件只持有 effect 内的帧与定时器句柄，完成信号由 CSS 过渡事件回传。
// 阅读顺序：INV 速查 → 组件契约 → 过渡结束处理 → effect 早返回 → resize 缓存 → 渲染循环 → 收尾清理 → JSX。
import { memo, useCallback, useEffect, useRef, type TransitionEvent } from "react";
import { useReducedMotion } from "motion/react";
import {
  resolveHighSpeedCanvasColor,
  shouldCompleteHighSpeedDiffusion,
  resolveHighSpeedDiffusionDistance,
  resolveHighSpeedDiffusionProgress,
  shouldStartHighSpeedModelSwitch,
} from "@/v4/highspeed/highSpeedDiffusion.js";

// 500ms 延迟让 Composer 的布局与初始淡入先稳定，再画第一帧
// 帧间隔取 1/30 秒，用节流换取主线程余量，视觉上仍是连续动画
// 延迟与帧率是节奏契约，调整时需同时复核 1400ms 总时长与两个进度阈值
// 写成模块级常量而不是 effect 内变量，避免依赖变化时重新求值
// 若把延迟压到 0，首帧会与容器出现同帧竞争，表现为闪一下深色
const HIGHSPEED_DIFFUSION_DELAY_MS = 500;
const HIGHSPEED_DIFFUSION_FRAME_INTERVAL_MS = 1_000 / 30;

// 参考稿的马赛克颗粒约 6px；更高的内部像素密度不会增加可见细节，反而会让宽屏
// Composer 每帧处理数万像素并阻塞 renderer。
const PIXEL_SIZE_CSS_PX = 6;
const SURFACE_FALLBACK: Rgb = [21, 21, 21];
const ACCENT_FALLBACK: Rgb = [179, 146, 255];

type Rgb = readonly [number, number, number];

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const unit = clamp((value - edge0) / (edge1 - edge0));
  return unit * unit * (3 - 2 * unit);
};

const hash = (x: number, y: number, seed: number): number => {
  let value = Math.imul(x + seed * 17, 374_761_393) + Math.imul(y - seed * 31, 668_265_263);
  value = (value ^ (value >>> 13)) >>> 0;
  value = Math.imul(value, 1_274_126_177) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
};

const noise = (x: number, y: number, seed: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const top = mix(hash(x0, y0, seed), hash(x0 + 1, y0, seed), sx);
  const bottom = mix(hash(x0, y0 + 1, seed), hash(x0 + 1, y0 + 1, seed), sx);
  return mix(top, bottom, sy);
};

const fbm = (x: number, y: number, seed: number): number => {
  let sum = 0;
  let amplitude = 0.58;
  let frequency = 1;
  for (let octave = 0; octave < 3; octave += 1) {
    sum += noise(x * frequency, y * frequency, seed + octave * 19) * amplitude;
    frequency *= 2.02;
    amplitude *= 0.48;
  }
  return sum;
};

// 对外只暴露三个无参回调，不传进度也不传元素，事件语义保持最小
// onModelTransitionStart 在进度 0.8 触发，供工具栏提前翻页
// onHandoffStart 表示逐像素绘制结束，onComplete 才表示可以卸载画布
// 顺序固定为先翻页、再交接、最后完成，任何回调都不应由本组件重复调用
interface HighSpeedDiffusionCanvasProps {
  onModelTransitionStart: () => void;
  onHandoffStart: () => void;
  onComplete: () => void;
}

// memo 包裹避免父组件无关重渲染导致整段动画重新挂载
// props 解构即全部输入，组件不读取任何 store 或上下文
// 纯装饰层不参与语义树，视觉状态完全由上面的回调向上汇报
// 回调必须保持引用稳定，否则 effect 会先清理再重启，动画从 0 重放
export const HighSpeedDiffusionCanvas = memo(function HighSpeedDiffusionCanvas({
  onModelTransitionStart,
  onHandoffStart,
  onComplete,
}: HighSpeedDiffusionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  // 只认 opacity 的过渡结束，过滤掉尺寸或其他属性的过渡事件
  // 这是画布唯一的卸载边界，真实淡出窗口由浏览器决定而非定时器
  // React 提交 handoff 相位可能晚于扩散回调，因此不能在渲染循环里直接完成
  // 回调依赖 onComplete，父级每次换新函数都会让这个处理器重建
  const handleHandoffTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLCanvasElement>) => {
      if (event.propertyName !== "opacity") return;

      // Bug 根因：旧实现从扩散回调开始计时卸载 Canvas，但 React 提交 handoff 相位可能更晚，
      // renderer 忙时会压缩甚至吞掉真实淡出窗口。以 CSS opacity 过渡完成事件作为唯一卸载边界。
      onComplete();
    },
    [onComplete],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 偏好减少动态时三条回调同步走完，界面直接进入目标态
    // 取不到 2d 上下文同样走这条短路，保证动画不会永远停在开始
    // 两个早返回都在 effect 内完成，不注册定时器也不申请动画帧
    // 若把短路改成异步，卸载清理时会与已排队的回调竞争
    if (reducedMotion) {
      onModelTransitionStart();
      onHandoffStart();
      onComplete();
      return;
    }

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      onModelTransitionStart();
      onHandoffStart();
      onComplete();
      return;
    }

    let animationFrameId = 0;
    let delayTimerId = 0;
    let startTime = 0;
    let lastRenderTime = -HIGHSPEED_DIFFUSION_FRAME_INTERVAL_MS;
    let width = 0;
    let height = 0;
    let imageData: ImageData | null = null;
    let pixels: Uint8ClampedArray | null = null;
    let distanceField: Float32Array | null = null;
    let broadNoiseField: Float32Array | null = null;
    let detailNoiseField: Float32Array | null = null;
    let grainField: Float32Array | null = null;
    let surface: Rgb = SURFACE_FALLBACK;
    let accent: Rgb = ACCENT_FALLBACK;
    let completed = false;
    let modelTransitionStarted = false;

    // 内部尺寸按 6 CSS px 一格向上取整，宽高至少为 1 以避开除零
    // 尺寸未变时立即返回，避免 ResizeObserver 抖动引发反复分配
    // 每次真正变化都重建 ImageData 与四个 Float32Array，旧引用整体丢弃
    // 颜色在这里随尺寸变化一并重读 CSS 变量，避免每帧读计算样式
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.ceil(bounds.width / PIXEL_SIZE_CSS_PX));
      const nextHeight = Math.max(1, Math.ceil(bounds.height / PIXEL_SIZE_CSS_PX));
      if (nextWidth === width && nextHeight === height) return;

      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = false;
      imageData = context.createImageData(width, height);
      pixels = imageData.data;
      const fieldSize = width * height;
      distanceField = new Float32Array(fieldSize);
      broadNoiseField = new Float32Array(fieldSize);
      detailNoiseField = new Float32Array(fieldSize);
      grainField = new Float32Array(fieldSize);

      const blockWidth = Math.ceil(width / 2);
      const blockHeight = Math.ceil(height / 2);
      const broadBlocks = new Float32Array(blockWidth * blockHeight);
      for (let blockY = 0; blockY < blockHeight; blockY += 1) {
        for (let blockX = 0; blockX < blockWidth; blockX += 1) {
          broadBlocks[blockY * blockWidth + blockX] = fbm(blockX * 0.21, blockY * 0.24, 12);
        }
      }

      // Bug 根因：旧实现每一帧、每个像素都重复计算距离和两组多层噪声，宽屏下会产生
      // 1s 级 long task。尺寸变化时一次性缓存静态场，播放阶段只移动扩散阈值。
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const fieldIndex = y * width + x;
          distanceField[fieldIndex] = resolveHighSpeedDiffusionDistance({
            x: x + 0.5,
            y: y + 0.5,
            width,
            height,
          });
          broadNoiseField[fieldIndex] =
            broadBlocks[Math.floor(y / 2) * blockWidth + Math.floor(x / 2)] ?? 0.5;
          detailNoiseField[fieldIndex] = noise(x * 0.22, y * 0.24, 91);
          grainField[fieldIndex] = (hash(x, y, 47) - 0.5) * 12;
        }
      }

      const computedStyle = getComputedStyle(canvas);
      surface = resolveHighSpeedCanvasColor(
        context,
        computedStyle.getPropertyValue("--color-highspeed-composer-surface"),
        SURFACE_FALLBACK,
      );
      accent = resolveHighSpeedCanvasColor(
        context,
        computedStyle.getPropertyValue("--color-highspeed-accent"),
        ACCENT_FALLBACK,
      );
    };

    const finish = () => {
      if (completed) return;
      completed = true;
      onComplete();
    };

    // 任一缓存缺失就立即 finish，避免在空数据上跑整幅像素循环
    // 两帧间隔不足 1/30 秒时只续约下一帧，不写像素也不推进时钟
    // 进度只由 startTime 与当前时间推导，与帧率无关，掉帧不会拖慢总时长
    // 进度到 0.8 时发出一次翻页信号，标记位保证整个播放只发一次
    const render = (now: number) => {
      if (
        !imageData ||
        !pixels ||
        !distanceField ||
        !broadNoiseField ||
        !detailNoiseField ||
        !grainField
      ) {
        finish();
        return;
      }

      if (now - lastRenderTime < HIGHSPEED_DIFFUSION_FRAME_INTERVAL_MS) {
        animationFrameId = window.requestAnimationFrame(render);
        return;
      }
      lastRenderTime = now;

      const elapsed = now - startTime;
      const progress = resolveHighSpeedDiffusionProgress(elapsed);
      if (!modelTransitionStarted && shouldStartHighSpeedModelSwitch(progress)) {
        // Bug 根因：工具栏过去直接读取激活布尔值，模型先于噪音扩散翻页，两个视觉事件失去因果顺序。
        // 由 Canvas 的同一进度时钟在尾段发出一次性信号，确保翻页提前开始但仍在噪音结束前完成。
        modelTransitionStarted = true;
        onModelTransitionStart();
      }
      const easedProgress = smoothstep(0, 1, progress);
      const frontRadius = mix(-0.12, 1.5, easedProgress);

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const fieldIndex = y * width + x;
          const pixelIndex = (y * width + x) * 4;
          // 每像素的有符号距离由缓存距离场叠加两级噪声偏移得到
          // 噪声只做扰动不改整体形状，改权重会让波边缘出现硬块或散沙
          // alpha 取显隐值与波带亮度的较大者，保证波前始终可见
          // 读写都按 index 直接落进 Uint8ClampedArray，避免逐像素建对象
          const broadNoise = broadNoiseField[fieldIndex] ?? 0.5;
          const detailNoise = detailNoiseField[fieldIndex] ?? 0.5;
          const signedDistance =
            frontRadius -
            (distanceField[fieldIndex] ?? 0) +
            (broadNoise - 0.5) * 0.34 +
            (detailNoise - 0.5) * 0.08;
          const revealed = smoothstep(-0.08, 0.16, signedDistance);
          const waveBand =
            smoothstep(-0.16, 0.02, signedDistance) * (1 - smoothstep(0.12, 0.42, signedDistance));
          const colorAmount = clamp(waveBand * (0.7 + broadNoise * 0.45));
          const grain = grainField[fieldIndex] ?? 0;
          const revealedAlpha = Math.max(revealed, waveBand * 0.92);

          pixels[pixelIndex] = clamp(mix(surface[0], accent[0], colorAmount) + grain, 0, 255);
          pixels[pixelIndex + 1] = clamp(mix(surface[1], accent[1], colorAmount) + grain, 0, 255);
          pixels[pixelIndex + 2] = clamp(mix(surface[2], accent[2], colorAmount) + grain, 0, 255);
          pixels[pixelIndex + 3] = Math.round(clamp(revealedAlpha) * 255);
        }
      }

      context.putImageData(imageData, 0, 0);
      // 进度到 0.84 只做交接，不在此卸载画布
      // 先 onHandoffStart 再 return，从而停掉后续动画帧
      // 真正的卸载交给 opacity 过渡结束，保证淡出有完整时长
      // 若在这里取消淡出或直接置空画布，用户会看到未渐隐的硬切
      if (shouldCompleteHighSpeedDiffusion(progress)) {
        // Bug 根因：完成帧过去用固定 timer 卸载 Canvas，React 提交稍有延迟就会让淡出近似硬切。
        // 这里只停止逐像素循环并切换 handoff，Canvas 由真实 opacity transitionend 再卸载。
        onHandoffStart();
        return;
      }
      animationFrameId = window.requestAnimationFrame(render);
    };

    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    delayTimerId = window.setTimeout(() => {
      startTime = performance.now();
      animationFrameId = window.requestAnimationFrame(render);
    }, HIGHSPEED_DIFFUSION_DELAY_MS);

    // cleanup 断开 ResizeObserver，避免卸载后仍触发 resize 重建缓存
    // 清除未触发的延迟定时器，防止组件已卸载还启动渲染循环
    // 取消已排队的动画帧，否则下一帧会写向已脱离文档的画布
    // 三个句柄都在 effect 闭包内持有，不放到 ref，卸载时无需判空
    // 清理后本地标记随闭包一起释放，重复挂载会得到一套全新状态
    return () => {
      observer?.disconnect();
      window.clearTimeout(delayTimerId);
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [onComplete, onHandoffStart, onModelTransitionStart, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="highspeed-diffusion-canvas"
      aria-hidden="true"
      onTransitionEnd={handleHandoffTransitionEnd}
      className="highspeed-diffusion-canvas pointer-events-none absolute inset-0 size-full"
    />
  );
});
