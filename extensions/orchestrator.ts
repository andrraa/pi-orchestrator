import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "orchestrator.json");

type RoleKey = "context" | "coder" | "security" | "qa";

const ROLE_KEYS: RoleKey[] = ["context", "coder", "security", "qa"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface Config {
  roles: Record<RoleKey, string>;
  thinking: Record<RoleKey, string>;
  stages: Record<"context" | "security" | "qa", boolean>;
}

const ROLES: { key: RoleKey; label: string; agent: string; hint: string }[] = [
  { key: "context", label: "Context engine", agent: "scout", hint: "stage 1: gather files, facts, constraints" },
  { key: "coder", label: "Lead coder", agent: "worker", hint: "stage 2: implement from the context" },
  { key: "security", label: "Security specialist", agent: "reviewer", hint: "stage 3: audit the diff for security holes" },
  { key: "qa", label: "QA", agent: "reviewer", hint: "stage 3: test and validate the diff" },
];

const DEFAULTS: Config = {
  stages: { context: true, security: true, qa: true },
  roles: { context: "", coder: "", security: "", qa: "" },
  thinking: { context: "", coder: "", security: "", qa: "" },
};

// --- pi-subagents RPC bridge (in-process event bus) -------------------------
const RPC_VERSION = 1;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SPAWN_TIMEOUT_MS = 20_000;
const PIPELINE_TIMEOUT_MS = 45 * 60 * 1000;

// --- pipeline + enforcement state (module scope) ----------------------------
let pipelineState: { verified: boolean; lastRunId?: string; unavailable?: boolean } = { verified: false };
let taskActive = false;
let pendingPrompt: string | undefined;

// Memoized positive "can we talk to pi-subagents?" answer. Undefined until a probe succeeds.
// A negative answer is never memoized: a slow boot or a momentary delay must not
// pin the bridge as MISSING for the rest of the pi process.
let bridgeOk: boolean | undefined;
const PROBE_TIMEOUT_MS = 3_000;

export const MISSING_DEPENDENCY =
  "orchestrator: pi-subagents is not installed or not enabled. Run `pi install npm:pi-subagents`, then restart pi. An orchestrator task cannot start without it.";

/**
 * `pi-subagents` does not register anything we can enumerate from an extension,
 * so the only honest probe is to speak its RPC.
 *
 * We probe with "ping" because pi-subagents answers it from memory, before its
 * session-context check; "status" without a run id can instead fall through to
 * agent discovery and wait unbounded, making a timeout look like a missing
 * package. A reply (even an RPC-level error) proves the bridge exists; only a
 * timeout means nothing is listening. We cache only a positive answer so one
 * slow boot cannot pin the bridge as missing for the whole session.
 */
function probeBridge(pi: ExtensionAPI): Promise<boolean> {
  if (bridgeOk) return Promise.resolve(true);
  return rpcRequest(pi, "ping", {}, PROBE_TIMEOUT_MS).then((reply) => {
    // An RPC-level error (unknown method, no such run) still proves the bridge
    // is up; only "nothing answered" means pi-subagents is missing.
    const alive = !(reply.ok === false && /no reply within/i.test(reply.error ?? ""));
    if (alive) bridgeOk = true;
    return alive;
  });
}

function load(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { roles: { ...DEFAULTS.roles, ...raw.roles }, thinking: normalizeThinking(raw.thinking), stages: { context: raw.stages?.context !== false, security: raw.stages?.security !== false, qa: raw.stages?.qa !== false } };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS)) as Config;
  }
}

/** Tolerate a missing/old `thinking` key and ignore unknown level strings. */
function normalizeThinking(raw: unknown): Record<RoleKey, string> {
  const out: Record<RoleKey, string> = { ...DEFAULTS.thinking };
  if (raw && typeof raw === "object") {
    for (const key of ROLE_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) out[key] = value;
    }
  }
  return out;
}

function save(cfg: Config) {
  // Atomic write: a concurrent reader never sees a torn file, which would make
  // load() fall back to DEFAULTS and lose the operator's settings.
  const tmpPath = CONFIG_PATH + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmpPath, CONFIG_PATH);
}

/**
 * Read-modify-write the config in one step so every mutation starts from the
 * freshest on-disk state instead of a stale snapshot captured when a menu opened.
 */
function updateConfig(mutate: (cfg: Config) => void): Config {
  const cfg = load();
  mutate(cfg);
  save(cfg);
  return cfg;
}

