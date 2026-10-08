// Fills the scale act from the scale reel's beats, renders cards and overlays, and cuts the narrated video.
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = process.env.VIDEO_DIR ?? process.cwd();
const WORK = `${DIR}/voiced`;
const plan = JSON.parse(readFileSync(`${DIR}/plan-voiced.json`, "utf8"));
const beats = readFileSync(`${DIR}/scale.beats.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const end = beats.find((b) => b.label === "end");
const video = `${DIR}/scale/${readdirSync(`${DIR}/scale`).find((f) => f.endsWith(".webm"))}`;
const minutes = Math.round((end.t - beats.find((b) => b.label === "objective page").t) / 60);
const words = (n) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"][n] ?? String(n);
const accepted = beats.find((b) => b.label === "whole outcome ready");
const numbers = `In ${minutes} minutes: ${end.tasks} tasks, ${end.contributions} contributions, ${end.reviews} agent reviews, ${end.candidates} outcomes composed, one accepted as a checkpoint, $${end.spend.toFixed(2)} at list prices.`;
const narration = `In ${minutes === 32 ? "thirty-two" : minutes} minutes: twenty-four tasks, ${words(end.contributions)} contributions, ${end.reviews === 32 ? "thirty-two" : end.reviews} agent reviews, ${words(end.candidates)} outcomes composed, and an ${words(accepted?.members ?? 11)}-module outcome accepted as a checkpoint, for ${(() => { const [d, c] = end.spend.toFixed(2).split("."); return `${words(+d)} dollar${+d === 1 ? "" : "s"}${c === "00" ? "" : " " + c}`; })()} at list prices. Every number comes from the objective page itself.`;
plan.segments = plan.segments.map((s) => {
  if (s.video !== "SCALE_VIDEO") return s;
  const seg = { ...s, video, beats: `${DIR}/scale.beats.jsonl` };
  if (seg.caption === "SCALE_NUMBERS") seg.caption = numbers;
  if (seg.narration === "SCALE_NARRATION") seg.narration = narration;
  return seg;
});
for (const s of plan.segments) { if (s.beats && !s.beats.startsWith("/")) s.beats = `${DIR}/${s.beats}`; if (s.video && !s.video.startsWith("/")) s.video = `${DIR}/${s.video}`; }
writeFileSync(`${DIR}/plan-voiced-render.json`, JSON.stringify(plan, null, 2));
console.log("scale narration:", narration);
execFileSync("node", [`${DIR}/cards.mjs`, `${DIR}/plan-voiced-render.json`, `${WORK}/cards`], { stdio: "inherit" });
execFileSync("node", [`${DIR}/captions.mjs`, `${DIR}/plan-voiced-render.json`, `${WORK}/overlays`], { stdio: "inherit" });
execFileSync("node", [`${DIR}/cut2.mjs`, `${DIR}/plan-voiced-render.json`, WORK, `${DIR}/nest-demo-voiced.mp4`], { stdio: "inherit" });
copyFileSync(`${DIR}/nest-demo-voiced.mp4`, "/Users/scott/Desktop/nest-demo-voiced.mp4");
console.log("copied to ~/Desktop/nest-demo-voiced.mp4");
