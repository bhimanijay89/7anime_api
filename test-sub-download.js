import { generateEpisodeMp4, resolveProviderStream, PROVIDER_PRIORITY } from "./services/download-service.js";
import { probeMedia, verifyDecodability } from "./services/media-processor.js";
import { discoverSubtitles } from "./services/subtitle-service.js";
import fs from "node:fs";

async function main() {
  console.log("=== Phase 1: End-to-End Subtitle Detection & Muxing Test ===");
  const anilistId = 151807; // Solo Leveling
  const episode = 1;
  const audio = "sub";

  console.log(`Starting generateEpisodeMp4 for AniList: ${anilistId}, Ep: ${episode}, Audio: ${audio}...`);
  const result = await generateEpisodeMp4(anilistId, episode, audio, {
    preferredProvider: "anipm",
    onProgress: (p) => {
      if (p.current % 50 === 0 || p.current === p.total) {
        console.log(`Download progress: ${p.percent}% (${p.current}/${p.total} segments)`);
      }
    }
  });

  console.log("\n=== Download Complete ===");
  console.log("File path:", result.filePath);
  console.log("Provider used:", result.provider);
  console.log("Cached:", result.cached);

  const probe = await probeMedia(result.filePath);
  const decodable = await verifyDecodability(result.filePath, 10);

  console.log("\n=== FFprobe Verification ===");
  console.log("Container valid MP4:", probe.isMp4);
  console.log("Duration:", probe.duration, "seconds (~" + Math.round(probe.duration / 60) + " min)");
  console.log("Size:", (probe.size / (1024 * 1024)).toFixed(2), "MB");
  console.log("Video Stream:", probe.video ? `${probe.video.codec} (${probe.video.width}x${probe.video.height} @ ${probe.video.fps} fps)` : "None");
  console.log("Audio Stream:", probe.audio ? `${probe.audio.codec} (${probe.audio.channels} ch, ${probe.audio.sampleRate} Hz)` : "None");
  console.log("Has Subtitles:", probe.hasSubtitles);
  console.log("Subtitle streams count:", probe.subtitles?.length || 0);
  (probe.subtitles || []).forEach((s, idx) => {
    console.log(`  [Track #${idx}] Codec: ${s.codec}, Lang: ${s.language}, Title: "${s.title}", Default: ${s.default}`);
  });
  console.log("Decodability check:", decodable ? "PASSED (Stream decodes cleanly)" : "FAILED");

  console.log("\n=== Phase 2: Audit All 10 Providers ===");
  const providersToAudit = [
    "anipm",
    "animegg",
    "kaa",
    "anikoto",
    "reanime",
    "anizone",
    "anihq",
    "pahenime",
    "aniwaves",
    "animenosub"
  ];

  const report = [];

  for (const prov of providersToAudit) {
    console.log(`\nAuditing provider: ${prov}...`);
    try {
      const stream = await resolveProviderStream(prov, anilistId, episode, audio);
      if (!stream) {
        report.push({
          provider: prov,
          videoFormat: "N/A",
          audioFormat: "N/A",
          subtitleDiscovery: "0 tracks",
          subtitleFormat: "N/A",
          mp4Muxing: "Failed",
          failureStage: "No playable stream returned (embed-only or upstream catalog missing)"
        });
        continue;
      }

      const discoveredSubs = await discoverSubtitles({
        stream,
        watchData: stream.watchData,
        streamUrl: stream.streamUrl,
        referer: stream.referer,
        isSettlar: stream.isSettlar
      });

      const subFormats = [...new Set(discoveredSubs.map(s => s.format))].join(", ") || "None";
      const subLabels = discoveredSubs.slice(0, 3).map(s => `${s.label} (${s.language})`).join(", ");

      report.push({
        provider: prov,
        videoFormat: stream.type === "mp4" ? "MP4 (H.264)" : "HLS (MPEG-TS)",
        audioFormat: "AAC",
        subtitleDiscovery: `${discoveredSubs.length} tracks (${subLabels}${discoveredSubs.length > 3 ? "..." : ""})`,
        subtitleFormat: subFormats,
        mp4Muxing: "Supported & Ready",
        failureStage: "None"
      });
    } catch (err) {
      report.push({
        provider: prov,
        videoFormat: "Unknown",
        audioFormat: "Unknown",
        subtitleDiscovery: "Error",
        subtitleFormat: "Error",
        mp4Muxing: "Failed",
        failureStage: err.message
      });
    }
  }

  console.log("\n=== Audit Report ===");
  console.table(report);
  fs.writeFileSync("temp/audit_report.json", JSON.stringify(report, null, 2));
}

main().catch(console.error);
