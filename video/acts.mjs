// The human's steps of docs/VIDEO.md, performed through the real UI. Each returns after the UI confirms.
import { api, click, sleep, type, until } from "./lib.mjs";

export async function signIn(page, owner) {
  await click(page, page.locator("#signInBtn"));
  await page.locator("#tok").waitFor();
  await page.locator("#tok").fill(owner);
  await sleep(400);
  await click(page, page.locator("#signin button[type=submit]"));
  await page.locator("#signInBtn", { hasText: "Signed in" }).waitFor({ timeout: 15_000 });
}

export async function closeModal(page) {
  await page.keyboard.press("Escape");
  await sleep(300);
  if (await page.locator("#scrim:not([hidden])").count()) await page.locator("#scrim").click({ position: { x: 10, y: 10 } });
}

export async function addContext(page, { kind, name, title, body }) {
  await click(page, page.locator("[data-addctx]").first());
  await page.locator("#ac-kind").waitFor();
  await page.locator("#ac-kind").selectOption(kind);
  await type(page, page.locator("#ac-name"), name, { cps: 30 });
  await type(page, page.locator("#ac-title"), title, { cps: 36 });
  await type(page, page.locator("#ac-body"), body, { cps: 60 });
  await click(page, page.locator("#ac button[type=submit]"));
  await page.locator("#ac").waitFor({ state: "detached", timeout: 30_000 });
}

export async function newObjective(page, { id, title, criteria }) {
  await click(page, page.locator("[data-newobj]").first());
  await page.locator("#no-id").waitFor();
  await type(page, page.locator("#no-id"), id, { cps: 30 });
  await type(page, page.locator("#no-title"), title, { cps: 36 });
  await type(page, page.locator("#no-crit"), criteria.join("\n"), { cps: 60 });
  await Promise.all([page.waitForURL(`**/o/${id}`, { timeout: 30_000 }), click(page, page.locator("#no button[type=submit]"))]);
  await page.locator("#shell:not([hidden])").waitFor();
  await sleep(1500);
}

export async function newTask(page, { id, title, brief, group }) {
  await click(page, page.locator('[data-act="new-task"]'));
  await page.locator("#nt-id").waitFor();
  await type(page, page.locator("#nt-id"), id, { cps: 30 });
  await type(page, page.locator("#nt-title"), title, { cps: 36 });
  await type(page, page.locator("#nt-brief"), brief, { cps: 70 });
  if (group) await type(page, page.locator("#nt-alt"), group, { cps: 30 });
  await click(page, page.locator("#nt button[type=submit]"));
  await page.locator("#nt").waitFor({ state: "detached", timeout: 30_000 });
  await page.locator(`[data-start="${id}"]`).waitFor({ timeout: 20_000 });
}

export async function startTask(page, id, participant) {
  await click(page, page.locator(`[data-start="${id}"]`));
  await page.locator("#st-p").waitFor();
  await page.locator("#st-p").selectOption(participant);
  await sleep(500);
  await click(page, page.locator("#st button[type=submit]"));
  await page.locator("#st").waitFor({ state: "detached", timeout: 30_000 });
}

export const tab = (page, name) => click(page, page.locator(`#tab-${name}`));

/** Opens a contribution in the Inspector by clicking its node on the map. */
export async function inspect(page, id) {
  const node = page.locator(`[data-id="${id}"]`).first();
  await click(page, node);
  await page.locator("#tab-inspect[aria-selected=true]").waitFor({ timeout: 10_000 });
}

/** Settles one inbox review item as the human: a one-sentence reason, then the verdict button. */
export async function review(page, cid, verdict, why) {
  await tab(page, "inbox");
  const input = page.locator(`#rv-${cid}`);
  await input.waitFor({ timeout: 20_000 });
  await type(page, input, why, { cps: 40 });
  await click(page, page.locator(`[data-review="${cid}"][data-verdict="${verdict}"]`));
  await input.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
}

/** Accepts a ready outcome from the Outcomes tab, typing the reason when the form asks for one. */
export async function accept(page, kid, why) {
  await tab(page, "outcomes");
  const btn = page.locator(`[data-accept="${kid}"]`);
  await btn.waitFor({ timeout: 20_000 });
  await click(page, btn);
  const form = page.locator("#cr");
  if (await form.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    if (await page.locator("#cr-why").count()) await type(page, page.locator("#cr-why"), why, { cps: 50 });
    if (await page.locator("#cr-t").count()) await type(page, page.locator("#cr-t"), why, { cps: 50 });
    await click(page, page.locator("#cr button[type=submit]"));
    await form.waitFor({ state: "detached", timeout: 30_000 });
  }
}

/** Proposes and accepts the next version of a context item from the rail. */
export async function proposeVersion(page, itemId, body) {
  await click(page, page.locator(`[data-ctx="${itemId}"]`).first());
  const area = page.locator("#ctx-next");
  await area.waitFor({ timeout: 10_000 });
  await click(page, area, { settle: 200 });
  await area.fill("");
  await area.pressSequentially(body, { delay: 14 });
  await click(page, page.locator(`[data-ctxchange="${itemId}"]`));
  await sleep(2000);
}

export async function setPolicy(page, { agents, auto }) {
  const form = page.locator("#decide");
  await form.waitFor({ timeout: 15_000 });
  await click(page, form.locator(`input[name=decider][value=${agents ? "agents" : "human"}]`));
  const autoBox = form.locator("input[name=auto]");
  if ((await autoBox.isChecked()) !== auto) await click(page, autoBox);
  await click(page, form.locator("button[type=submit]"));
  await sleep(2500);
}

/** Invites an agent and returns the token the UI shows once. */
export async function invite(page, { id, name, family, model }) {
  await click(page, page.locator('[data-act="invite"]'));
  await page.locator("#iv-kind").waitFor();
  await page.locator("#iv-kind").selectOption("agent");
  await page.locator("#iv-kind").dispatchEvent("change");
  await type(page, page.locator("#iv-id"), id, { cps: 30 });
  await type(page, page.locator("#iv-name"), name, { cps: 36 });
  await type(page, page.locator("#iv-family"), family, { cps: 30 });
  await type(page, page.locator("#iv-model"), model, { cps: 30 });
  await click(page, page.locator("#iv button[type=submit]"));
  const pre = page.locator("pre.diff", { hasText: "Authorization Bearer" });
  await pre.waitFor({ timeout: 20_000 });
  const text = await pre.textContent();
  const token = /Bearer\s+(\S+)/.exec(text)?.[1];
  await sleep(2500);
  await closeModal(page);
  return token;
}

/** The activity stream's last lines, for the log. */
export const activity = async (page) => (await page.locator("#stream").innerText()).split("\n").slice(0, 6).join(" | ");

export { api, sleep, until };
