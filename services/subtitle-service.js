import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG_PATH, FFPROBE_PATH, probeMedia } from "./media-processor.js";
import { wreqFetch } from "../core/wreq.js";

const execFileAsync = promisify(execFile);
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export const LANGUAGE_MAP = {
  en: "eng", eng: "eng", english: "eng",
  ja: "jpn", jpn: "jpn", japanese: "jpn",
  es: "spa", spa: "spa", spanish: "spa", "es-419": "spa",
  fr: "fra", fra: "fra", fre: "fra", french: "fra",
  de: "deu", deu: "deu", ger: "deu", german: "deu",
  it: "ita", ita: "ita", italian: "ita",
  pt: "por", por: "por", portuguese: "por", "pt-br": "por",
  hi: "hin", hin: "hin", hindi: "hin",
  ar: "ara", ara: "ara", arabic: "ara",
  ru: "rus", rus: "rus", russian: "rus",
  ko: "kor", kor: "kor", korean: "kor",
  zh: "zho", zho: "zho", chi: "zho", chinese: "zho",
  id: "ind", ind: "ind", indonesian: "ind",
  vi: "vie", vie: "vie", vietnamese: "vie",
  th: "tha", tha: "tha", thai: "tha",
  pl: "pol", pol: "pol", polish: "pol",
  nl: "nld", nld: "nld", dut: "nld", dutch: "nld",
  tr: "tur", tur: "tur", turkish: "tur",
  ms: "msa", msa: "msa", may: "msa", malay: "msa",
  fil: "fil", tgl: "fil", filipino: "fil", tagalog: "fil",
  ro: "ron", ron: "ron", rum: "ron", romanian: "ron",
  cs: "ces", ces: "ces", cze: "ces", czech: "ces",
  hu: "hun", hun: "hun", hungarian: "hun",
  el: "ell", ell: "ell", gre: "ell", greek: "ell",
  sv: "swe", swe: "swe", swedish: "swe",
  da: "dan", dan: "dan", danish: "dan",
  fi: "fin", fin: "fin", finnish: "fin",
  no: "nor", nor: "nor", norwegian: "nor",
  he: "heb", heb: "heb", hebrew: "heb",
  uk: "ukr", ukr: "ukr", ukrainian: "ukr",
  fa: "fas", fas: "fas", per: "fas", persian: "fas",
  bn: "ben", ben: "ben", bengali: "ben",
  ta: "tam", tam: "tam", tamil: "tam",
  te: "tel", tel: "tel", telugu: "tel",
  mr: "mar", mar: "mar", marathi: "mar",
  guj: "guj", guj: "guj", gujarati: "guj",
  urd: "urd", urd: "urd", urdu: "urd",
};

export const LANGUAGE_TITLES = {
  eng: "English",
  jpn: "Japanese",
  spa: "Spanish",
  fra: "French",
  deu: "German",
  ita: "Italian",
  por: "Portuguese",
  hin: "Hindi",
  ara: "Arabic",
  rus: "Russian",
  kor: "Korean",
  zho: "Chinese",
  ind: "Indonesian",
  vie: "Vietnamese",
  tha: "Thai",
  pol: "Polish",
  nld: "Dutch",
  tur: "Turkish",
  msa: "Malay",
  fil: "Filipino",
  ron: "Romanian",
  ces: "Czech",
  hun: "Hungarian",
  ell: "Greek",
  swe: "Swedish",
  dan: "Danish",
  fin: "Finnish",
  nor: "Norwegian",
  heb: "Hebrew",
  ukr: "Ukrainian",
  fas: "Persian",
  ben: "Bengali",
  tam: "Tamil",
  tel: "Telugu",
  mar: "Marathi",
  guj: "Gujarati",
  urd: "Urdu",
};

/**
 * Normalizes any language code or name to standard ISO 639-2 (3-letter).
 */
