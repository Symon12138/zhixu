import { lazy, Suspense, type CSSProperties } from "react";

/**
 * 导数实验只属于内置导数课程。动态 import 把组件和 DerivativeLab.css
 * 移出首屏；lazy 只创建一次，反复切换课程/小节不会重复下载。
 */
const DerivativeLabView = lazy(() => import("./DerivativeLab"));

const cardStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  // 与 .lab-card 一致：24px 26px 22px，卡片盒子本身保持不动。
  padding: "24px 26px 22px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  color: "var(--text)",
  fontFamily: "inherit",
};

function skeletonBar(width: number | string, height = 12): CSSProperties {
  return {
    display: "block",
    width,
    height,
    borderRadius: 6,
    background: "var(--primary-soft)",
  };
}

/**
 * 骨架按真实卡片的结构排布：标题行、520/290 比例的图、滑块行、
 * 三列读数、两行说明。chunk 到达时替换为 `.lab-card`，高度基本一致，
 * 教学页不会因为公式/实验加载而上下跳动。
 */
export function DerivativeLabFallback() {
  return (
    <>
      <span className="sr-only" role="status">
        正在加载导数交互实验…
      </span>
      <section className="lab-card" style={cardStyle} aria-busy="true" aria-label="导数交互实验">
        <div aria-hidden="true">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            <span style={{ ...skeletonBar(84, 20), borderRadius: 999 }} />
            <span style={skeletonBar(180, 24)} />
          </div>
          <div
            style={{
              width: "100%",
              aspectRatio: "520 / 290",
              borderRadius: 10,
              background: "var(--primary-soft)",
              marginBottom: 16,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
            <span style={skeletonBar(186, 14)} />
            <span style={{ ...skeletonBar("100%", 6), borderRadius: 999 }} />
            <span style={{ ...skeletonBar(34, 34), borderRadius: 10, flexShrink: 0 }} />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "0.65fr 1fr 1fr",
              gap: "10px 22px",
              marginBottom: 14,
              padding: "14px 16px",
              background: "var(--primary-soft)",
              border: "1px solid var(--border)",
              borderRadius: 12,
            }}
          >
            <span style={{ display: "grid", justifyItems: "center", gap: 7 }}>
              <span style={skeletonBar("70%", 15)} />
              <span style={skeletonBar("50%", 26)} />
            </span>
            <span style={{ display: "grid", justifyItems: "center", gap: 7 }}>
              <span style={skeletonBar("80%", 15)} />
              <span style={skeletonBar("50%", 26)} />
            </span>
            <span style={{ display: "grid", justifyItems: "center", gap: 7 }}>
              <span style={skeletonBar("80%", 15)} />
              <span style={skeletonBar("50%", 26)} />
            </span>
          </div>
          <div style={{ display: "grid", gap: 2 }}>
            <span style={skeletonBar("100%", 22)} />
            <span style={skeletonBar("88%", 22)} />
          </div>
        </div>
      </section>
    </>
  );
}

export default function DerivativeLab() {
  return (
    <Suspense fallback={<DerivativeLabFallback />}>
      <DerivativeLabView />
    </Suspense>
  );
}
