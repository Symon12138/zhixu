import { useState } from "react";
import { MoveHorizontal, RotateCcw, Sparkles } from "lucide-react";
import "./DerivativeLab.css";

const X_MAX = 3.4;
const Y_MAX = 12;
const PLOT = { left: 48, right: 500, top: 20, bottom: 250 };

const f = (x: number) => x * x;

const sx = (x: number) => PLOT.left + (x / X_MAX) * (PLOT.right - PLOT.left);
const sy = (y: number) => PLOT.bottom - (y / Y_MAX) * (PLOT.bottom - PLOT.top);

/** y = k·x + b 在绘图区内的两点（裁剪交给 clipPath） */
const lineSegment = (k: number, b: number) => ({
  x1: sx(0),
  y1: sy(b),
  x2: sx(X_MAX),
  y2: sy(k * X_MAX + b),
});

function buildCurvePath(): string {
  const points: string[] = [];
  for (let x = 0; x <= X_MAX + 1e-9; x += 0.05) {
    const xi = Math.min(x, X_MAX);
    points.push(`${sx(xi).toFixed(2)},${sy(f(xi)).toFixed(2)}`);
  }
  return `M ${points.join(" L ")}`;
}

const CURVE_PATH = buildCurvePath();

const GRID_X = [0.5, 1, 1.5, 2, 2.5, 3];
const GRID_Y = [2, 4, 6, 8, 10];

export default function DerivativeLab() {
  const [h, setH] = useState(1);

  const px = 1;
  const qx = 1 + h;
  const secantSlope = 2 + h;
  const tangentSlope = 2;

  const secant = lineSegment(secantSlope, 1 - secantSlope);
  const tangent = lineSegment(tangentSlope, -1);

  const pPoint = { x: sx(px), y: sy(f(px)) };
  const qPoint = { x: sx(qx), y: sy(f(qx)) };

  return (
    <section className="lab-card" aria-label="导数交互实验">
      <header className="lab-header">
        <span className="lab-tag">
          <Sparkles size={13} aria-hidden="true" />
          交互实验
        </span>
        <h2 className="lab-title">让变化，看得见</h2>
      </header>

      <figure className="lab-figure">
        <svg
          viewBox="0 0 520 290"
          className="lab-svg"
          role="img"
          aria-label="函数 f(x)=x² 的图像：点 P 在 x=1 处，点 Q 在 x=1+h 处，连接 P、Q 的割线随 h 减小逐渐逼近 x=1 处的切线"
        >
          <defs>
            <clipPath id="lab-plot-clip">
              <rect
                x={PLOT.left}
                y={PLOT.top}
                width={PLOT.right - PLOT.left}
                height={PLOT.bottom - PLOT.top}
              />
            </clipPath>
          </defs>

          {/* 浅网格 */}
          <g className="lab-grid" aria-hidden="true">
            {GRID_X.map((x) => (
              <line
                key={`gx${x}`}
                x1={sx(x)}
                y1={PLOT.top}
                x2={sx(x)}
                y2={PLOT.bottom}
              />
            ))}
            {GRID_Y.map((y) => (
              <line
                key={`gy${y}`}
                x1={PLOT.left}
                y1={sy(y)}
                x2={PLOT.right}
                y2={sy(y)}
              />
            ))}
          </g>

          {/* 坐标轴 */}
          <g className="lab-axis" aria-hidden="true">
            <line
              x1={PLOT.left}
              y1={PLOT.top}
              x2={PLOT.left}
              y2={PLOT.bottom}
            />
            <line
              x1={PLOT.left}
              y1={PLOT.bottom}
              x2={PLOT.right}
              y2={PLOT.bottom}
            />
            {[1, 2, 3].map((x) => (
              <text
                key={`tx${x}`}
                x={sx(x)}
                y={PLOT.bottom + 18}
                textAnchor="middle"
              >
                {x}
              </text>
            ))}
            {[4, 8].map((y) => (
              <text
                key={`ty${y}`}
                x={PLOT.left - 8}
                y={sy(y) + 4}
                textAnchor="end"
              >
                {y}
              </text>
            ))}
          </g>

          {/* 割线与切线（裁剪在绘图区内） */}
          <g clipPath="url(#lab-plot-clip)" aria-hidden="true">
            <line className="lab-secant" {...secant} />
            <line className="lab-tangent" {...tangent} />
          </g>

          {/* 曲线 */}
          <path className="lab-curve" d={CURVE_PATH} aria-hidden="true" />

          {/* 曲线名 */}
          <text className="lab-curve-label" x={60} y={44} aria-hidden="true">
            f(x) = x²
          </text>

          {/* P、Q 两点 */}
          <g aria-hidden="true">
            <circle className="lab-point-p" cx={pPoint.x} cy={pPoint.y} r={5} />
            <circle className="lab-point-q" cx={qPoint.x} cy={qPoint.y} r={5} />
            <text
              className="lab-point-label"
              x={pPoint.x - 10}
              y={pPoint.y + 18}
              textAnchor="end"
            >
              P
            </text>
            <text
              className="lab-point-label lab-point-label-q"
              x={qPoint.x + 10}
              y={qPoint.y - 10}
            >
              Q
            </text>
          </g>
        </svg>
      </figure>

      <div className="lab-slider-row">
        <label className="lab-slider-label" htmlFor="lab-h-slider">
          <MoveHorizontal size={15} aria-hidden="true" />
          拖动滑块，让 Q 靠近 P
        </label>
        <input
          id="lab-h-slider"
          className="lab-slider"
          type="range"
          min={0.05}
          max={2}
          step={0.05}
          value={h}
          onChange={(e) => setH(Number(e.target.value))}
          aria-label="调整 h 的取值"
          aria-valuetext={`h = ${h.toFixed(2)}`}
        />
        <button
          type="button"
          className="lab-reset"
          onClick={() => setH(1)}
          aria-label="重置滑块"
        >
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      </div>

      <dl className="lab-readings" aria-live="polite">
        <div className="lab-reading">
          <dt>h</dt>
          <dd>{h.toFixed(2)}</dd>
        </div>
        <div className="lab-reading">
          <dt>平均变化率（割线斜率）</dt>
          <dd className="lab-reading-secant">{secantSlope.toFixed(2)}</dd>
        </div>
        <div className="lab-reading">
          <dt>瞬时变化率（切线斜率）</dt>
          <dd className="lab-reading-tangent">{tangentSlope}</dd>
        </div>
      </dl>

      <p className="lab-note">
        当 h 变小，Q 沿曲线滑向 P，割线的斜率 {secantSlope.toFixed(2)}{" "}
        无限逼近切线的斜率 2 —— 平均变化的极限，就是瞬时变化率，也就是导数。
      </p>
    </section>
  );
}