function modelIds(ctx: ExtensionCommandContext): string[] {
  return ctx.modelRegistry
    .getAvailable()
    .map((m) => `${m.provider}/${m.id}`)
    .sort();
}

const THINKING_CYCLE = ["default", ...THINKING_LEVELS];
const MENU_VISIBLE = 12;
const MANAGER_ID = "manager";

/**
 * Searchable model list. Typing filters (case-insensitive substring, so "3.8"
 * or "glm" both hit), arrows scroll, Enter picks and Esc cancels.
 */
function pickModel(ctx: ExtensionCommandContext, title: string, current: string): Promise<string | undefined> {
  const all = modelIds(ctx);
  if (all.length === 0) {
    ctx.ui.notify("No models available", "error");
    return Promise.resolve(undefined);
  }
  return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
    // Plain state, no Input component: pi focuses the component this factory
    // returns, and an inner Input would never receive the keystrokes.
    let query = "";
    let filtered = all;
    let index = Math.max(0, all.indexOf(current));
    const refilter = () => {
      const needle = query.trim().toLowerCase();
      filtered = needle ? all.filter((id) => id.toLowerCase().includes(needle)) : all;
      index = Math.max(0, filtered.indexOf(current));
    };

    return {
      invalidate() {},
      render(width: number) {
        const lines = [`${title}`, "", `  cari> ${query}`, ""];
        if (filtered.length === 0) {
          lines.push("  tidak ada model yang cocok");
        } else {
          const visible = Math.min(filtered.length, MENU_VISIBLE);
          const from = Math.max(0, Math.min(index - Math.floor(visible / 2), filtered.length - visible));
          for (let i = from; i < from + visible; i++) {
            const mark = filtered[i] === current ? "✓" : i === index ? "→" : " ";
            lines.push(`  ${mark} ${filtered[i]}`);
          }
          if (filtered.length > visible) lines.push(`  (${index + 1}/${filtered.length})`);
        }
        lines.push("");
        lines.push(`  ketik mencari · ↑↓ pilih · ${keybindings.getKeys("tui.select.confirm").join("/")} simpan · esc batal`);
        return lines;
      },
      handleInput(data: string) {
        const confirm = keybindings.matches(data, "tui.select.confirm");
        if (keybindings.matches(data, "tui.select.cancel")) return done(undefined);
        if (keybindings.matches(data, "tui.select.up")) {
          index = index === 0 ? filtered.length - 1 : index - 1;
        } else if (keybindings.matches(data, "tui.select.down")) {
          index = index === filtered.length - 1 ? 0 : index + 1;
        } else if (confirm || data === "\r") {
          return done(filtered[index]);
        } else if (keybindings.matches(data, "tui.editor.deleteCharBackward") || data === "\x7f") {
          if (query) query = query.slice(0, -1);
          refilter();
        } else if (data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 0x7f) {
          query += data;
          refilter();
        }
        tui.requestRender();
      },
    };
  });
}

/**
 * One pass of the settings menu. Resolves with the row id the user activated,
 * or undefined when they cancelled. Selecting a model rows does NOT change
 * anything by itself: the caller opens the picker, so the menu stays reachable.
 */
