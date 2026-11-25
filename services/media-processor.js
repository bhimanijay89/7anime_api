import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { wreqFetch } from "../core/wreq.js";

const execFileAsync = promisify(execFile);

// Resolve binary paths
export const FFMPEG_PATH = ffmpegInstaller?.path || "ffmpeg";
export const FFPROBE_PATH = ffprobeInstaller?.path || "ffprobe";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Inspect a media file using FFprobe.
 */
export async function probeMedia(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_PATH, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-show_error",
      filePath
    ], { timeout: 15000 });

    const data = JSON.parse(stdout);
    if (data.error) {
      return { isValid: false, error: data.error.string || "FFprobe reported error" };
    }

    const format = data.format || {};
    const streams = data.streams || [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");
    const subtitleStreams = streams.filter((s) => s.codec_type === "subtitle");
    const duration = parseFloat(format.duration || videoStream?.duration || 0);
    const size = parseInt(format.size || 0, 10);
    const formatName = format.format_name || "";

    const isMp4 = formatName.includes("mp4") || formatName.includes("mov");
    const isH264 = videoStream?.codec_name === "h264";
    const isAac = audioStream?.codec_name === "aac";

    const isValid = Boolean(
      isMp4 &&
      videoStream &&
      audioStream &&
      duration > 60 && // Must be longer than 1 minute (a full episode, not a single TS chunk)
      size > 1024 * 1024 // Greater than 1 MB
    );

    return {
      isValid,
      duration,
      size,
      formatName,
      isMp4,
      isH264,
      isAac,
      hasSubtitles: subtitleStreams.length > 0,
      subtitles: subtitleStreams.map((s) => ({
        index: s.index,
        codec: s.codec_name,
        language: s.tags?.language || "und",
        title: s.tags?.title || s.tags?.handler_name || "Subtitle",
        default: Boolean(s.disposition?.default)
      })),
      video: videoStream ? {
        codec: videoStream.codec_name,
        width: videoStream.width,
        height: videoStream.height,
        fps: evalFps(videoStream.r_frame_rate)
      } : null,
      audio: audioStream ? {
        codec: audioStream.codec_name,
        sampleRate: audioStream.sample_rate,
        channels: audioStream.channels
      } : null,
      raw: data
    };
  } catch (err) {
    return { isValid: false, error: err.message };
  }
}

function evalFps(rateStr) {
  if (!rateStr) return 0;
  const parts = rateStr.split("/");
  if (parts.length === 2 && Number(parts[1]) > 0) {
    return Math.round((Number(parts[0]) / Number(parts[1])) * 100) / 100;
  }
  return parseFloat(rateStr) || 0;
}

/**
 * Verify decodability by decoding the first 15 seconds into a null muxer.
 */
export async function verifyDecodability(filePath, seconds = 15) {
  try {
    await execFileAsync(FFMPEG_PATH, [
      "-v", "error",
      "-i", filePath,
      "-t", String(seconds),
      "-f", "null",
      "-"
    ], { timeout: 20000 });
    return true;
  } catch (err) {
    console.warn(`Decodability check warning for ${filePath}:`, err.message);
    return false;
  }
}

/**
 * Fetch helper that selects wreqFetch (with Chrome TLS impersonation) for
 * Settlar/Cloudflare-protected streams and standard fetch for standard CDNs.
 */
async function fetchStreamAsset(url, headers = {}, isSettlar = false, signal = null) {
  const needsWreq = isSettlar || url.includes("settlar.io") || url.includes("anipm");
  if (needsWreq) {
    const origin = headers.Referer ? new URL(headers.Referer).origin : new URL(url).origin;
    return wreqFetch(url, {
      session: "anipm",
      browser: "chrome_149",
      os: "windows",
      signal,
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "*/*",
        Origin: origin,
        ...headers,
      }
    });
  }

  return fetch(url, {
    signal: signal || AbortSignal.timeout(15000),
    redirect: "follow",
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "*/*",
      ...headers,
    }
  });
}

/**
 * Resolves an HLS URL (Master or Media playlist) to all segment URLs.
 */