export function normalizeLanguageCode(code) {
  if (!code || typeof code !== "string") return "und";
  const cleaned = code.trim().toLowerCase().split(/[-_ (]/)[0];
  if (LANGUAGE_MAP[cleaned]) return LANGUAGE_MAP[cleaned];
  if (code.length === 3 && /^[a-z]{3}$/i.test(code)) return code.toLowerCase();
  return "und";
}

/**
 * Formats a clean human-readable title for a subtitle track.
 */
export function formatSubtitleTitle(track) {
  const normLang = normalizeLanguageCode(track.language || track.srclang || track.lang);
  const defaultTitle = LANGUAGE_TITLES[normLang] || "Subtitle";
  const label = track.label || track.title || track.name;
  if (label && typeof label === "string" && label.trim() && label !== "Subtitle" && label !== "Track") {
    return label.trim();
  }
  return defaultTitle;
}

/**
 * Helper to fetch a subtitle asset safely with headers & TLS session.
 */
async function fetchSubtitleAsset(url, headers = {}, isSettlar = false, signal = null) {
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
 * Parses #EXT-X-MEDIA:TYPE=SUBTITLES records from an HLS master playlist text.
 */
export function parseHlsSubtitles(manifestText, masterPlaylistUrl, referer = "") {
  if (!manifestText || typeof manifestText !== "string") return [];
  const subtitles = [];
  const lines = manifestText.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    if (!line.includes("TYPE=SUBTITLES")) continue;

    const attributes = {};
    for (const match of line.slice(line.indexOf(":") + 1).matchAll(/([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g)) {
      attributes[match[1]] = match[2].replace(/^"|"$/g, "");
    }

    let uri = attributes.URI;
    if (!uri) continue;
    try {
      uri = new URL(uri, masterPlaylistUrl).href;
    } catch {
      continue;
    }

    const rawLang = attributes.LANGUAGE || attributes.NAME || "und";
    const language = normalizeLanguageCode(rawLang);
    const label = attributes.NAME || LANGUAGE_TITLES[language] || "Subtitle";
    const isDefault = attributes.DEFAULT === "YES";
    const isForced = attributes.FORCED === "YES";

    subtitles.push({
      url: uri,
      label,
      language,
      default: isDefault,
      forced: isForced,
      headers: referer ? { Referer: referer } : {},
      source: "hls-master"
    });
  }

  return subtitles;
}

/**
 * Discovers and aggregates all available subtitle tracks for a stream.
 */
export async function discoverSubtitles(options = {}) {
  const {
    stream = {},
    watchData = {},
    streamUrl = "",
    masterManifestText = null,
    referer = "",
    isSettlar = false,
    signal = null
  } = options;

  const rawCandidates = [];

  // 1. Tracks in the selected stream object
  if (Array.isArray(stream.subtitles)) {
    for (const sub of stream.subtitles) {
      if (sub && (sub.url || sub.src || sub.file)) rawCandidates.push(sub);
    }
  }

  // 2. Tracks in other streams from the same provider response
  if (Array.isArray(watchData.streams)) {
    for (const otherStream of watchData.streams) {
      if (Array.isArray(otherStream.subtitles)) {
        for (const sub of otherStream.subtitles) {
          if (sub && (sub.url || sub.src || sub.file)) rawCandidates.push(sub);
        }
      }
    }
  }

  // 3. Top-level subtitles in watchData
  if (Array.isArray(watchData.subtitles)) {
    for (const sub of watchData.subtitles) {
      if (sub && (sub.url || sub.src || sub.file)) rawCandidates.push(sub);
    }
  }

  // 4. HLS master playlist subtitles
  if (masterManifestText && streamUrl) {
    const hlsSubs = parseHlsSubtitles(masterManifestText, streamUrl, referer);
    rawCandidates.push(...hlsSubs);
  } else if (streamUrl && (streamUrl.includes(".m3u8") || stream.type === "hls")) {
    try {
      const manifestRes = await fetchSubtitleAsset(streamUrl, referer ? { Referer: referer } : {}, isSettlar, signal);
      if (manifestRes.ok) {
        const text = await manifestRes.text();
        const hlsSubs = parseHlsSubtitles(text, streamUrl, referer);
        rawCandidates.push(...hlsSubs);
      }
    } catch {}
  }

  // Deduplicate candidates by normalized language + label + url
  const uniqueSubs = [];
  const seenKeys = new Set();

  for (const item of rawCandidates) {
    const subUrl = item.url || item.src || item.file;
    if (!subUrl || typeof subUrl !== "string" || !subUrl.startsWith("http")) continue;

    const rawLang = item.srclang || item.language || item.lang || item.label || "und";
    const language = normalizeLanguageCode(rawLang);
    const label = item.label || item.title || item.name || LANGUAGE_TITLES[language] || "Subtitle";

    // Deduplication key
    const dedupeKey = `${language}:${label.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const isDefault = Boolean(item.default || item.isDefault);
    const isForced = Boolean(item.forced);
    const headers = item.headers || (referer ? { Referer: referer } : {});

    uniqueSubs.push({
      url: subUrl,
      label,
      language,
      default: isDefault,
      forced: isForced,
      headers,
      isSettlar: isSettlar || subUrl.includes("settlar.io"),
      format: item.format || (subUrl.endsWith(".ass") ? "ass" : subUrl.endsWith(".srt") ? "srt" : "vtt")
    });
  }

  // Ensure exactly one default subtitle is flagged if subtitles exist and audio is sub
  if (uniqueSubs.length > 0) {
    const hasDefault = uniqueSubs.some((s) => s.default);
    if (!hasDefault) {
      const engIndex = uniqueSubs.findIndex((s) => s.language === "eng");
      if (engIndex !== -1) {
        uniqueSubs[engIndex].default = true;
      } else {
        uniqueSubs[0].default = true;
      }
    }
  }

  return uniqueSubs;
}

/**
 * Downloads a subtitle track, normalizes its content (VTT/SRT/ASS), and saves to disk.
 */
export async function downloadSubtitleTrack(subTrack, tempDir, index, signal = null) {
  const { url, headers = {}, isSettlar = false } = subTrack;
  const isSettlarUrl = isSettlar || url.includes("settlar.io");

  const res = await fetchSubtitleAsset(url, headers, isSettlarUrl, signal);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching subtitle from ${url}`);
  }

  let text = await res.text();
  let ext = "vtt";

  // Handle HLS subtitle playlists containing segment chunks
  if (text.startsWith("#EXTM3U")) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (lines.length === 0) {
      throw new Error(`Empty HLS subtitle playlist at ${url}`);
    }

    let combinedText = "";
    for (let i = 0; i < lines.length; i++) {
      let segUrl = lines[i];
      try {
        segUrl = new URL(lines[i], url).href;
      } catch {}
      const segRes = await fetchSubtitleAsset(segUrl, headers, isSettlarUrl, signal);
      if (!segRes.ok) continue;
      const segText = await segRes.text();
      if (i === 0) {
        combinedText = segText;
      } else {
        // Strip duplicate WebVTT headers for subsequent chunks
        const body = segText.replace(/^WEBVTT[^\n]*\n(?:X-TIMESTAMP-MAP=[^\n]*\n)?/i, "").trimStart();
        combinedText += "\n\n" + body;
      }
    }
    text = combinedText;
  }

  // Detect format
  if (text.includes("[Script Info]") || text.includes("[V4+ Styles]")) {
    ext = "ass";
  } else if (/^\d+\r?\n\d{2}:\d{2}:\d{2}/m.test(text)) {
    ext = "srt";
  } else {
    ext = "vtt";
  }

  const filename = `sub_${index}_${subTrack.language || "und"}_${Date.now()}.${ext}`;
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, text, "utf-8");

  return {
    filePath,
    language: subTrack.language,
    title: formatSubtitleTitle(subTrack),
    default: subTrack.default,
    format: ext
  };
}

