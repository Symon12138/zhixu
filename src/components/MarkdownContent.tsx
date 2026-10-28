import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/**
 * 只由 RichText 动态 import；不要改成 App 或首屏组件的静态 import，
 * 否则 react-markdown、remark/rehype 与 KaTeX（含字体）会回到首屏主包。
 */
export default function MarkdownContent({ children, inline = false }: { children: string; inline?: boolean }) {
  const content = (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children }) => inline ? <>{children}</> : <p>{children}</p>,
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {children}
    </Markdown>
  );
  return inline ? <span className="rich-text rich-text-inline">{content}</span> : <div className="rich-text">{content}</div>;
}