function menuOnce(ctx: ExtensionCommandContext, unavailable: boolean): Promise<string | undefined> {
  const cfg = load();
  const manager = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default";

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const value = (key: RoleKey) => cfg.roles[key] || "belum dipilih";
    const items: SettingItem[] = [
      // a one-element `values` array makes Enter fire onChange without moving focus
      { id: MANAGER_ID, label: "Manager model", currentValue: manager, values: [manager] },
      ...(["context", "security", "qa"] as const).map((key) => ({
        id: `stage:${key}`, label: `Run ${role(key).label}`,
        currentValue: cfg.stages[key] ? "ON" : "OFF", values: ["ON", "OFF"],
      })),
      ...ROLES.map((r) => ({ id: r.key, label: r.label, currentValue: value(r.key), values: [value(r.key)], description: `${r.agent} — ${r.hint}` })),
      ...ROLES.map((r) => ({
        id: `think:${r.key}`,
        label: `Thinking ${r.label}`,
        currentValue: cfg.thinking[r.key] || "default",
        values: THINKING_CYCLE,
      })),
      { id: "status", label: "pi-subagents", currentValue: unavailable ? "MISSING" : "ok", values: [""] },
    ];

    const list = new SettingsList(
      items,
      MENU_VISIBLE,
      getSettingsListTheme(),
      (id, newValue) => {
        if (id.startsWith("stage:")) {
          updateConfig((c) => { c.stages[id.slice(6) as keyof Config["stages"]] = newValue === "ON"; });
          return;
        }
        if (id.startsWith("think:")) {
          updateConfig((c) => {
            c.thinking[id.slice(6) as RoleKey] = newValue === "default" ? "" : newValue;
          });
          return;
        }
        if (id === MANAGER_ID || ROLES.some((r) => r.key === id)) return done(id);
      },
      () => done(undefined),
      // no search: the menu is a short fixed list, so the hint line is just noise
      { enableSearch: false },
    );
    list.selectItem(MANAGER_ID);

    const title = {
      invalidate() {},
      render: (_width: number) => [theme.fg("accent", theme.bold("Orchestrator")), ""],
    };
    const container = new Container();
    container.addChild(title);
    container.addChild(list);

    return {
      invalidate() {
        container.invalidate();
      },
      render(width: number) {
        return container.render(width);
      },
      handleInput(data: string) {
        // Tab cycles the highlighted row instead of leaving the menu
        list.handleInput(data === "\t" ? " " : data);
        tui.requestRender();
      },
    };
  });
}

/** Menu and picker alternate so a selection lands back in the menu, not at the prompt. */
async function openMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const missing = !(await probeBridge(pi));
  if (missing) ctx.ui.notify(MISSING_DEPENDENCY, "error");
  for (;;) {
    const row = await menuOnce(ctx, missing);
    if (row === undefined) return;

    if (row === MANAGER_ID) {
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      const pick = await pickModel(ctx, "Manager model (main session)", current);
      if (!pick) continue;
      const [provider, ...rest] = pick.split("/");
      const model = ctx.modelRegistry.find(provider, rest.join("/"));
      if (!model) {
        ctx.ui.notify(`Model not found: ${pick}`, "error");
        continue;
      }
      const ok = await pi.setModel(model);
      ctx.ui.notify(ok ? `Manager model → ${pick}` : `No auth configured for provider: ${provider}`, ok ? "info" : "error");
      continue;
    }

    const key = row as RoleKey;
    const pick = await pickModel(ctx, `${role(key).label} [${role(key).agent}]`, load().roles[key]);
    if (!pick) continue;
    updateConfig((c) => {
      c.roles[key] = pick;
    });
    ctx.ui.notify(`${role(key).label} → ${pick}`, "info");
  }
}

function role(k: RoleKey) {
  return ROLES.find((r) => r.key === k)!;
}

function guidelines(cfg: Config): string[] {
  return [
    "The operator submitted this task with /orchestrator. You are the manager: call orchestrate with the complete task and acceptance criteria, then synthesize its report.",
    `Enabled checks: research=${cfg.stages.context}, security=${cfg.stages.security}, QA=${cfg.stages.qa}. Report skipped or failed checks honestly; fixed-unverified is not clean.`,
    "Do not edit source, launch writers directly, or bypass orchestration through bash, workflows or other delegation tools. The gate is a routing guard, not a security sandbox.",
    "Do not make final source adjustments after review. Report remaining blockers and verification limits instead of claiming success or silently falling back to direct edits.",
  ];
}

/**
 * Pure enforcement predicate (no I/O, total). Returns a block directive when
 * the parent tries to bypass the pipeline, otherwise undefined.
 */
export function enforcementDecision(
  toolName: string,
  input: Record<string, unknown>,
  state: { verified: boolean; unavailable?: boolean },
  cfg: { active: boolean },
): { block: true; reason: string } | undefined {
  if (!cfg.active) return undefined;
  if (process.env.PI_SUBAGENT_CHILD === "1") return undefined;
  if (state.unavailable) return undefined; // fail open: a broken pi-subagents install must not wedge the session
  if (state.verified) return undefined;
  if (toolName === "edit" || toolName === "write") {
    return {
      block: true,
      reason:
        "This orchestrator task is active: the manager must not write code itself. Call the orchestrate tool and let the coder stage implement, then report its result without unreviewed source adjustments.",
    };
  }
  const agent = input && typeof (input as { agent?: unknown }).agent === "string" ? ((input as { agent: string }).agent).trim().toLowerCase() : undefined;
  if (toolName === "subagent" && agent === role("coder").agent.trim().toLowerCase()) {
    return {
      block: true,
      reason: "This orchestrator task is active: launch the coder only through the orchestrate pipeline, not by calling the subagent tool directly.",
    };
  }
  return undefined;
}

