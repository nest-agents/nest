// The narrated cut. Segments come from the reels (by beat) or from full-frame cards; each may carry a short
// on-screen caption and a narration line, spoken by a text-to-speech voice. A segment lasts at least as long
// as its narration (the last frame holds), so the voice never runs over the next shot.
// Usage: node cut2.mjs plan.json workDir out.mp4
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [planPath, work, out] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
mkdirSync(`${work}/tts`, { recursive: true });
const beats = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString().trim());

async function speak(text, i) {
  const key = createHash("sha1").update(`${plan.voice}|${plan.voiceInstructions}|${text}`).digest("hex").slice(0, 12);
  const file = `${work}/tts/${key}.mp3`;
  if (!existsSync(file)) {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: plan.voice, response_format: "mp3", instructions: plan.voiceInstructions, input: text }),
    });
    if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return { file, dur: probe(file) };
}

const overlays = JSON.parse(readFileSync(`${work}/overlays/index.json`, "utf8"));
const cards = JSON.parse(readFileSync(`${work}/cards/index.json`, "utf8"));
const inputs = [];
const inputIndex = (f, extra = []) => { let k = inputs.findIndex((x) => x.f === f); if (k < 0) { inputs.push({ f, extra }); k = inputs.length - 1; } return k; };
const chains = [], vlabels = [], alabels = [];
let total = 0;
const log = [];
for (const [i, seg] of plan.segments.entries()) {
  let visual, src;
  if (seg.card) {
    visual = seg.dur ?? 8;
    const v = inputIndex(cards[i], ["-loop", "1", "-framerate", "30", "-t", String(visual + 30)]);
    src = `[${v}:v]trim=duration=${visual.toFixed(3)},setpts=PTS-STARTPTS,fps=30,scale=1920:1080,format=yuv420p`;
  } else {
    const b = seg.beats ? beats(seg.beats) : [];
    const at = (ref) => typeof ref === "number" ? ref : b.find((x) => x.label === ref)?.t ?? (() => { throw new Error(`no beat ${ref} in ${seg.beats}`); })();
    let from = at(seg.from); if (seg.fromOffset) from += seg.fromOffset;
    const to = typeof seg.to === "string" && seg.to.startsWith("+") ? from + Number(seg.to.slice(1)) : at(seg.to);
    if (to <= from) throw new Error(`empty segment ${i}`);
    const speed = seg.speed ?? 1;
    visual = (to - from) / speed;
    const v = inputIndex(seg.video);
    src = `[${v}:v]trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=(PTS-STARTPTS)/${speed},fps=30,crop=1600:900:0:0,scale=1920:1080:flags=lanczos,format=yuv420p`;
  }
  const narration = seg.narration ? await speak(seg.narration, i) : null;
  const lead = 0.4;
  const dur = Math.max(visual, narration ? narration.dur + lead + 0.5 : 0, seg.minDur ?? 0);
  total += dur;
  log.push({ i, visual: +visual.toFixed(1), narration: narration ? +narration.dur.toFixed(1) : 0, dur: +dur.toFixed(1) });
  let chain = `${src}`;
  if (dur > visual + 0.05) chain += `,tpad=stop_mode=clone:stop_duration=${(dur - visual).toFixed(3)}`;
  chain += `[s${i}]`;
  chains.push(chain);
  let cur = `s${i}`;
  if (overlays[i]?.bar && (seg.caption || (seg.speed ?? 1) > 1)) { const o = inputIndex(overlays[i].bar, ["-loop", "1", "-framerate", "30", "-t", "1"]); chains.push(`[${cur}][${o}:v]overlay=0:0:format=auto[b${i}]`); cur = `b${i}`; }
  if (overlays[i]?.card) { const o = inputIndex(overlays[i].card, ["-loop", "1", "-framerate", "30", "-t", "1"]); chains.push(`[${cur}][${o}:v]overlay=0:0:format=auto:enable='lt(t,${Math.min(2.8, dur).toFixed(2)})'[c${i}]`); cur = `c${i}`; }
  chains.push(`[${cur}]trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  vlabels.push(`[v${i}]`);
  if (narration) {
    const a = inputIndex(narration.file);
    chains.push(`[${a}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(lead * 1000)}|${Math.round(lead * 1000)},apad=whole_dur=${dur.toFixed(3)},atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  } else {
    chains.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  }
  alabels.push(`[a${i}]`);
}
const pairs = vlabels.map((v, k) => `${v}${alabels[k]}`).join("");
const fc = chains.join(";") + ";" + pairs + `concat=n=${vlabels.length}:v=1:a=1[vout][aout]`;
const args = ["-y", "-loglevel", "error"];
for (const x of inputs) args.push(...x.extra, "-i", x.f);
args.push("-filter_complex", fc, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out);
writeFileSync(`${out}.ffmpeg-args.txt`, args.join("\n"));
writeFileSync(`${out}.timing.json`, JSON.stringify(log, null, 2));
console.log(`segments ${vlabels.length}, total ${(total / 60).toFixed(1)} min (${total.toFixed(0)} s)`);
execFileSync("ffmpeg", args, { stdio: "inherit", maxBuffer: 1 << 26 });
console.log("wrote", out);
