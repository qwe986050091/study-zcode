// INV-01 单计时器：守住位置 启动函数内的句柄；改错故障：多轮动画互相叠加，画面抖动。
// INV-02 不动画化：守住位置 全部计时回调；改错故障：动效触发 React 重渲染拖慢工作流。
// INV-03 纯映射：守住位置 faceState；改错故障：未知状态抛错导致整站渲染失败。
// INV-04 表全量：守住位置 两张表情表；改错故障：新增状态读到 undefined 表情。
// INV-05 减动效尊重：守住位置 减少动效偏好判断；改错故障：系统偏好关闭后仍持续播放。
// INV-06 可见性暂停：守住位置 交叉观察器；改错故障：离屏站持续跑定时器浪费 CPU。
// INV-07 文档隐藏暂停：守住位置 visibilitychange 处理；改错故障：后台标签页仍在计时。
// INV-08 重建清态：守住位置 restart；改错故障：恢复后沿用旧轮次与旧朝向。
// INV-09 偶发有界：守住位置 换脸概率；改错故障：每轮都换脸，观察者看不出基础动作。
// INV-10 去重上枚：守住位置 候选过滤；改错故障：同一偶发表情连续出现两次。
// INV-11 空候选回退：守住位置 候选池选择；改错故障：过滤为空时抽不到表情。
// INV-12 起手缓冲：守住位置 前两轮判断；改错故障：一开始就换脸，缺少基础节奏。
// INV-13 过渡分两段：守住位置 morph；改错故障：圆眼直跳斜切眼，视觉突兀。
// INV-14 位移归零：守住位置 base；改错故障：上一轮位移残留，脸停在偏移位置。
// INV-15 难过偏移：守住位置 base 的纵向位移；改错故障：难过态与常态位置完全一致，缺少下沉感。
// INV-16 拖动清理：守住位置 返回的清理函数；改错故障：卸载后定时器继续跑并写已销毁节点。
// INV-17 监听对称：守住位置 事件注册与移除；改错故障：重复挂载后监听累积，动画倍速。
// INV-18 数据出口单一：守住位置 dataset 写入；改错故障：样式表与脚本各写一套状态，互相覆盖。
//
// 模块职责：工作流站脸的表情映射与基于定时器的微动效循环。
// 状态所有权：状态全在 DOM 数据集与闭包内，不进入 React 状态。
// 阅读顺序：状态映射 → 基础表 → 启动函数 → 停顿与换脸 → 循环 → 重建。
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

export type FaceState = "waiting" | "scanning" | "content" | "sad";
export type EyeExpression = "dots" | "pill" | "happy" | "sleepy" | "focused" | "sad" | "confused";
// faceState 把 running / done / failed 分别映射为 scanning / content / sad。
// 其余状态一律返回 "waiting"，faceState 不抛出。
// faceState 是纯函数，测试可直接断言映射结果。
//
export function faceState(status: StepRunStatus | undefined): FaceState {
  return status === "running"
    ? "scanning"
    : status === "done"
      ? "content"
      : status === "failed"
        ? "sad"
        : "waiting";
}
// 每个状态各有一张基础表情，循环里反复回到它。
// 表是全量映射，新增状态必须同时补齐。
//
export const BASE_EXPRESSION: Record<FaceState, EyeExpression> = {
  waiting: "dots",
  scanning: "pill",
  content: "happy",
  sad: "sad",
};
// 只有扫描态有偶发表情，其余状态保持单一表情。
// 空数组表示该状态不做花样切换。
//
const SPECIAL: Record<FaceState, readonly EyeExpression[]> = {
  scanning: ["focused", "confused"],
  waiting: [],
  content: [],
  sad: [],
};

