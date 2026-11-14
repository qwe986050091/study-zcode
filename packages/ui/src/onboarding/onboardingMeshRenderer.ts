// INV-01 无 WebGL 时返回空：守住位置 空值判断；改错故障 老设备上整页报错。
// INV-02 着色器编译失败清理资源：守住位置 提前删除；改错故障 反复重试泄漏着色器。
// INV-03 链接失败删除程序：守住位置 失败分支；改错故障 半链接程序继续使用。
// INV-04 缓冲区失败连带删程序：守住位置 失败分支；改错故障 失败路径残留程序对象。
// INV-05 绘制尺寸上限固定：守住位置 缩放常数；改错故障 高分屏上 GPU 过载。
// INV-06 尺寸取整且至少一像素：守住位置 取整与下限；改错故障 零尺寸画布报错。
// INV-07 只在尺寸变化时重置画布：守住位置 比较判断；改错故障 每帧重置导致闪烁。
// INV-08 视口跟随实际像素：守住位置 视口调用；改错故障 画面被拉伸。
// INV-09 宽高比用逻辑尺寸：守住位置 除法入参；改错故障 光晕位置随缩放漂移。
// INV-10 颜色按分量展开：守住位置 三参调用；改错故障 默认色不生效。
// INV-11 时间参数只读外部时钟：守住位置 入参；改错故障 同帧多处渲染不一致。
// INV-12 固定绘制六个顶点：守住位置 常量；改错故障 只画出半个屏幕。
// INV-13 释放按后建先删：守住位置 语句顺序；改错故障 释放后仍持有程序。
// INV-14 释放不触碰共享上下文：守住位置 职责范围；改错故障 其他渲染器被连带销毁。
// INV-15 句柄全部取自同一程序：守住位置 查找调用；改错故障 取样器指向别的程序。
// INV-16 顶点属性位置为零基索引：守住位置 查找结果；改错故障 属性未启用画面全黑。
// INV-17 着色器源码为常量：守住位置 模块顶层；改错故障 每帧重新拼接源码。
// INV-18 不读取 DOM 全局状态：守住位置 入参画布；改错故障 多实例互相覆盖。
//
// 模块职责：为新引导背景创建一个极简的灰阶流场渲染器。
// 状态所有权：WebGL 资源归本闭包，调用方只持有绘制与释放方法。
// 阅读顺序：先看着色器源码，再看资源装配，最后看绘制与释放。
// 独立实现的柔和灰阶流场，不包含第三方付费预设代码。
const vertexSource = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`;
const fragmentSource = `
precision mediump float;
varying vec2 uv;
uniform float time;
uniform float aspect;
uniform vec3 tint;
void main() {
  vec2 p = vec2(uv.x, 1.0 - uv.y);
  float t = time * 2.0;
  vec2 q = p;
  q.x += 0.17 * sin(p.y * 4.1 + t) + 0.08 * cos(p.y * 7.0 - t * 0.6);
  q.y += 0.12 * sin(p.x * 3.5 - t * 0.8);
  float sweep = q.x * 0.78 + q.y * 0.58;
  float band = exp(-pow((sweep - 0.7 - 0.06 * sin(t)) * 4.0, 2.0));
  float fold = smoothstep(0.29, 0.64, sweep) * (1.0 - smoothstep(0.65, 1.18, sweep));
  float halo = exp(-length((p - vec2(0.82, 0.22)) * vec2(aspect, 1.0)) * 2.4);
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  // 下半区逐渐收暗，避免背景亮度变化经过固定文案。
  float shade = 1.0 - smoothstep(0.42, 0.88, p.y);
  float light = (band * 0.30 + fold * 0.12 + halo * 0.14) * (0.3 + 0.7 * shade);
  float alpha = clamp(light + grain * 0.012, 0.0, 0.55);
  gl_FragColor = vec4(tint * alpha, alpha);
}
`;

// getContext("webgl") 返回 null 时直接返回 null
// compile 失败先 deleteShader，program 失败再删两个 shader
// 两个 shader attach 到 program 后立即 deleteShader
// 返回对象只暴露 draw 与 dispose
export function createOnboardingMeshRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader);
    return null;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  if (!vertex) return null;
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!fragment) {
    gl.deleteShader(vertex);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const time = gl.getUniformLocation(program, "time");
  const aspect = gl.getUniformLocation(program, "aspect");
  const tint = gl.getUniformLocation(program, "tint");
  // draw 用 Math.min(1, 960 / max(w, h)) 限制尺寸
  // canvas.width / height 与目标值不同才赋值
  // aspect uniform 取 width / height，不用缩放后尺寸
  // drawArrays 以 gl.TRIANGLES 与 6 个顶点做一次绘制
  return {
    draw(
      seconds: number,
      width: number,
      height: number,
      color: readonly [number, number, number] = [1, 1, 1],
    ) {
      const scale = Math.min(1, 960 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform3f(tint, ...color);
      gl.uniform1f(time, seconds);
      gl.uniform1f(aspect, width / height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    // dispose 先 deleteBuffer，再 deleteProgram
    // dispose 只删本实例的 buffer 与 program
    // WebGL 对重复 delete 不报错，dispose 不另设幂等标记
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
