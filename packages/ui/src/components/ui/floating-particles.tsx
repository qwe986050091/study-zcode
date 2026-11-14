// INV-01 帧率上限：守住位置 帧间隔常量与跳帧判断；改错故障：每帧都绘制，主线程长期满载。
// INV-02 静态参数：守住位置 模块级粒子表；改错故障：每次挂载重新随机，视觉抖动且浪费计算。
// INV-03 相位错开：守住位置 phaseOffset 的取值；改错故障：所有粒子同步起落，像呼吸块而非散点。
// INV-04 稳态起点：守住位置 settled 的起始时间偏移；改错故障：恢复入场时仍从空场逐个冒出。
// INV-05 精灵复用：守住位置 尺寸变化时生成的两张离屏位图；改错故障：每帧生成辉光，渲染进程掉帧。
// INV-06 像素比夹取：守住位置 画布缩放比例；改错故障：高分屏显存暴涨或低分屏发糊。
// INV-07 颜色来源：守住位置 CSS 变量读取；改错故障：硬编码颜色导致主题切换后粒子不跟随。
// INV-08 减动效：守住位置 媒体查询与首帧取消；改错故障：系统要求减少动态时仍然循环绘制。
// INV-09 插值边界：守住位置 分段索引夹取；改错故障：进度越界读到 undefined。
// INV-10 除零兜底：守住位置 段内分母；改错故障：时间轴退化时产生 NaN 坐标。
// INV-11 上下文缺失：守住位置 2D 上下文判空；改错故障：无上下文环境直接抛错白屏。
// INV-12 尺寸节流：守住位置 resize 的等值早退；改错故障：每次观察回调都重建画布与精灵。
// INV-13 清理完整：守住位置 effect 返回的清理函数；改错故障：卸载后仍持有观察者与帧回调。
// INV-14 合成隔离：守住位置 外层容器的 aria-hidden 与 pointer-events；改错故障：粒子层拦截点击或被读屏朗读。
// INV-15 迭代键稳定：守住位置 元素列表的索引键；改错故障：粒子参数错位到别的下标。
// INV-16 组件标识：守住位置 memo 包裹；改错故障：父层重渲染连带重跑整段动画。
// INV-17 高亮选取：守住位置 高亮下标集合；改错故障：亮点聚在同一区域或全部熄灭。
// INV-18 透明度归一：守住位置 绘制后的 globalAlpha 复位；改错故障：后续绘制沿用上个粒子的透明度。
//
// 模块职责：用单张 Canvas 渲染高速粒子底纹，包含静态参数生成、分段插值、精灵缓存与帧循环。
// 状态所有权：粒子参数在模块加载时固定；画布尺寸、精灵与帧计时归 effect 私有。
// 阅读顺序：常量与粒子表 → 随机与插值工具 → 精灵生成 → 组件与帧循环。
import { memo, useEffect, useRef } from "react";
import { cn } from "@/components/lib/utils.js";

// 粒子总量与帧率上限：96 个粒子配合 30fps 上限，保证不同窗口尺寸下密度观感一致。
// 尺寸常量：精灵 24px、普通半径 1、高亮半径 1.5 与辉光 7px，共同决定粒子大小与光晕范围。
// 高亮下标按种子化的起始横坐标挑选，横向覆盖约 8% 到 92%，避免亮点挤在同一区域。
//
const PARTICLE_COUNT = 96;
const PARTICLE_FRAME_INTERVAL_MS = 1_000 / 30;
const PARTICLE_SPRITE_SIZE = 24;
const PARTICLE_RADIUS = 1;
const HIGHLIGHT_PARTICLE_RADIUS = 1.5;
const HIGHLIGHT_PARTICLE_BLUR = 7;
// 高亮 index 按 seeded startLeft 选取，横向覆盖约 8%–92%，避免亮点集中在同一区域。
const HIGHLIGHT_PARTICLE_INDICES = new Set([1, 22, 42, 56, 57, 74, 90]);
// 超过最大相位偏移 2.6s + 最长周期 11.2s，粒子直接处于循环稳态，不再从空场逐个冒出。
const PARTICLE_SETTLED_ELAPSED_MS = 14_000;

