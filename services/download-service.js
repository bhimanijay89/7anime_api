import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadHlsToMp4, downloadDirectMp4, probeMedia } from "./media-processor.js";
import { discoverSubtitles, downloadSubtitleTrack, muxSubtitlesIntoMp4 } from "./subtitle-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Storage directory for temporary downloaded MP4s
export const DOWNLOAD_TEMP_DIR = path.resolve(__dirname, "../temp/downloads");
if (!fs.existsSync(DOWNLOAD_TEMP_DIR)) {
  fs.mkdirSync(DOWNLOAD_TEMP_DIR, { recursive: true });
}

// Strict provider fallback priority as specified in Phase 5
export const PROVIDER_PRIORITY = [
  "anipm",
  "anihq",
  "reanime",
  "anikoto",
  "anizone",
  "aniwaves",
  "animeonsen",
  "animenosub",
  "animegg",
  "pahenime",
  "animedunya",
  "kaa",
];

/**
 * Resolves a stream from the local 7Anime watch endpoint for a given provider.
 */
export async function resolveProviderStream(provider, anilistId, episode, audio, baseUrl = "http://localhost:4000") {
  try {
    const watchUrl = `${baseUrl}/watch/${provider}/${anilistId}/${audio}/${provider}-${episode}`;
    const res = await fetch(watchUrl, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) {
      console.warn(`[resolveProviderStream] ${provider} returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const streams = data.streams || [];

    // Filter out embed-only URLs
    const playable = streams.filter((s) => s && s.type !== "embed" && typeof s.url === "string" && s.url.startsWith("http"));
    if (playable.length === 0) {
      console.warn(`[resolveProviderStream] ${provider} had 0 playable non-embed streams (total streams: ${streams.length})`);
      return null;
    }

    // Pick primary stream: when sub is requested, prefer streams that offer soft subtitles
    let primary = playable[0];
    if (audio === "sub") {
      const softStream = playable.find(
        (s) => (Array.isArray(s.subtitles) && s.subtitles.length > 0) || s.subtitleType === "softsub"
      );
      if (softStream) {
        primary = softStream;
      }
    }

    const streamUrl = primary.url;
    const isSettlar = provider === "anipm" || streamUrl.includes("settlar.io");
    const isHls = primary.type === "hls" || streamUrl.includes(".m3u8") || isSettlar;
    const referer = primary.referer || (isSettlar ? "https://embed.settlar.io/" : "");

    return {
      provider,
      streamUrl,
      type: isHls ? "hls" : "mp4",
      referer,
      isSettlar,
      server: primary.server || provider,
      subtitles: primary.subtitles || data.subtitles || [],
      watchData: data
    };
  } catch (err) {
    return null;
  }
}

/**
 * Universal episode MP4 generator with intelligent fallback.
 */
export async function generateEpisodeMp4(anilistId, episode, audio = "sub", options = {}) {
  const {
    preferredProvider = null,
    signal = null,
    baseUrl = "http://localhost:4000",
    onProgress = null
  } = options;

  // Determine provider trial order
  const providersToTry = preferredProvider
    ? [preferredProvider, ...PROVIDER_PRIORITY.filter((p) => p !== preferredProvider)]
    : [...PROVIDER_PRIORITY];

  const errors = [];

  // Check if a valid cached MP4 file already exists in temp dir
  const cacheKey = `ep_${anilistId}_${episode}_${audio}`;
  const existingFiles = fs.readdirSync(DOWNLOAD_TEMP_DIR).filter((f) => f.startsWith(cacheKey) && f.endsWith(".mp4"));
  for (const existing of existingFiles) {
    const fullPath = path.join(DOWNLOAD_TEMP_DIR, existing);
    const probe = await probeMedia(fullPath);
    if (probe.isValid) {
      // If user requested sub audio, ensure cached file has subtitles embedded if available
      if (audio === "sub" && !probe.hasSubtitles && !options.reuseNoSubCache) {
        console.log(`[DownloadService] Cached MP4 for ${cacheKey} lacks subtitles; re-resolving with subtitle muxing...`);
      } else {
        console.log(`[DownloadService] Reusing existing validated MP4 for ${cacheKey}: ${existing}`);
        return {
          filePath: fullPath,
          provider: existing.split("_")[4] || "cached",
          probe,
          cached: true
        };
      }
    } else {
      try { fs.unlinkSync(fullPath); } catch { }
    }
  }

  for (const provider of providersToTry) {
    if (signal?.aborted) throw new Error("Download cancelled");

    console.log(`[DownloadService] Attempting provider: ${provider} (AniList: ${anilistId}, Ep: ${episode}, Audio: ${audio})...`);
    const stream = await resolveProviderStream(provider, anilistId, episode, audio, baseUrl);

    if (!stream) {
      errors.push({ provider, reason: "No playable stream returned by provider" });
      continue;
    }

    const uniqueId = `${cacheKey}_${provider}_${Date.now()}`;
    const targetFile = path.join(DOWNLOAD_TEMP_DIR, `${uniqueId}.mp4`);

    try {
      let result;
      if (stream.type === "mp4") {
        console.log(`[DownloadService] Downloading direct MP4 from ${provider}: ${stream.streamUrl}`);
        result = await downloadDirectMp4(stream.streamUrl, {
          referer: stream.referer,
          signal,
          onProgress
        }, targetFile);
      } else {
        console.log(`[DownloadService] Processing HLS stream into MP4 from ${provider}: ${stream.streamUrl}`);
        result = await downloadHlsToMp4(stream.streamUrl, {
          referer: stream.referer,
          isSettlar: stream.isSettlar,
          signal,
          onProgress
        }, targetFile);
      }

      if (result?.success && result.probe?.isValid) {
        // Auto-detect & embed subtitles if audio is sub
        if (audio === "sub") {
          console.log(`[DownloadService] Discovering subtitles for ${provider}...`);
          try {
            const discoveredSubs = await discoverSubtitles({
              stream,
              watchData: stream.watchData,
              streamUrl: stream.streamUrl,
              referer: stream.referer,
              isSettlar: stream.isSettlar,
              signal
            });

            if (discoveredSubs.length > 0) {
              console.log(`[DownloadService] Discovered ${discoveredSubs.length} subtitle tracks for ${provider}. Downloading and muxing...`);
              const tempSubDir = path.join(DOWNLOAD_TEMP_DIR, `subs_${Date.now()}`);
              fs.mkdirSync(tempSubDir, { recursive: true });

              const downloadedTracks = [];
              for (let i = 0; i < discoveredSubs.length; i++) {
                try {
                  const track = await downloadSubtitleTrack(discoveredSubs[i], tempSubDir, i, signal);
                  downloadedTracks.push(track);
                  console.log(`[DownloadService] Downloaded subtitle: ${track.title} (${track.language})`);
                } catch (subErr) {
                  console.warn(`[DownloadService] Skipped subtitle "${discoveredSubs[i].label}": ${subErr.message}`);
                }
              }

              if (downloadedTracks.length > 0) {
                const muxedFile = targetFile.replace(/\.mp4$/i, "") + "_subbed.mp4";
                const muxResult = await muxSubtitlesIntoMp4(targetFile, downloadedTracks, muxedFile);
                if (muxResult.success && muxResult.probe?.isValid) {
                  try { fs.unlinkSync(targetFile); } catch { }
                  fs.renameSync(muxedFile, targetFile);
                  result.probe = muxResult.probe;
                  console.log(`[DownloadService] Successfully embedded ${downloadedTracks.length} subtitle tracks into MP4!`);
                } else {
                  console.warn(`[DownloadService] Subtitle muxing fallback to clean video.`);
                  try { if (fs.existsSync(muxedFile)) fs.unlinkSync(muxedFile); } catch { }
                }
              }

              try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch { }
            } else {
              console.log(`[DownloadService] No external or HLS subtitle tracks found for ${provider}. Video remains as-is.`);
            }
          } catch (subDiscoveryErr) {
            console.warn(`[DownloadService] Subtitle discovery error: ${subDiscoveryErr.message}. Preserving video.`);
          }
        }

        console.log(`[DownloadService] Successfully produced valid MP4 using provider: ${provider}! (Duration: ${result.probe.duration}s, Codecs: ${result.probe.video?.codec}/${result.probe.audio?.codec}, Subtitles: ${result.probe.subtitles?.length || 0})`);
        return {
          filePath: targetFile,
          provider,
          probe: result.probe,
          cached: false
        };
      } else {
        throw new Error("Validation check failed on output MP4");
      }
    } catch (err) {
      console.warn(`[DownloadService] Provider ${provider} failed:`, err.message);
      errors.push({ provider, reason: err.message });
      try {
        if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
      } catch { }
    }
  }

  throw new Error(`All eligible providers failed to generate a valid MP4: ${JSON.stringify(errors)}`);
}

/**
 * Serves an MP4 file over HTTP with full Range request support.
 */
export function serveMp4File(req, res, filePath, downloadFilename) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const sanitizedFilename = (downloadFilename || path.basename(filePath))
    .replace(/[^a-zA-Z0-9_\-.]/g, "_");

  const commonHeaders = {
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(sanitizedFilename)}"`,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
  };

  if (req.method === "HEAD") {
    res.writeHead(200, {
      "Content-Length": fileSize,
      ...commonHeaders,
    });
    return res.end();
  }

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, {
        "Content-Range": `bytes */${fileSize}`,
        ...commonHeaders,
      });
      return res.end();
    }

    const chunksize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": chunksize,
      ...commonHeaders,
    });

    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      ...commonHeaders,
    });

    fs.createReadStream(filePath).pipe(res);
  }
}
