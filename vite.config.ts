import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { ViteDevServer } from "vite";
import type { PluginContext } from "rollup";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const pdfResourceDirs = ["cmaps", "standard_fonts"] as const;

// PDF text extraction must not depend on a CDN, including for CJK fonts.
function localPdfResources() {
  return {
    name: "local-pdf-text-resources",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/pdf-resources", (req, res, next) => {
        const parts = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
        if (parts.length !== 2 || !pdfResourceDirs.includes(parts[0] as typeof pdfResourceDirs[number]) || !/^[a-zA-Z0-9_.-]+$/.test(parts[1])) { next(); return; }
        const file = path.join(pdfRoot, parts[0], parts[1]);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { next(); return; }
        res.setHeader("Content-Type", "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle(this: PluginContext) {
      for (const directory of pdfResourceDirs) {
        for (const name of fs.readdirSync(path.join(pdfRoot, directory))) {
          const file = path.join(pdfRoot, directory, name);
          if (fs.statSync(file).isFile()) this.emitFile({ type: "asset", fileName: `pdf-resources/${directory}/${name}`, source: fs.readFileSync(file) });
        }
      }
      this.emitFile({ type: "asset", fileName: "pdf-resources/LICENSE", source: fs.readFileSync(path.join(pdfRoot, "LICENSE")) });
    },
  };
}

/**
 * 只给全站首屏立即需要的 React 运行时一个稳定 vendor chunk。
 * markdown/katex、pdfjs、lucide 图标都不在这里指定：
 * - markdown/katex 与 pdfjs 只在对应视图/文件导入时动态加载，交给 Rollup 按 import 点自然分包；
 * - lucide 图标由使用方共享，如果整体合并会让只有书架用到的图标被首屏一起下载。
 */
function vendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (/[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
  return undefined;
}

export default defineConfig({
  plugins: [react(), localPdfResources()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
});
