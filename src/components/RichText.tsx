import { lazy, Suspense } from "react";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

export function RichText({ children, inline = false }: { children: string; inline?: boolean }) {
  return (
    <Suspense
      fallback={inline
        ? <span className="rich-text rich-text-inline" aria-busy="true">{children}</span>
        : <div className="rich-text" aria-busy="true">{children}</div>}
    >
      <MarkdownContent inline={inline}>{children}</MarkdownContent>
    </Suspense>
  );
}