/**
 * The workflow-sandbox script body the orchestrate tool ships to pi-subagents.
 * Plain (non-async) helpers + top-level await only; args is plain data.
 */
export function buildPipelineScript(): string {
  return `
const NL = String.fromCharCode(10);
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function withThinking(model, level) {
  if (!model || !level) return model;
  const i = model.lastIndexOf(":");
  if (i !== -1 && LEVELS.indexOf(model.substring(i + 1)) !== -1) return model.slice(0, i) + ":" + level;
  return model + ":" + level;
}
function child(agent, task, model, level, schema) {
  const spec = { agent: agent, task: task };
  const m = withThinking(model, level);
  if (m) spec.model = m;
  if (schema) spec.outputSchema = schema;
  spec.task += NL + NL + "Keep the handoff concise (target 500 words; exceed only for essential correctness evidence). Use file paths and decisions, not copied source or full logs. Preserve detailed logs in a file and cite its path; include failing command, exit status and relevant error excerpt. Never omit a blocker to meet the target.";
  return spec;
}
function withKey(key, spec) {
  spec.key = key;
  return spec;
}
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["clean", "blocked"] },
    findings: { type: "array", items: { type: "string" } },
    evidence: { type: "string" }
  },
  required: ["verdict", "findings", "evidence"],
  additionalProperties: false
};
const metrics = {};
function record(key, result) {
  const rows = result.results || [];
  const fields = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"];
  const usage = {};
  for (const field of fields) {
    usage[field] = rows.length > 0 && rows.every(r => r.usage && Number.isFinite(r.usage[field]))
      ? rows.reduce((sum, r) => sum + r.usage[field], 0) : null;
  }
  // Child results do not expose duration; workflow trace owns it. Do not invent it.
  metrics[key] = { usage, durationMs: null, runId: result.runId || null };
  return result;
}
function runStage(key, spec) {
  return Promise.resolve().then(() => runs.run(key, spec)).catch(error => ({
    ok: false, error: error instanceof Error ? error.message : String(error)
  }));
}
const stages = args.stages || {};
const skipped = [stages.context === false ? "research" : null, stages.security === false ? "security" : null, stages.qa === false ? "qa" : null].filter(Boolean);
const task = args.task;
const research = stages.context === false ? { ok: true, output: "Research skipped by operator. Inspect the relevant files and constraints before editing." } : await runStage("research", child(
  args.contextAgent,
  "Gather the files, facts, and constraints needed to change this codebase safely." + NL + NL + "TASK:" + NL + task + NL + NL + "Stay within the requested scope. For standalone temporary fixtures, inspect only the runtime and fixture requirements, not the host repository. For repository changes, inspect the working tree and identify existing user changes to preserve. Do not edit source or revert changes. Use these handoff headings: Scope and acceptance criteria; Relevant files, callers and tests; Constraints and existing user changes; Minimum implementation plan; Verification commands; Uncertainties and blockers. Cite paths and line numbers where useful. Discover the actual test commands; do not invent them.",
  args.contextModel,
  args.thinkingContext
));
if (stages.context !== false) record("research", research);
if (research.ok !== true) return { metrics, verdict: "unverified", failedStage: "research", error: research.error || research.output || "no result", partialChanges: false };
const implementation = await runStage("implement", child(
  args.coderAgent,
  "Make the requested change in the current working directory." + NL + NL + "TASK:" + NL + task + NL + NL + "RESEARCH (from the context stage):" + NL + research.output + NL + NL + "Inspect the actual files and working tree before editing. Preserve unrelated and existing user changes; implement only the requested scope. Add a focused regression test for non-trivial changes. Run the focused tests and report changed paths, commands, exit statuses, results and any limitations.",
  args.coderModel,
  args.thinkingCoder
));
record("implement", implementation);
if (implementation.ok !== true) return { metrics, verdict: "unverified", failedStage: "implement", error: implementation.error || implementation.output || "no result", partialChanges: true };
const reviewBrief = "TASK:" + NL + task + NL + NL + "RESEARCH SUMMARY:" + NL + research.output + NL + NL + "IMPLEMENTATION REPORT (coder):" + NL + implementation.output;
const specs = [
  withKey("security", child(
    args.securityAgent,
    reviewBrief + NL + NL + "Do not edit source or revert user changes. Treat the coder report as guidance, not evidence: independently inspect the actual diff and connected callers. Audit the changes just made for security defects (injection, authorization, secrets, unsafe input handling, data exposure). Each finding must identify exact file:line, a concrete failure scenario, impact and the minimum fix. Supply evidence describing the inspected paths and checks. Do not report speculative or style-only blockers. Set the verdict to blocked when any defect must be fixed before shipping, otherwise clean.",
    args.securityModel,
    args.thinkingSecurity,
    REVIEW_SCHEMA
  )),
  withKey("qa", child(
    args.qaAgent,
    reviewBrief + NL + NL + "Do not edit source or revert user changes; normal test artifacts are allowed. Treat the coder report as guidance, not evidence: inspect the actual diff and connected callers independently. Verify acceptance criteria and run relevant tests. Evidence must include exact commands, exit statuses, results and verification limitations. Each finding must identify a concrete failure, location, impact and minimum fix. If essential verification cannot run, return blocked with empty findings and explain the limitation in evidence; do not invent code defects to describe infrastructure failures. Set the verdict to blocked when the change is unverified or broken, otherwise clean.",
    args.qaModel,
    args.thinkingQa,
    REVIEW_SCHEMA
  ))
];
const enabledSpecs = specs.filter(spec => stages[spec.key] !== false);
const review = enabledSpecs.length ? await Promise.all(enabledSpecs.map(spec => runStage(spec.key, spec))) : [];
const security = stages.security === false ? { skipped: true } : record("security", review[enabledSpecs.findIndex(s => s.key === "security")]);
const qa = stages.qa === false ? { skipped: true } : record("qa", review[enabledSpecs.findIndex(s => s.key === "qa")]);
function validReview(r) {
  const out = r && r.structuredOutput;
  return r && r.ok === true && out &&
    (out.verdict === "clean" || out.verdict === "blocked") &&
    Array.isArray(out.findings) && out.findings.every(f => typeof f === "string" && f.trim()) &&
    typeof out.evidence === "string" && out.evidence.trim().length > 0 &&
    (out.verdict !== "clean" || out.findings.length === 0);
}
const checks = [security, qa].filter(r => !r.skipped);
const blocked = checks.some(r => !validReview(r) || r.structuredOutput.verdict !== "clean");
const findings = checks.filter(r => validReview(r) && r.structuredOutput.verdict === "blocked")
  .flatMap(r => r.structuredOutput.findings);
let fix = null;
if (findings.length > 0) {
  fix = await runStage("fix", child(
    args.coderAgent,
    "Fix only the concrete blockers below. Inspect the working tree and preserve unrelated and existing user changes. Re-run the failing commands and relevant regression tests; report commands, exit statuses and limitations." + NL + NL + "TASK:" + NL + task + NL + NL + "RESEARCH:" + NL + research.output + NL + NL + "IMPLEMENTATION:" + NL + implementation.output + NL + NL + "REVIEW EVIDENCE:" + NL + JSON.stringify(checks.map(r => ({ review: r.structuredOutput, error: r.error }))) + NL + NL + "BLOCKERS (verbatim):" + NL + findings.join(NL) + NL + NL + "Report exactly which files changed and the test results.",
    args.coderModel,
    args.thinkingCoder
  ));
  record("fix", fix);
}
return {
  metrics,
  skipped,
  research: { artifacts: research.artifactPaths || [], outputReference: research.outputReference || null },
  implementation: { artifacts: implementation.artifactPaths || [], outputReference: implementation.outputReference || null },
  security: security.skipped ? { skipped: true } : { valid: !!validReview(security), review: security.structuredOutput || null, error: security.error || null, output: security.output || null },
  qa: qa.skipped ? { skipped: true } : { valid: !!validReview(qa), review: qa.structuredOutput || null, error: qa.error || null, output: qa.output || null },
  fix: fix ? { output: fix.output || null, error: fix.error || null } : null,
  // Fixes are never independently verified; failed/empty checks never trigger speculative edits.
  verdict: fix ? (fix.ok === true ? "fixed-unverified" : "unverified") :
    (blocked ? "unverified" : (security.skipped || qa.skipped ? "completed-with-skips" : "clean"))
};
`.trim();
}

