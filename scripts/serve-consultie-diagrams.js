#!/usr/bin/env node
/**
 * 図解フォルダをそのまま配信（依存なし）。GitHub Pages が未設定でもブラウザで確認できる。
 * Usage: node scripts/serve-consultie-diagrams.js
 * Env: PORT=5180（省略時）
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "docs", "consultie-land-partner");
const PORT = Number(process.env.PORT || 5180, 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".htm": "text/html; charset=utf-8",
};

function safePath(rel) {
  const segments = rel.split(/[/\\]/).filter((s) => s && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  const full = path.resolve(ROOT, ...segments);
  const rootResolved = path.resolve(ROOT);
  if (!full.startsWith(rootResolved + path.sep) && full !== rootResolved) return null;
  return full;
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url || "/", `http://127.0.0.1`);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    if (!rel || rel.endsWith("/")) rel = rel ? `${rel}index.html` : "index.html";

    const filePath = safePath(rel);
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found: " + rel);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Consultie diagrams (local): http://127.0.0.1:${PORT}/`);
  console.log(`Root: ${ROOT}`);
});