/** 一张脸只有一个待执行计时器；DOM 动作不触发整个工作流的 React 重渲染。 */
// 整个动效由定时器链驱动，不进入 React 渲染。
// random(min, max) 是唯一延迟生成入口，范围由调用点传入。
// face.dataset.motion 是动效唯一出口，样式表按该属性切换。
// base() 每次把 --wf-face-x 与 --wf-face-y 归零，避免上一轮位移残留。
// sad 态在 base() 里把 --wf-face-y 设为 0.3px，常态保持 0px。
//
export function startFaceMotion(face: SVGSVGElement, state: FaceState): () => void {
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = true;
  let rounds = 0;
  let lookingLeft = false;
  let previous: EyeExpression | undefined;
  const random = (min: number, max: number) => min + Math.random() * (max - min);
  const later = (delay: number, action: () => void) => {
    timer = setTimeout(action, delay);
  };
  const motion = (value: string) => {
    face.dataset.motion = value;
  };
  const base = () => {
    face.dataset.expression = BASE_EXPRESSION[state];
    motion("idle");
    face.style.setProperty("--wf-face-x", "0px");
    face.style.setProperty("--wf-face-y", state === "sad" ? "0.3px" : "0px");
  };
  const pause = () => {
    motion("idle");
    later(
      state === "waiting"
        ? random(1500, 3000)
        : state === "scanning"
          ? random(1500, 3500)
          : state === "sad"
            ? random(1800, 4000)
            : random(6000, 10000),
      cycle,
    );
  };
  // 闭眼时换轮廓，避免从圆眼直接跳到斜切眼；返回基础表情也使用同样的过渡。
  const morph = (expression: EyeExpression, next: () => void) => {
    motion("morph");
    later(80, () => {
      face.dataset.expression = expression;
      later(100, () => {
        motion("idle");
        next();
      });
    });
  };
  // SPECIAL.scanning 是唯一非空偶发表情表，概率 0.45 高于其余态的 0.25。
  // rounds < 2 时直接 pause()，保证基础动作先被看到。
  // choices 由 SPECIAL[state] 过滤掉 previous，避免同一表情连续出现。
  // choices 为空时回退 SPECIAL[state]，保证 pool 非空。
  // confused 的 hold 调用 random(2200, 3800)，其余状态返回 random(800, 1800)。
  //
  const maybeExpression = () => {
    rounds++;
    const probability = state === "scanning" ? 0.45 : 0.25;
    if (rounds < 2 || Math.random() >= probability) {
      pause();
      return;
    }
    const choices = SPECIAL[state].filter((e) => e !== previous);
    // 只有一种偶发表情的结果态也要经过两轮基础动作，不能连续换脸。
    const pool = choices.length ? choices : SPECIAL[state];
    const expression = pool[Math.floor(Math.random() * pool.length)]!;
    previous = expression;
    rounds = 0;
    const hold = expression === "confused" ? random(2200, 3800) : random(800, 1800);
    morph(expression, () => later(hold, () => morph(BASE_EXPRESSION[state], pause)));
  };
  const glance = () => {
    motion("glance");
    // 平移要换到脸的另一侧；旧的 ±0.65 微移只像眼睛抖动，看不出左右驻留。
    lookingLeft = !lookingLeft;
    face.style.setProperty("--wf-face-x", lookingLeft ? "-4px" : "0px");
    later(360, maybeExpression);
  };
  // state 为 "waiting" 时 cycle 只写 "dots-wave"，不进入扫描分支。
  // state 为 "sad" 时先按 floats 漂浮，再按 0.4 概率决定是否颤抖。
  // state 为 "content" 时先 hop，再 blink，最后把 expression 复位为 "happy"。
  // state 为 "scanning" 时只 blink 并调用 glance，不做跳跃。
  // restart() 把 rounds 与 lookingLeft 清零，再调用 base() 从基础态重建。
  // 卸载时清计时器并移除事件监听，保证回调不再触达已销毁节点。
  function cycle() {
    if (state === "waiting") {
      motion("dots-wave");
      later(900, pause);
      return;
    }
    if (state === "sad") {
      const floats = Math.random() < 0.5 ? 1 : 2;
      face.style.setProperty("--wf-face-floats", String(floats));
      motion("float");
      later(floats * 600, () => {
        if (Math.random() >= 0.4) {
          pause();
          return;
        }
        morph("focused", () => {
          const shakes = 3 + Math.floor(Math.random() * 3);
          face.style.setProperty("--wf-face-shakes", String(shakes));
          motion("shake");
          later(shakes * 90, () => {
            motion("idle");
            later(random(500, 1000), () => morph("sad", pause));
          });
        });
      });
      return;
    }
    if (state === "content") {
      const hops = Math.random() < 0.5 ? 2 : 3;
      face.style.setProperty("--wf-face-hops", String(hops));
      motion("hop");
      later(hops * 240, () => {
        face.dataset.expression = "pill";
        motion("idle");
        later(250, () => {
          const duration = random(260, 320);
          face.style.setProperty("--wf-face-blinks", "1");
          face.style.setProperty("--wf-face-blink-time", `${duration}ms`);
          motion("blink");
          later(duration, () => {
            face.dataset.expression = "happy";
            pause();
          });
        });
      });
    } else {
      const blinks = Math.random() < 0.5 ? 2 : 3;
      const duration = state === "scanning" ? random(200, 260) : random(260, 320);
      face.style.setProperty("--wf-face-blinks", String(blinks));
      face.style.setProperty("--wf-face-blink-time", `${duration}ms`);
      motion("blink");
      later(duration * blinks, glance);
    }
  }
  const restart = () => {
    clearTimeout(timer);
    timer = undefined;
    rounds = 0;
    lookingLeft = false;
    base();
    if (!document.hidden && !media?.matches && visible) later(random(1200, 2800), cycle);
  };
  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          const next = entries[0]?.isIntersecting ?? true;
          if (next !== visible) {
            visible = next;
            restart();
          }
        });
  observer?.observe(face);
  document.addEventListener("visibilitychange", restart);
  media?.addEventListener?.("change", restart);
  restart();
  return () => {
    clearTimeout(timer);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", restart);
    media?.removeEventListener?.("change", restart);
    base();
  };
}