export async function resolveHlsSegments(streamUrl, headers = {}, isSettlar = false, signal = null) {
  const masterRes = await fetchStreamAsset(streamUrl, headers, isSettlar, signal);
  if (!masterRes.ok) {
    throw new Error(`Failed to fetch HLS playlist HTTP ${masterRes.status}: ${streamUrl}`);
  }

  let text = await masterRes.text();
  let mediaUrl = streamUrl;

  // Master Playlist with multiple variants: select the highest bandwidth / 1080p
  if (text.includes("#EXT-X-STREAM-INF")) {
    const lines = text.split(/\r?\n/);
    let bestVariant = null;
    let maxBandwidth = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        const height = resMatch ? parseInt(resMatch[2], 10) : 0;

        const nextLine = lines[i + 1]?.trim();
        if (nextLine && !nextLine.startsWith("#")) {
          // Score prioritizing 1080p and higher bandwidth
          const score = (height === 1080 ? 10_000_000 : height * 1000) + bw;
          if (score > maxBandwidth) {
            maxBandwidth = score;
            bestVariant = nextLine;
          }
        }
      }
    }

    if (bestVariant) {
      mediaUrl = new URL(bestVariant, streamUrl).href;
      const mediaRes = await fetchStreamAsset(mediaUrl, headers, isSettlar, signal);
      if (mediaRes.ok) {
        text = await mediaRes.text();
      }
    }
  }

  // Parse segments
  const segments = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const segUrl = new URL(line, mediaUrl).href;
      segments.push(segUrl);
    } catch { }
  }

  if (segments.length === 0) {
    throw new Error(`No media segments found in HLS playlist: ${streamUrl}`);
  }

  return { mediaUrl, segments };
}

/**
 * Downloads an HLS stream directly into a valid MP4 container using FFmpeg.
 */
export async function downloadHlsToMp4(streamUrl, options = {}, outputPath) {
  const {
    referer = "",
    isSettlar = false,
    signal = null,
    onProgress = null,
    timeoutMs = 600_000 // 10 minutes max for full episode
  } = options;

  const headers = {};
  if (referer) headers.Referer = referer;

  // Step 1: Parse segments
  const { segments } = await resolveHlsSegments(streamUrl, headers, isSettlar, signal);
  const totalSegments = segments.length;

  const tempRawMp4 = outputPath.replace(/\.mp4$/i, "") + `.tmp_${Date.now()}.mp4`;

  return new Promise(async (resolve, reject) => {
    let isAborted = false;
    let completed = false;
    let ffmpegExited = false;
    let ffmpegExitCode = null;

    const cleanupTemp = () => {
      try {
        if (fs.existsSync(tempRawMp4)) fs.unlinkSync(tempRawMp4);
      } catch { }
    };

    const abortHandler = () => {
      isAborted = true;
      try { ffmpeg.kill("SIGKILL"); } catch { }
      cleanupTemp();
      reject(new Error("Download aborted by user or timeout"));
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    const timer = setTimeout(() => {
      if (!completed) {
        abortHandler();
      }
    }, timeoutMs);

    // Spawn FFmpeg to remux MPEG-TS pipe to MP4 with faststart
    const ffmpeg = spawn(FFMPEG_PATH, [
      "-y",
      "-f", "mpegts",
      "-i", "pipe:0",
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c", "copy",
      "-movflags", "+faststart",
      tempRawMp4
    ]);

    ffmpeg.stdin.on("error", (err) => {
      if (!isAborted && !ffmpegExited) {
        console.warn("FFmpeg stdin error:", err.message);
      }
    });

    ffmpeg.on("close", (code) => {
      ffmpegExited = true;
      ffmpegExitCode = code;
    });

    try {
      // Concurrently download segments and write in strict sequence
      const CONCURRENCY = 6;
      let currentIndex = 0;
      let downloadedCount = 0;

      // Buffer of downloaded segments by index
      const bufferMap = new Map();

      async function worker() {
        while (currentIndex < segments.length && !isAborted) {
          // Keep buffer window bounded to avoid memory pressure
          while (bufferMap.size >= 16 && !isAborted) {
            await new Promise((r) => setTimeout(r, 30));
          }
          if (isAborted || currentIndex >= segments.length) break;

          const index = currentIndex++;
          const segUrl = segments[index];

          let attempt = 0;
          let buf = null;
          while (attempt < 3 && !buf && !isAborted) {
            attempt++;
            try {
              const res = await fetchStreamAsset(segUrl, headers, isSettlar, signal);
              if (res.ok) {
                const ab = await res.arrayBuffer();
                buf = Buffer.from(ab);
              }
            } catch (err) {
              if (attempt >= 3) {
                console.warn(`Segment ${index} failed after 3 attempts:`, err.message);
              }
            }
          }

          if (isAborted) break;
          bufferMap.set(index, buf || Buffer.alloc(0));
        }
      }

      // Start workers
      const workers = Array.from({ length: Math.min(CONCURRENCY, segments.length) }, () => worker());

      // Writer loop: writes to FFmpeg stdin in sequential order
      for (let writeIndex = 0; writeIndex < segments.length; writeIndex++) {
        if (isAborted) break;

        // Wait until bufferMap has this index
        while (!bufferMap.has(writeIndex) && !isAborted) {
          await new Promise((r) => setTimeout(r, 20));
        }
        if (isAborted) break;

        const chunk = bufferMap.get(writeIndex);
        bufferMap.delete(writeIndex);

        if (chunk && chunk.length > 0 && !ffmpeg.stdin.destroyed) {
          const ok = ffmpeg.stdin.write(chunk);
          if (!ok) {
            await Promise.race([
              new Promise((r) => ffmpeg.stdin.once("drain", r)),
              new Promise((r) => setTimeout(r, 25))
            ]);
          }
        }

        downloadedCount++;
        if (onProgress && (downloadedCount % 10 === 0 || downloadedCount === totalSegments)) {
          onProgress({
            current: downloadedCount,
            total: totalSegments,
            percent: Math.round((downloadedCount / totalSegments) * 100)
          });
        }
      }

      await Promise.all(workers);
      if (isAborted) return;

      // Close FFmpeg input stream
      ffmpeg.stdin.end();

      // Wait for FFmpeg process to complete
      while (!ffmpegExited) {
        await new Promise((r) => setTimeout(r, 50));
      }

      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortHandler);

      if (ffmpegExitCode !== 0) {
        cleanupTemp();
        return reject(new Error(`FFmpeg exited with error code ${ffmpegExitCode}`));
      }

      // Step 2: Validate the generated MP4 file with FFprobe
      const probe = await probeMedia(tempRawMp4);
      if (!probe.isValid) {
        cleanupTemp();
        return reject(new Error(`Generated MP4 failed validation: ${probe.error || "Missing streams or invalid container"}`));
      }

      // Step 3: Check codec compatibility. If video is not H.264 or audio is not AAC, transcode!
      if (!probe.isH264 || !probe.isAac) {
        console.log(`Transcoding non-standard codecs (${probe.video?.codec}/${probe.audio?.codec}) to H.264/AAC for universal compatibility...`);
        await execFileAsync(FFMPEG_PATH, [
          "-y",
          "-i", tempRawMp4,
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "22",
          "-c:a", "aac",
          "-b:a", "192k",
          "-movflags", "+faststart",
          outputPath
        ], { timeout: 300_000 });
        cleanupTemp();
      } else {
        // Move to destination
        fs.renameSync(tempRawMp4, outputPath);
      }

      // Final FFprobe verification on output
      const finalProbe = await probeMedia(outputPath);
      if (!finalProbe.isValid) {
        try { fs.unlinkSync(outputPath); } catch { }
        return reject(new Error("Final MP4 validation failed after processing"));
      }

      completed = true;
      resolve({
        success: true,
        outputPath,
        probe: finalProbe
      });
    } catch (err) {
      clearTimeout(timer);
      cleanupTemp();
      reject(err);
    }
  });
}