// --- RPC helpers ------------------------------------------------------------

type RpcReply = { ok: true; data: any } | { ok: false; error: string };

function rpcRequest(pi: ExtensionAPI, method: string, params: unknown, timeoutMs: number): Promise<RpcReply> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (value: RpcReply) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      resolve(value);
    };
    unsubscribe = pi.events.on(RPC_REPLY_EVENT_PREFIX + requestId, (data) => {
      const reply = data as { requestId?: string; success?: boolean; data?: any; error?: { message?: string } };
      if (!reply || reply.requestId !== requestId) return;
      if (reply.success) finish({ ok: true, data: reply.data });
      else finish({ ok: false, error: reply.error?.message || "pi-subagents reported an error" });
    });
    timer = setTimeout(() => finish({ ok: false, error: `no reply within ${timeoutMs}ms` }), timeoutMs);
    pi.events.emit(RPC_REQUEST_EVENT, { version: RPC_VERSION, requestId, method, params });
  });
}

function payloadText(payload: Record<string, unknown>): string {
  for (const value of [payload.text, payload.summary]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

type Completion =
  | { status: "completed"; text: string; success: boolean }
  | { status: "timeout" }
  | { status: "aborted" };

/** Wait for the terminal result by event subscription (no polling, no I/O). */
function waitForCompletion(
  pi: ExtensionAPI,
  runId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Completion> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const onAbort = () => finish({ status: "aborted" });
    const finish = (value: Completion) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    unsubscribe = pi.events.on(ASYNC_COMPLETE_EVENT, (data) => {
      const payload = data as Record<string, unknown>;
      if (!payload || (payload.runId !== runId && payload.id !== runId)) return;
      const text = payloadText(payload);
      if (text) {
        // Fail closed here (unlike the spawn path): only an explicit success unlocks editing.
        finish({ status: "completed", text, success: payload.success === true });
        return;
      }
      rpcRequest(pi, "status", { id: runId }, SPAWN_TIMEOUT_MS).then((reply) => {
        const details = reply.ok ? reply.data?.details : undefined;
        const statusText = reply.ok && typeof reply.data?.text === "string" ? reply.data.text : "Pipeline finished.";
        const success = payload.success === true || details?.success === true || details?.state === "complete";
        finish({ status: "completed", text: statusText, success });
      });
    });
    if (signal) {
      if (signal.aborted) {
        finish({ status: "aborted" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
  });
}

const STAGE_SUMMARY = "Stages follow the operator toggles; inspect skipped checks and verdict in the report.";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  const activeRuns = new Set<AbortController>();
  const cancelActiveRuns = () => {
    for (const controller of activeRuns) controller.abort();
    pipelineState.verified = false;
    taskActive = false;
    pendingPrompt = undefined;
  };

  pi.registerCommand("orchestrator", {
    description: "Run orchestration for one task: /orchestrator <prompt>",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /orchestrator <prompt>. Configure roles with /orchestrator-settings.", "info");
        return;
      }
      if (!ctx.isIdle() || taskActive || pendingPrompt || activeRuns.size) {
        ctx.ui.notify("Wait for the current task to finish before starting orchestration.", "error");
        return;
      }
      if (!(await probeBridge(pi))) {
        ctx.ui.notify(MISSING_DEPENDENCY, "error");
        return;
      }
      pendingPrompt = prompt;
      try {
        pi.sendUserMessage(prompt);
      } catch (error) {
        pendingPrompt = undefined;
        throw error;
      }
    },
  });

  pi.registerCommand("orchestrator-settings", {
    description: "Configure orchestrator models, thinking levels and optional stages",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/orchestrator-settings needs TUI mode", "error");
        return;
      }
      await openMenu(pi, ctx);
    },
  });

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description:
      "Run the enforced fixed pipeline for a code change on this machine: research -> implement -> security + QA in parallel -> at most one fix round. One call runs the whole flow and returns the report.",
    promptSnippet: "Run the enforced scout->worker->security+QA pipeline",
    promptGuidelines: [
      "For tasks explicitly submitted with /orchestrator, run code changes through the orchestrate tool; you may not edit files or launch the coder (worker) subagent directly until a pipeline run has completed for this request.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The change to implement, in plain language; the pipeline researches, implements, and verifies it." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (process.env.PI_SUBAGENT_CHILD === "1") {
        return {
          content: [{ type: "text" as const, text: "orchestrate is not available inside a subagent child; only the manager session may run the pipeline." }],
          details: { runId: undefined, ok: false },
          isError: true,
        };
      }

      const cfg = load();
      if (!taskActive || signal?.aborted) return {
        content: [{ type: "text" as const, text: "No active /orchestrator task, or this request was aborted; no workflow started." }],
        details: { ok: false }, isError: true,
      };
      if (activeRuns.size) return {
        content: [{ type: "text" as const, text: "An orchestrator run is already active in this session. Stop it before starting another writer." }],
        details: { ok: false }, isError: true,
      };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      activeRuns.add(controller);
      try {
        const roleAgent = (k: RoleKey) => role(k).agent;
        const args = {
          task: params.task,
          stages: cfg.stages,
          contextAgent: roleAgent("context"),
          contextModel: cfg.roles.context,
          thinkingContext: cfg.thinking.context,
          coderAgent: roleAgent("coder"),
          coderModel: cfg.roles.coder,
          thinkingCoder: cfg.thinking.coder,
          securityAgent: roleAgent("security"),
          securityModel: cfg.roles.security,
          thinkingSecurity: cfg.thinking.security,
          qaAgent: roleAgent("qa"),
          qaModel: cfg.roles.qa,
          thinkingQa: cfg.thinking.qa,
        };

        // The bridge rejects empty string args; absent model/thinking means default.
        const workflowArgs = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== ""));
        const spawn = await rpcRequest(pi, "spawn", { script: buildPipelineScript(), args: workflowArgs, cwd: ctx.cwd }, SPAWN_TIMEOUT_MS);
        if (!spawn.ok) {
          pipelineState.unavailable = true;
          return {
            content: [
              {
                type: "text" as const,
                text: `The pi-subagents spawn request failed, so the orchestrate pipeline cannot start (${spawn.error}). Check that pi-subagents is installed and enabled; file edits are no longer blocked for this session.`,
              },
            ],
            details: { runId: undefined, ok: false },
            isError: true,
          };
        }

        const spawnDetails = (spawn.data?.details ?? {}) as { asyncId?: string; runId?: string };
        const runId = spawnDetails.asyncId || spawnDetails.runId;
        if (!runId) {
          pipelineState.unavailable = true;
          return {
            content: [
              {
                type: "text" as const,
                text: "pi-subagents accepted the pipeline but returned no run id; the orchestrate pipeline cannot be tracked. File edits are no longer blocked for this session.",
              },
            ],
            details: { runId: undefined, ok: false },
            isError: true,
          };
        }

        pipelineState.lastRunId = runId;
        if (!taskActive) controller.abort();
        const completion = await waitForCompletion(pi, runId, controller.signal, PIPELINE_TIMEOUT_MS);

        if (completion.status !== "completed") {
          const stop = await rpcRequest(pi, "stop", { id: runId }, SPAWN_TIMEOUT_MS);
          const why = stop.ok ? "received a stop request" : "could not be stopped: " + stop.error;
          return {
            content: [
              {
                type: "text" as const,
                text: `The orchestrate pipeline ${why} (run id ${runId}). Inspect it with the subagent status action (subagent { action: "status", id: "${runId}" }).`,
              },
            ],
            details: { runId, ok: false },
          };
        }

        let verdict: unknown;
        try { verdict = JSON.parse(completion.text).verdict; } catch { /* Non-JSON completion is not verification evidence. */ }
        const ok = completion.success && (verdict === "clean" || verdict === "completed-with-skips") && !controller.signal.aborted && taskActive;
        if (ok) pipelineState.verified = true; // Acceptance follows operator-selected checks, not a claim of full review.
        return {
          content: [{ type: "text" as const, text: `${completion.text}\n\n${STAGE_SUMMARY}` }],
          details: { runId, ok },
        };
      } finally {
        activeRuns.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
  });

  pi.on("tool_call", (event) => {
    return enforcementDecision(event.toolName, event.input as Record<string, unknown>, pipelineState, { active: taskActive });
  });

  pi.on("session_shutdown", () => cancelActiveRuns());
  pi.on("agent_settled", () => cancelActiveRuns());

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    const requested = pendingPrompt !== undefined && event.prompt === pendingPrompt;
    pendingPrompt = undefined;
    cancelActiveRuns();
    if (!requested) return;
    taskActive = true;
    pipelineState = { verified: false };
    for (const line of guidelines(load())) event.systemPromptOptions.promptGuidelines.push(line);
  });
}