/**
 * Muxes downloaded subtitle tracks into an existing MP4 using FFmpeg (mov_text).
 */
export async function muxSubtitlesIntoMp4(videoPath, subtitleTracks, outputPath, options = {}) {
  const { timeoutMs = 180_000 } = options;

  if (!subtitleTracks || subtitleTracks.length === 0) {
    // No subtitles to mux, copy or return videoPath
    if (videoPath !== outputPath) {
      fs.copyFileSync(videoPath, outputPath);
    }
    return { success: true, outputPath, muxedCount: 0 };
  }

  const ffmpegArgs = [
    "-y",
    "-loglevel", "warning",
    "-i", videoPath
  ];

  // Add subtitle inputs
  for (const track of subtitleTracks) {
    ffmpegArgs.push("-i", track.filePath);
  }

  // Map video & audio
  ffmpegArgs.push("-map", "0:v:0", "-map", "0:a:0?");

  // Map each subtitle input
  for (let i = 0; i < subtitleTracks.length; i++) {
    ffmpegArgs.push("-map", `${i + 1}:0`);
  }

  // Codecs: stream copy video & audio, convert subtitles to mov_text
  ffmpegArgs.push("-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text");

  // Metadata & dispositions for subtitle tracks
  for (let i = 0; i < subtitleTracks.length; i++) {
    const track = subtitleTracks[i];
    ffmpegArgs.push(
      `-metadata:s:s:${i}`, `language=${track.language || "und"}`,
      `-metadata:s:s:${i}`, `handler_name=${track.title || "Subtitle"}`,
      `-metadata:s:s:${i}`, `title=${track.title || "Subtitle"}`,
      `-disposition:s:${i}`, track.default ? "default" : "0"
    );
  }

  ffmpegArgs.push("-movflags", "+faststart", outputPath);

  try {
    await execFileAsync(FFMPEG_PATH, ffmpegArgs, {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024
    });

    const probe = await probeMedia(outputPath);
    if (!probe.isValid) {
      throw new Error(`Muxed output failed MP4 validation: ${probe.error || "Corrupted stream"}`);
    }

    return {
      success: true,
      outputPath,
      probe,
      muxedCount: subtitleTracks.length
    };
  } catch (err) {
    console.warn(`[SubtitleService] Subtitle muxing warning: ${err.message}. Falling back to clean video.`);
    // Clean up failed output if any
    try { if (fs.existsSync(outputPath) && outputPath !== videoPath) fs.unlinkSync(outputPath); } catch {}
    if (videoPath !== outputPath) {
      fs.copyFileSync(videoPath, outputPath);
    }
    return {
      success: false,
      fallback: true,
      error: err.message,
      outputPath,
      muxedCount: 0
    };
  } finally {
    // Clean up temporary subtitle files
    for (const track of subtitleTracks) {
      try {
        if (track.filePath && fs.existsSync(track.filePath)) {
          fs.unlinkSync(track.filePath);
        }
      } catch {}
    }
  }
}
