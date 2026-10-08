// Fills the scale act into the plan from the scale reel's own beats and numbers, renders overlays, cuts the
// video, and copies it to the Desktop. Usage: node finalize.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const plan = JSON.parse(readFileSync(`${DIR}/plan-final.json`, "utf8"));
const beats = readFileSync(`${DIR}/scale.beats.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const has = (label) => beats.some((b) => b.label === label);
const end = beats.find((b) => b.label === "end") ?? beats[beats.length - 1];
const video = `${DIR}/scale/${readdirSync(`${DIR}/scale`).find((f) => f.endsWith(".webm"))}`;
const minutes = Math.round((end.t - beats.find((b) => b.label === "objective page").t) / 60);
const numbers = `In ${minutes} minutes: ${end.tasks ?? 24} tasks, ${end.contributions ?? "?"} contributions, ${end.reviews ?? "?"} agent reviews, ${end.candidates ?? "?"} outcomes composed${has("accepted") ? ", one accepted as a checkpoint" : ""}, $${Number(end.spend ?? 0).toFixed(2)} at list prices. Every number is the objective page's own.`;

plan.segments = plan.segments.map((s) => {
  if (s.video !== "SCALE_VIDEO") return s;
  const seg = { ...s, video, beats: `${DIR}/scale.beats.jsonl` };
  if (seg.caption === "SCALE_NUMBERS") seg.caption = numbers;
  if (!has("whole outcome ready")) {
    // No whole outcome became ready while the camera ran: the map filling is the shot, and the numbers the story.
    if (seg.to === "whole outcome ready") { seg.to = "end"; seg.speed = 32; }
    else return null;
  }
  return seg;
}).filter(Boolean);
for (const s of plan.segments) { if (s.beats && !s.beats.startsWith("/")) s.beats = `${DIR}/${s.beats}`; if (!s.video.startsWith("/")) s.video = `${DIR}/${s.video}`; }
writeFileSync(`${DIR}/plan-render.json`, JSON.stringify(plan, null, 2));
console.log("scale caption:", numbers);
execFileSync("node", [`${DIR}/captions.mjs`, `${DIR}/plan-render.json`, `${DIR}/overlays-final`], { stdio: "inherit" });
execFileSync("node", [`${DIR}/cut.mjs`, `${DIR}/plan-render.json`, `${DIR}/overlays-final`, `${DIR}/nest-demo.mp4`], { stdio: "inherit" });
copyFileSync(`${DIR}/nest-demo.mp4`, "/Users/scott/Desktop/nest-demo.mp4");
console.log("copied to ~/Desktop/nest-demo.mp4");