// 单粒子参数：全部在模块加载时由伪随机函数一次性生成，运行期不再随机。
// 周期与相位错开，避免所有粒子同步起落。
// 高亮标记决定绘制时换用带辉光的精灵位图。
//
interface FloatingParticle {
  cycleDuration: number;
  highlight: boolean;
  horizontalDrift: number;
  opacity: number;
  phaseOffset: number;
  riseDistance: number;
  startLeft: number;
  startTop: number;
  swayDistance: number;
}

// 伪随机：正弦散列把下标与盐映射到 0~1，同一输入永远得到同一输出。
// 只用于生成静态粒子参数，不参与安全或唯一性判断。
// `seededUnit` 的 `salt` 决定取值维度：换一个盐值就是另一条近似独立的序列。
//
function seededUnit(index: number, salt: number) {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

// 粒子表：模块级只算一次，所有实例共享，避免每次挂载重新生成。
// 起始纵坐标从 94% 起步，让粒子贴着底部升起而不是凭空出现在画面中间。
// 上升距离与横向漂移决定主运动方向与偏移幅度。
// `opacity` 按 `highlight` 分两档区间：高亮粒子始终更实。
//
const PARTICLES: FloatingParticle[] = Array.from({ length: PARTICLE_COUNT }, (_, index) => {
  const highlight = HIGHLIGHT_PARTICLE_INDICES.has(index);
  return {
    startTop: 94 + seededUnit(index, 1) * 6,
    startLeft: seededUnit(index, 2) * 100,
    riseDistance: 72 + seededUnit(index, 3) * 64,
    horizontalDrift: seededUnit(index, 4) * 36 - 18,
    swayDistance: seededUnit(index, 5) * 16 - 8,
    opacity: highlight ? 0.82 + seededUnit(index, 6) * 0.16 : 0.4 + seededUnit(index, 6) * 0.32,
    cycleDuration: 6.4 + seededUnit(index, 7) * 4.8,
    phaseOffset: seededUnit(index, 8) * 2.6,
    highlight,
  };
});

const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;

// 分段线性插值：时间轴固定为 0、0.12、0.38、0.7、1，通道值按段线性过渡。
// 进度落在首段之前或末段之后都被夹到端点，不会越界取值。
// 分母用极小常量兜底，避免时间轴退化时除零。
//
function interpolateParticleChannel(progress: number, values: readonly number[]): number {
  const times = [0, 0.12, 0.38, 0.7, 1];
  const nextIndex = times.findIndex((time) => time > progress);
  const segment = Math.max(0, Math.min(times.length - 2, nextIndex - 1));
  const start = times[segment] ?? 0;
  const end = times[segment + 1] ?? 1;
  return lerp(
    values[segment] ?? 0,
    values[segment + 1] ?? 0,
    (progress - start) / Math.max(end - start, Number.EPSILON),
  );
}

// 离屏精灵：按设备像素比放大画布，保证高分屏下圆点不糊。
// 取不到 2D 上下文时返回空白画布，调用方据尺寸跳过绘制，不抛错。
// `createParticleSprite` 对高亮粒子额外加 `shadowBlur` 与辉光色：普通粒子只画实心圆。
//
function createParticleSprite({
  color,
  glowColor,
  highlight,
  pixelRatio,
}: {
  color: string;
  glowColor?: string;
  highlight: boolean;
  pixelRatio: number;
}): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = Math.ceil(PARTICLE_SPRITE_SIZE * pixelRatio);
  sprite.height = Math.ceil(PARTICLE_SPRITE_SIZE * pixelRatio);
  const context = sprite.getContext("2d", { alpha: true });
  if (!context) return sprite;

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = color;
  if (highlight) {
    context.shadowBlur = HIGHLIGHT_PARTICLE_BLUR;
    context.shadowColor = glowColor ?? "transparent";
  }
  context.beginPath();
  context.arc(
    PARTICLE_SPRITE_SIZE / 2,
    PARTICLE_SPRITE_SIZE / 2,
    highlight ? HIGHLIGHT_PARTICLE_RADIUS : PARTICLE_RADIUS,
    0,
    Math.PI * 2,
  );
  context.fill();
  return sprite;
}

