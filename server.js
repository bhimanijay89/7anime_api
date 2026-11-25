import "dotenv/config";
import http from "node:http";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import worker from "./index.js";
import {
  generateEpisodeMp4,
  serveMp4File,
  DOWNLOAD_TEMP_DIR,
  PROVIDER_PRIORITY
} from "./services/download-service.js";
import {
  downloadHlsToMp4,
  downloadDirectMp4,
  probeMedia
} from "./services/media-processor.js";

const PORT  = Number(process.env.PORT) || 4000;
const BASE  = process.env.BASE_PATH ?? "";
const API_VERSION = "2.3";
const __dir = dirname(fileURLToPath(import.meta.url));

const STATIC = {
  "/":            { file: "docs/landing.html", mime: "text/html" },
  "/docs":        { file: "docs/index.html",   mime: "text/html" },
  "/player":      { file: "docs/player.html",  mime: "text/html" },
  "/preview":     { file: "docs/player.html",  mime: "text/html" },
  "/style.css":   { file: "docs/style.css",    mime: "text/css"  },
  "/logo.svg":    { file: "docs/logo.svg",     mime: "image/svg+xml" },
  "/logo.png":    { file: "docs/logo.png",     mime: "image/png" },
  "/favicon.png": { file: "docs/logo.png",     mime: "image/png" },
};

function serveStatic(res, entry) {
  try {
    const isText = entry.mime.startsWith("text/") || entry.mime === "image/svg+xml";
    const body = isText
      ? readFileSync(join(__dir, entry.file), "utf8").replaceAll("{{API_VERSION}}", API_VERSION)
      : readFileSync(join(__dir, entry.file));
    res.writeHead(200, {
      "Content-Type":  isText ? `${entry.mime}; charset=utf-8` : entry.mime,
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function nodeToRequest(req) {
  const host     = req.headers["host"] ?? `localhost:${PORT}`;
  const stripped = BASE && req.url.startsWith(BASE) ? req.url.slice(BASE.length) || "/" : req.url;
  const url      = `http://${host}${stripped}`;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  return new Request(url, {
    method:  req.method,
    headers: req.headers,
    body:    body?.length ? body : undefined,
    duplex:  "half",
  });
}

async function handleDownload(req, res) {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    let anilistId = parsedUrl.searchParams.get("anilistId") || parsedUrl.searchParams.get("id");
    let episode = parsedUrl.searchParams.get("episode") || parsedUrl.searchParams.get("ep") || "1";
    let audio = parsedUrl.searchParams.get("audio") || "sub";
    let provider = parsedUrl.searchParams.get("provider");
    const streamUrl = parsedUrl.searchParams.get("url");
    let filename = parsedUrl.searchParams.get("filename");
    const referer = parsedUrl.searchParams.get("referer");

    // Support clean URL pattern: /download/:anilistId/:episode/:audio
    const routeMatch = pathname.match(/^\/download\/(\d+)\/(\d+)(?:\/(sub|dub))?\/?$/i);
    if (routeMatch) {
      anilistId = routeMatch[1];
      episode = routeMatch[2];
      if (routeMatch[3]) audio = routeMatch[3];
    }

    // Mode 1: Smart Provider Download with Fallback (when anilistId is present)
    if (anilistId) {
      const cleanBase = (filename || `anime_${anilistId}_ep${episode}_${audio}`)
        .replace(/[^a-zA-Z0-9_\-.]/g, "_")
        .replace(/\.mp4$/i, "");
      const outputFilename = `${cleanBase}.mp4`;

      const abortController = new AbortController();
      req.on("close", () => abortController.abort());

      console.log(`[Server] Initiating smart MP4 download for AniList: ${anilistId}, Ep: ${episode}, Audio: ${audio}, Preferred: ${provider || "default priority"}`);

      const result = await generateEpisodeMp4(anilistId, episode, audio, {
        preferredProvider: provider,
        signal: abortController.signal,
        baseUrl: `http://localhost:${PORT}`
      });

      return serveMp4File(req, res, result.filePath, outputFilename);
    }

    // Mode 2: Direct Stream URL processing
    if (streamUrl) {
      const cleanBase = (filename || "video")
        .replace(/[^a-zA-Z0-9_\-.]/g, "_")
        .replace(/\.(mp4|ts|m3u8)$/i, "");
      const outputFilename = `${cleanBase}.mp4`;
      const targetPath = join(DOWNLOAD_TEMP_DIR, `${cleanBase}_${Date.now()}.mp4`);

      const abortController = new AbortController();
      req.on("close", () => abortController.abort());

      const isSettlar = (provider === "anipm") || streamUrl.includes("settlar.io");
      const isHls = streamUrl.includes(".m3u8") || isSettlar;

      let result;
      if (isHls) {
        result = await downloadHlsToMp4(streamUrl, {
          referer: referer || (isSettlar ? "https://embed.settlar.io/" : ""),
          isSettlar,
          signal: abortController.signal
        }, targetPath);
      } else {
        result = await downloadDirectMp4(streamUrl, {
          referer,
          signal: abortController.signal
        }, targetPath);
      }

      return serveMp4File(req, res, result.outputPath, outputFilename);
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: "Missing required parameters. Use ?anilistId=...&episode=... or ?url=..."
    }));
  } catch (err) {
    console.error("[Server] Download error:", err.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      res.end();
    }
  }
}

const server = http.createServer(async (req, res) => {
  console.log(`→ ${req.method} ${req.url}`);

  const pathname = req.url.split("?")[0];
  if (pathname === "/download" || pathname.startsWith("/download/")) {
    return handleDownload(req, res);
  }

  const staticEntry = STATIC[pathname];

  if ((req.method === "GET" || req.method === "HEAD") && staticEntry) {
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type":  staticEntry.mime + "; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end();
    }
    return serveStatic(res, staticEntry);
  }

  try {
    const request  = await nodeToRequest(req);
    const response = await worker.fetch(request, { API_VERSION });

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error("Unhandled error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`7Anime dev server → http://localhost:${PORT}`);
});
