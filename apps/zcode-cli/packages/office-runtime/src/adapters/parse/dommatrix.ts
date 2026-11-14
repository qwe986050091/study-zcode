/**
 * Minimal 2D DOMMatrix for pdf.js in Node. pdf.js constructs one at module load and uses it for
 * rendering paths the server never takes (it only extracts text); its own fallback needs the native
 * @napi-rs/canvas package, which a bundled plugin cannot ship.
 */

// pdf.js 在模块加载期就会构造 DOMMatrix，而插件以单文件打包、无法附带原生 @napi-rs/canvas，
// 因此这里提供最小 2D 仿射矩阵占位实现。pdf.js 只会在渲染路径用到它，本项目仅抽取文本，
// 数值不参与真正的排版计算，实现只需保证方法存在且返回形状正确。
// 六元组语义与 DOMMatrix 一致：x' = a·x + c·y + e，y' = b·x + d·y + f。
class Matrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  // 入参兼容同形状对象与长度 ≥6 的数组（只取前六项）；缺省或长度不足时保持单位矩阵，不隐式补零。
  constructor(init?: ArrayLike<number> | Matrix2D) {
    if (init && "a" in init)
      [this.a, this.b, this.c, this.d, this.e, this.f] = [
        init.a,
        init.b,
        init.c,
        init.d,
        init.e,
        init.f,
      ];
    else if (init && init.length >= 6)
      [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init).slice(0, 6);
  }

  // 恒为 true：本实现只支持 2D 变换，pdf.js 据此走 2D 分支。
  get is2D() {
    return true;
  }

  // 精确比较六个分量判断是否单位矩阵；pdf.js 用它跳过冗余变换，不能容忍浮点近似。
  get isIdentity() {
    return (
      this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
    );
  }

  // 就地写入六元组并返回 this，供各 *Self 方法链式调用；不创建新对象。
  private set(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    return this;
  }

  // 右乘：this = this × m（参数可为 Matrix2D 或六元组数组），就地修改并返回 this。
  multiplySelf(m: Matrix2D | ArrayLike<number>) {
    const o = m instanceof Matrix2D ? m : new Matrix2D(m);
    return this.set(
      this.a * o.a + this.c * o.b,
      this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d,
      this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e,
      this.b * o.e + this.d * o.f + this.f,
    );
  }

  // 左乘：this = m × this；先复制入参再乘，避免读写同一对象时相互污染。
  preMultiplySelf(m: Matrix2D | ArrayLike<number>) {
    const o = new Matrix2D(m);
    o.multiplySelf(this);
    return this.set(o.a, o.b, o.c, o.d, o.e, o.f);
  }

  // 就地平移：右乘平移矩阵 [1,0,0,1,x,y]；缺省坐标为 0。
  translateSelf(x = 0, y = 0) {
    return this.multiplySelf([1, 0, 0, 1, x, y]);
  }

  // 就地缩放：右乘缩放矩阵；sy 省略时与 sx 相同（等比缩放）。
  scaleSelf(sx = 1, sy = sx) {
    return this.multiplySelf([sx, 0, 0, sy, 0, 0]);
  }

  // 就地求逆；行列式为 0（奇异矩阵）时六分量全部置 NaN 而非抛错，交由 pdf.js 自行判定无效。
  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return this.set(NaN, NaN, NaN, NaN, NaN, NaN);
    return this.set(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det,
    );
  }

  // 非就地版本：返回 this × m 的新矩阵，原对象不变。
  multiply(m: Matrix2D | ArrayLike<number>) {
    return new Matrix2D(this).multiplySelf(m);
  }

  // 非就地版本：返回平移后的新矩阵，原对象不变。
  translate(x = 0, y = 0) {
    return new Matrix2D(this).translateSelf(x, y);
  }

  // 非就地版本：返回缩放后的新矩阵，原对象不变。
  scale(sx = 1, sy = sx) {
    return new Matrix2D(this).scaleSelf(sx, sy);
  }

  // 非就地版本：返回逆矩阵的新实例，原对象不变。
  inverse() {
    return new Matrix2D(this).invertSelf();
  }

  // 把点 (x,y,0,1) 乘以当前矩阵，返回 DOMPoint 形状 {x,y,z,w}；缺失坐标按 0 处理。
  transformPoint(point: { x?: number; y?: number } = {}) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

// 把 Matrix2D 挂到 globalThis.DOMMatrix：仅在缺失时才写入（??=），不覆盖真实实现；
// 幂等，可重复调用；pdf.ts 在 import pdf.js 之前调用一次。
// 副作用仅限全局构造器注入；非浏览器环境（无 DOMMatrix）直接返回，不抛错。
export function installDomMatrix() {
  const scope = globalThis as { DOMMatrix?: unknown };
  scope.DOMMatrix ??= Matrix2D;
}
