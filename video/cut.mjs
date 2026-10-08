// Cuts recordings into the video: segments picked by beat labels, waits run fast with a speed badge, the
// narration burned in from pre-rendered overlays. Usage: node cut.mjs plan.json overlays/ out.mp4
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [planPath, overlayDir, out] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const overlays = JSON.parse(readFileSync(`${overlayDir}/index.json`, "utf8"));
const beats = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Each segment: { video, beats, from: label|seconds, to: label|seconds|+duration, fromOffset, speed, caption, title }
const inputs = [];
const inputIndex = (f) => { let k = inputs.indexOf(f); if (k < 0) { inputs.push(f); k = inputs.length - 1; } return k; };
const chains = [];
const labels = [];
let total = 0;
plan.segments.forEach((seg, i) => {
  const b = seg.beats ? beats(seg.beats) : [];
  const at = (ref) => typeof ref === "number" ? ref : b.find((x) => x.label === ref)?.t ?? (() => { throw new Error(`no beat ${ref} in ${seg.beats}`); })();
  let from = at(seg.from);
  if (seg.fromOffset) from += seg.fromOffset;
  const to = typeof seg.to === "string" && seg.to.startsWith("+") ? from + Number(seg.to.slice(1)) : at(seg.to);
  if (to <= from) throw new Error(`empty segment ${i}: ${JSON.stringify(seg)}`);
  const speed = seg.speed ?? 1;
  const dur = (to - from) / speed;
  total += dur;
  const v = inputIndex(seg.video), bar = inputIndex(overlays[i].bar), card = overlays[i].card ? inputIndex(overlays[i].card) : null;
  const src = `[${v}:v]trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=(PTS-STARTPTS)/${speed},fps=30,crop=1600:900:0:0,scale=1920:1080:flags=lanczos,format=yuv420p[s${i}]`;
  const withBar = `[s${i}][${bar}:v]overlay=0:0:format=auto[b${i}]`;
  chains.push(src, withBar);
  if (card !== null) {
    const show = Math.min(2.8, dur).toFixed(2);
    chains.push(`[b${i}][${card}:v]overlay=0:0:format=auto:enable='lt(t,${show})'[c${i}]`);
    labels.push(`[c${i}]`);
  } else labels.push(`[b${i}]`);
});
const fc = chains.join(";") + ";" + labels.join("") + `concat=n=${labels.length}:v=1:a=0,format=yuv420p[out]`;
const args = ["-y", "-loglevel", "error"];
for (const f of inputs) { if (f.endsWith(".png")) args.push("-loop", "1", "-framerate", "30", "-t", "1"); args.push("-i", f); }
args.push("-filter_complex", fc, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out);
writeFileSync(`${out}.ffmpeg-args.txt`, args.join("\n"));
console.log(`segments ${labels.length}, total ${total.toFixed(1)} s`);
execFileSync("ffmpeg", args, { stdio: "inherit", maxBuffer: 1 << 26 });
console.log("wrote", out);