// 组件外壳：memo 包住整个实现，父层重渲染不会连带重跑动画。
// 稳态标记为真时把起始时间前移，直接从循环稳态绘制，跳过入场冒泡。
//
export const FloatingParticles = memo(function FloatingParticles({
  className,
  settled = false,
}: {
  className?: string;
  /** 直接从循环稳态开始绘制（Highspeed 恢复入场），跳过从空场逐个冒出的起始段。 */
  settled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Bug 根因：旧实现同时挂载 96 个 motion.span 与独立动画控制器，恰好和扩散 Canvas
    // 收尾竞争 renderer 主线程。统一到一张 Canvas 后，交接只剩父层 opacity 合成。
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let animationFrameId = 0;
    let width = 0;
    let height = 0;
    let lastFrameAt = -PARTICLE_FRAME_INTERVAL_MS;
    let color = "";
    let highlightColor = "";
    let glowColor = "";
    let particleSprite: HTMLCanvasElement | undefined;
    let highlightParticleSprite: HTMLCanvasElement | undefined;
    const startedAt = performance.now() - (settled ? PARTICLE_SETTLED_ELAPSED_MS : 0);

    // 尺寸同步：只在包围盒真的变化时才重建画布与精灵，避免无谓重算。
    // 颜色全部从 CSS 变量读取，读取失败时得到空串，精灵仍会生成但不可见。
    //
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width));
      const nextHeight = Math.max(1, Math.round(bounds.height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const style = getComputedStyle(canvas);
      color = style.getPropertyValue("--color-highspeed-particle");
      highlightColor = style.getPropertyValue("--color-highspeed-particle-highlight");
      glowColor = style.getPropertyValue("--color-highspeed-particle-highlight-glow");
      // Bug 根因：Canvas shadowBlur 在部分 Electron/macOS 环境会逐帧触发昂贵的软件栅格化。
      // 辉光只在尺寸变化时离屏生成一次，动画帧复用位图，避免 Renderer 长期满载。
      particleSprite = createParticleSprite({ color, highlight: false, pixelRatio: scale });
      highlightParticleSprite = createParticleSprite({
        color: highlightColor,
        glowColor,
        highlight: true,
        pixelRatio: scale,
      });
    };

    // 帧循环：先排下一帧再判跳帧，保证掉帧后仍能继续。
    // 减少动态时进度固定并降低透明度，首帧后立刻取消后续帧。
    //
    const draw = (now: number) => {
      animationFrameId = window.requestAnimationFrame(draw);
      if (now - lastFrameAt < PARTICLE_FRAME_INTERVAL_MS) return;
      lastFrameAt = now;
      context.clearRect(0, 0, width, height);
      const elapsedSeconds = Math.max(0, (now - startedAt) / 1_000);

      for (const particle of PARTICLES) {
        const activeElapsed = elapsedSeconds - particle.phaseOffset;
        if (activeElapsed < 0 && !reducedMotion) continue;
        const progress = reducedMotion
          ? 0.48
          : (activeElapsed % particle.cycleDuration) / particle.cycleDuration;
        const x = interpolateParticleChannel(progress, [
          0,
          particle.swayDistance * 0.35,
          -particle.swayDistance * 0.25,
          particle.horizontalDrift * 0.65 + particle.swayDistance * 0.2,
          particle.horizontalDrift,
        ]);
        const y = interpolateParticleChannel(progress, [
          0,
          -particle.riseDistance * 0.38,
          -particle.riseDistance * 0.64,
          -particle.riseDistance * 0.82,
          -particle.riseDistance,
        ]);
        const opacity = reducedMotion
          ? particle.opacity * 0.72
          : interpolateParticleChannel(progress, [
              0,
              particle.opacity,
              particle.opacity * 0.92,
              particle.opacity * 0.7,
              0,
            ]);
        const particleScale = interpolateParticleChannel(progress, [0.55, 1.1, 1, 0.8, 0.4]);
        const sprite = particle.highlight ? highlightParticleSprite : particleSprite;
        if (!sprite) continue;
        const spriteSize = PARTICLE_SPRITE_SIZE * particleScale;
        const particleX = (particle.startLeft / 100) * width + x;
        const particleY = (particle.startTop / 100) * height + y;
        context.globalAlpha = opacity;
        context.drawImage(
          sprite,
          particleX - spriteSize / 2,
          particleY - spriteSize / 2,
          spriteSize,
          spriteSize,
        );
      }
      context.globalAlpha = 1;
      if (reducedMotion) window.cancelAnimationFrame(animationFrameId);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    animationFrameId = window.requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [settled]);

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <canvas ref={canvasRef} className="highspeed-particle-canvas absolute inset-0 size-full" />
    </div>
  );
});