/**
 * Downloads a direct MP4 video file and verifies its container and codecs.
 */
export async function downloadDirectMp4(streamUrl, options = {}, outputPath) {
  const {
    referer = "",
    signal = null,
    onProgress = null,
    timeoutMs = 300_000
  } = options;

  const headers = {};
  if (referer) headers.Referer = referer;

  const tempPath = outputPath.replace(/\.mp4$/i, "") + `.tmp_${Date.now()}.mp4`;

  try {
    const res = await fetchStreamAsset(streamUrl, headers, false, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching MP4 stream: ${streamUrl}`);

    const fileStream = fs.createWriteStream(tempPath);
    const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
    let downloadedBytes = 0;

    const reader = res.body.getReader();
    while (true) {
      if (signal?.aborted) throw new Error("Download aborted");
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
      downloadedBytes += value.length;
      if (onProgress && totalBytes > 0 && downloadedBytes % (1024 * 512) === 0) {
        onProgress({
          current: downloadedBytes,
          total: totalBytes,
          percent: Math.round((downloadedBytes / totalBytes) * 100)
        });
      }
    }
    await new Promise((resolve) => fileStream.end(resolve));

    // Probe downloaded file
    const probe = await probeMedia(tempPath);
    if (!probe.isValid) {
      try { fs.unlinkSync(tempPath); } catch { }
      throw new Error(`Direct MP4 failed validation: ${probe.error || "Corrupted media"}`);
    }

    // Remux with faststart to ensure instant playback in browsers and mobile
    await execFileAsync(FFMPEG_PATH, [
      "-y",
      "-i", tempPath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath
    ]);

    try { fs.unlinkSync(tempPath); } catch { }

    const finalProbe = await probeMedia(outputPath);
    return {
      success: true,
      outputPath,
      probe: finalProbe
    };
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { }
    throw err;
  }
}
