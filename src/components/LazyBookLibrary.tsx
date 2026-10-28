import { lazy, Suspense, type CSSProperties } from "react";
import type { BookLibraryProps } from "./BookLibrary";

/**
 * 书架只在 view === "books" 时渲染。这里的动态 import 会把
 * BookLibrary、BookLibrary.css、bookImport（EPUB/PDF 解析）一起移出首屏主包；
 * PDF.js 本身仍由 bookImport 在真正导入 PDF 时才动态加载。
 * 模块级 lazy 只创建一次，StrictMode 重复渲染或多次开关书架都不会重复请求。
 */
const BookLibraryView = lazy(() =>
  import("./BookLibrary").then((module) => ({ default: module.BookLibrary })),
);

const shellStyle: CSSProperties = {
  maxWidth: 1460,
  margin: "0 auto",
  boxSizing: "border-box",
  // 对应 .book-library 的 36px 42px 32px，并在窄屏收敛到 22px / 18px。
  padding:
    "clamp(22px, 2.6vw, 36px) clamp(18px, 3.2vw, 42px) clamp(22px, 2.4vw, 32px)",
};

const headingStyle: CSSProperties = { marginBottom: 28, minWidth: 0 };

/**
 * 书架 chunk 到达前占住与 BookLibrary 初始加载态相同的盒子：
 * 标题区 + 60px 内边距的加载区。chunk 到达后由组件自身的
 * `.book-loading` 接管，高度不变，不会出现内容跳动。
 */
export function BookLibraryFallback() {
  return (
    <>
      <span className="sr-only" role="status">
        正在打开书架，请稍候。
      </span>
      <div style={shellStyle} aria-busy="true">
        <div style={headingStyle} aria-hidden="true">
          <span className="eyebrow">READ WITH THE SOURCE</span>
          <h1
            style={{
              margin: "10px 0 12px",
              font: "500 clamp(24px, 2.2vw, 34px)/1.45 var(--serif)",
              letterSpacing: ".5px",
            }}
          >
            一本书，一条理解的路径。
          </h1>
          <span
            style={{
              display: "block",
              width: "min(360px, 72%)",
              height: 23,
              borderRadius: 6,
              background: "var(--primary-soft)",
            }}
          />
        </div>
        <div
          aria-hidden="true"
          style={{
            padding: "60px 20px",
            display: "grid",
            justifyItems: "center",
            gap: 10,
            color: "var(--muted)",
          }}
        >
          <span
            className="spin"
            style={{
              width: 24,
              height: 24,
              boxSizing: "border-box",
              borderRadius: "50%",
              border: "2px solid var(--border)",
              borderTopColor: "var(--primary)",
            }}
          />
          <p style={{ margin: 0, fontSize: 13 }}>正在读取书架…</p>
        </div>
      </div>
    </>
  );
}

export function BookLibrary(props: BookLibraryProps) {
  return (
    <Suspense fallback={<BookLibraryFallback />}>
      <BookLibraryView {...props} />
    </Suspense>
  );
}
