// Run with Bun and the pi-multiprovider checkout (no live credentials/network).
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthStorage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { trackMultiProvider, type AccountContext } from "../src/lib/multiprovider.ts";
import { clearQuotaCache, fetchContextQuotas } from "../src/lib/quotas.ts";

const checkout = resolve(process.argv[2] ?? "../pi-multiprovider");
const { createServiceAnnouncement } = await import(pathToFileURL(resolve(checkout, "src/announcement.ts")).href);
const { MultiProviderService } = await import(pathToFileURL(resolve(checkout, "src/service.ts")).href);
const scheduler = new MultiProviderService();
let ready = false;
const accounts = [{ id: "work", label: "Work", authKind: "oauth", credentialRef: "fixture" }];
const integration = {
  id: "anthropic", label: "Anthropic", accounts: () => accounts,
  resolveAuth: async () => ({ auth: { apiKey: "POOLED-FIXTURE" } }),
};
const auth = {
  get: () => ({ type: "oauth", access: "DEFAULT-FIXTURE" }),
  getApiKey: async () => "DEFAULT-FIXTURE",
} as unknown as AuthStorage;
const model = { id: "fixture", provider: "anthropic" };
const ctx = {
  model, sessionManager: { getSessionId: () => "fixture-session" },
  modelRegistry: { authStorage: auth },
} as unknown as AccountContext;
const announcement = createServiceAnnouncement({
  scheduler, isReady: () => ready,
  getIntegration: (id: string) => id === "anthropic" ? integration : undefined,
  getBaseProvider: () => ({ getModels: () => [model] }),
  affinityKeyFor: () => "fixture-session",
});
let listener: (service: unknown) => void = () => {};
const pi = { events: { on: (_event: string, cb: typeof listener) => {
  listener = cb; return () => { listener = () => {}; };
} } } as unknown as ExtensionAPI;
const snapshots: Awaited<ReturnType<typeof fetchContextQuotas>>[] = [];
let pending: Promise<unknown> = Promise.resolve();
const stop = trackMultiProvider(pi, () => {
  pending = fetchContextQuotas(ctx, "anthropic").then(snapshot => snapshots.push(snapshot));
});
async function announce() {
  listener(announcement);
  await pending;
}
const originalFetch = globalThis.fetch;
const sent: string[] = [];
globalThis.fetch = (async (_url, options) => {
  sent.push(new Headers(options?.headers).get("Authorization") ?? "");
  return Response.json({ five_hour: { utilization: 20 } });
}) as typeof fetch;

try {
  // Real extension announces at factory load, before the scheduler is populated.
  await announce();
  assert.equal(announcement.hasPool("anthropic"), undefined);
  assert.equal(snapshots.at(-1)?.result.success, false);
  assert.deepEqual(sent, []);

  const unregister = scheduler.registerProvider(integration);
  ready = true;
  await announce(); // no pin is still unknown, never the default login
  assert.equal(announcement.hasPool("anthropic"), true);
  assert.equal(snapshots.at(-1)?.result.success, false);
  assert.deepEqual(sent, []);

  await scheduler.pinAccount("anthropic", "fixture-session", "work");
  await announce(); // same stable object must refresh followers
  assert.equal(snapshots.at(-1)?.accountId, "anthropic:work");
  assert.equal((await announcement.resolveActiveAccountAuth("anthropic", ctx)).accountId, "work");
  assert.deepEqual(sent, ["Bearer POOLED-FIXTURE"]);

  ready = false; // removal/reconciliation must not reuse the old account cache
  await announce();
  assert.equal(snapshots.at(-1)?.account, undefined);
  assert.deepEqual(sent, ["Bearer POOLED-FIXTURE"]);
  unregister();
  ready = true;
  await announce();
  assert.equal(announcement.hasPool("anthropic"), false);
  assert.equal(snapshots.at(-1)?.accountId, undefined);
  assert.equal(snapshots.at(-1)?.result.success, true);
  assert.deepEqual(sent, ["Bearer POOLED-FIXTURE", "Bearer DEFAULT-FIXTURE"]);
  assert.equal(snapshots.length, 5);
  console.log("PASS: real announcement startup, unselected pool, same-object updates, pin, and removal.");
} finally {
  stop();
  globalThis.fetch = originalFetch;
  clearQuotaCache();
}
