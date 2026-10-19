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
  enabled: boolean;
  roles: Record<RoleKey, string>;
  thinking: Record<RoleKey, string>;
}

const ROLES: { key: RoleKey; label: string; agent: string; hint: string }[] = [
  { key: "context", label: "Context engine", agent: "researcher", hint: "stage 1: gather files, facts, constraints" },
  { key: "coder", label: "Lead coder", agent: "worker", hint: "stage 2: implement from the context" },
  { key: "security", label: "Security specialist", agent: "reviewer", hint: "stage 3: audit the diff for security holes" },
  { key: "qa", label: "QA", agent: "reviewer", hint: "stage 3: test and validate the diff" },
];

const DEFAULTS: Config = {
  enabled: false,
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
let pipelineState: { verified: boolean; lastRunId?: string; unavailable?: boolean; direct?: boolean } = { verified: false };
let modeEnabled = false;
let directNextTurn = false;

// Memoized positive "can we talk to pi-subagents?" answer. Undefined until a probe succeeds.
// A negative answer is never memoized: a slow boot or a momentary delay must not
// pin the bridge as MISSING for the rest of the pi process.
let bridgeOk: boolean | undefined;
const PROBE_TIMEOUT_MS = 3_000;

export const MISSING_DEPENDENCY =
  "orchestrator: pi-subagents is not installed or not enabled. Run `pi install npm:pi-subagents`, then restart pi. Orchestrator mode cannot be enabled without it.";

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

/**
 * Probe the bridge with retries before concluding it is absent, so a slow
 * session start is not mistaken for a missing dependency. Probes immediately,
 * then +1s and +3s; returns false on the first success and true only when all
 * three probes miss.
 */
async function bridgeConfirmedMissing(pi: ExtensionAPI): Promise<boolean> {
  for (const waitMs of [0, 1_000, 3_000]) {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (await probeBridge(pi)) return false;
  }
  return true;
}

function load(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { enabled: !!raw.enabled, roles: { ...DEFAULTS.roles, ...raw.roles }, thinking: normalizeThinking(raw.thinking) };
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
  // load() fall back to DEFAULTS (enabled: false) and clobber the operator's toggle.
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmpPath, CONFIG_PATH);
  modeEnabled = cfg.enabled;
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
const ENABLED_ID = "enabled";
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
function menuOnce(pi: ExtensionAPI, ctx: ExtensionCommandContext, unavailable: boolean): Promise<string | undefined> {
  const cfg = load();
  const manager = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default";

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const value = (key: RoleKey) => cfg.roles[key] || "belum dipilih";
    const items: SettingItem[] = [
      {
        id: ENABLED_ID,
        label: "Enable orchestrator",
        currentValue: cfg.enabled ? "ON" : "OFF",
        // Without pi-subagents there is nothing to enable, so the row refuses to move.
        values: unavailable ? ["OFF"] : ["ON", "OFF"],
        description: unavailable ? MISSING_DEPENDENCY : undefined,
      },
      // a one-element `values` array makes Enter fire onChange without moving focus
      { id: MANAGER_ID, label: "Manager model", currentValue: manager, values: [manager] },
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
        if (id === ENABLED_ID) {
          if (newValue === "ON" && unavailable) {
            ctx.ui.notify(MISSING_DEPENDENCY, "error");
            return;
          }
          const updated = updateConfig((c) => {
            c.enabled = newValue === "ON";
          });
          ctx.ui.notify(`Orchestrator mode: ${updated.enabled ? "ON" : "OFF"}`, "info");
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
    list.selectItem(ENABLED_ID);

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
    const row = await menuOnce(pi, ctx, missing);
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
  const model = (k: RoleKey) => cfg.roles[k] || "default";
  const level = (k: RoleKey) => cfg.thinking[k] || "default";
  return [
    "Orchestrator mode is ON (the operator asked for delegation). You are the MANAGER: keep routing, integration, decisions, and final acceptance in this main session.",
    "For any request that changes code, call the orchestrate tool with the task; it runs the fixed pipeline and returns the report.",
    `1. CONTEXT — the pipeline's agent "${role("context").agent}" (model ${model("context")}, thinking ${level("context")}) gathers the files, facts, and constraints.`,
    `2. IMPLEMENT — the pipeline's agent "${role("coder").agent}" (model ${model("coder")}, thinking ${level("coder")}) implements from that context. One writer at a time.`,
    `3. AUDIT + TEST — after the worker reports done the pipeline runs BOTH in parallel: agent "${role("security").agent}" (model ${model("security")}, thinking ${level("security")}) audits the diff, and agent "${role("qa").agent}" (model ${model("qa")}, thinking ${level("qa")}) tests and validates it.`,
    "4. You synthesize the returned report, apply at most small final adjustments yourself, then give the final answer.",
    "While orchestrator mode is ON you may NOT edit files or launch the coder subagent directly (those tool calls are blocked) until a pipeline run has completed for this request.",
    "Read-only questions stop after stage 1. Read-only single-step tasks stay on the main session. Small low-risk edits require the operator to arm /orchestrator direct for one turn; do not self-classify edits to bypass the gate.",
    "If you keep a code-change request on yourself instead of running the flow, say why in one line.",
  ];
}

/**
 * Pure enforcement predicate (no I/O, total). Returns a block directive when
 * the parent tries to bypass the pipeline, otherwise undefined.
 */
export function enforcementDecision(
  toolName: string,
  input: Record<string, unknown>,
  state: { verified: boolean; unavailable?: boolean; direct?: boolean },
  cfg: Pick<Config, "enabled">,
): { block: true; reason: string } | undefined {
  if (!cfg.enabled) return undefined;
  if (process.env.PI_SUBAGENT_CHILD === "1") return undefined;
  if (state.unavailable) return undefined; // fail open: a broken pi-subagents install must not wedge the session
  if (state.verified || state.direct) return undefined;
  if (toolName === "edit" || toolName === "write") {
    return {
      block: true,
      reason:
        "Orchestrator mode is ON: the manager must not write code itself. Call the orchestrate tool and let the coder stage implement, then apply only final adjustments after the pipeline reports done.",
    };
  }
  const agent = input && typeof (input as { agent?: unknown }).agent === "string" ? ((input as { agent: string }).agent).trim().toLowerCase() : undefined;
  if (toolName === "subagent" && agent === role("coder").agent.trim().toLowerCase()) {
    return {
      block: true,
      reason: "Orchestrator mode is ON: launch the coder only through the orchestrate pipeline, not by calling the subagent tool directly.",
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
  required: ["verdict", "findings"],
  additionalProperties: false
};
const task = args.task;
const research = await runs.run("research", child(
  args.contextAgent,
  "Gather the files, facts, and constraints needed to change this codebase safely." + NL + NL + "TASK:" + NL + task + NL + NL + "Report every relevant file path (with line numbers where useful), the constraints, and a concrete implementation brief for the coder. Do NOT edit any files.",
  args.contextModel,
  args.thinkingContext
));
if (research.ok !== true) return { verdict: "unverified", failedStage: "research", error: research.error || research.output || "no result", partialChanges: false };
const implementation = await runs.run("implement", child(
  args.coderAgent,
  "Make the requested change in the current working directory." + NL + NL + "TASK:" + NL + task + NL + NL + "RESEARCH (from the context stage):" + NL + research.output + NL + NL + "Edit the files yourself, run the focused tests, and report exactly which files changed and the test results.",
  args.coderModel,
  args.thinkingCoder
));
if (implementation.ok !== true) return { verdict: "unverified", failedStage: "implement", error: implementation.error || implementation.output || "no result", partialChanges: true };
const reviewBrief = "TASK:" + NL + task + NL + NL + "RESEARCH SUMMARY:" + NL + research.output + NL + NL + "IMPLEMENTATION REPORT (coder):" + NL + implementation.output;
const review = await runs.all([
  withKey("security", child(
    args.securityAgent,
    reviewBrief + NL + NL + "Audit the changes just made for security defects (injection, authorization, secrets, unsafe input handling, data exposure). Cite exact file:line for each finding. Set the verdict to blocked when any defect must be fixed before shipping, otherwise clean.",
    args.securityModel,
    args.thinkingSecurity,
    REVIEW_SCHEMA
  )),
  withKey("qa", child(
    args.qaAgent,
    reviewBrief + NL + NL + "Independently verify the change works: run the relevant tests and commands and report pass/fail evidence with exact commands and output, plus any regressions. Set the verdict to blocked when the change is unverified or broken, otherwise clean.",
    args.qaModel,
    args.thinkingQa,
    REVIEW_SCHEMA
  ))
]);
const security = review[0];
const qa = review[1];
const securityVerdict = security && security.structuredOutput ? security.structuredOutput.verdict : undefined;
const qaVerdict = qa && qa.structuredOutput ? qa.structuredOutput.verdict : undefined;
// A failed or silent reviewer is NOT a clean reviewer: it must land in the blocked path.
const securityClean = security && security.ok === true && securityVerdict === "clean";
const qaClean = qa && qa.ok === true && qaVerdict === "clean";
const stageFailure = (name, r) => r && r.ok === true ? null : name + " stage failed: " + ((r && (r.error || r.output)) || "no result");
const upstream = [stageFailure("research", research), stageFailure("implement", implementation)].filter(Boolean);
const blocked = upstream.length > 0 || !securityClean || !qaClean;
let fix = null;
if (blocked) {
  const findings = upstream.concat(
    [].concat(
      security && security.structuredOutput && security.structuredOutput.findings ? security.structuredOutput.findings : [],
      qa && qa.structuredOutput && qa.structuredOutput.findings ? qa.structuredOutput.findings : []
    ),
    [securityVerdict === undefined ? "security reviewer returned no verdict" : null, qaVerdict === undefined ? "qa reviewer returned no verdict" : null].filter(Boolean)
  );
  fix = await runs.run("fix", child(
    args.coderAgent,
    "Fix the blockers below in the current working directory, then re-run the focused tests." + NL + NL + "TASK:" + NL + task + NL + NL + "BLOCKERS (verbatim):" + NL + findings.join(NL) + NL + NL + "Report exactly which files changed and the test results.",
    args.coderModel,
    args.thinkingCoder
  ));
}
return {
  research: { artifacts: research.artifactPaths || [], outputReference: research.outputReference || null },
  implementation: { artifacts: implementation.artifactPaths || [], outputReference: implementation.outputReference || null },
  security: security.structuredOutput ? security.structuredOutput : security.output,
  qa: qa.structuredOutput ? qa.structuredOutput : qa.output,
  fix: fix ? fix.output : null,
  // "clean" only when both reviewers really returned clean and both upstream stages succeeded.
  verdict: fix ? (fix.ok === true ? "fixed" : "unverified") : (blocked ? (securityVerdict === undefined || qaVerdict === undefined || upstream.length > 0 ? "unverified" : "blocked") : "clean")
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

const STAGE_SUMMARY = "Stages: research -> implement -> security+QA (parallel) -> at most one fix round.";

export default function (pi: ExtensionAPI) {
  modeEnabled = load().enabled;

  pi.registerCommand("orchestrator", {
    description: "pi-subagents orchestrator: toggle on/off, pick a model and thinking level per role",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "direct") {
        directNextTurn = true;
        ctx.ui.notify("Direct editing armed for the next user turn only. Use for small, low-risk changes; auth, data, migrations and complex changes still need the pipeline.", "info");
        return;
      }
      if (arg === "on" || arg === "off") {
        if (arg === "on" && !(await probeBridge(pi))) {
          updateConfig((c) => {
            c.enabled = false;
          });
          ctx.ui.notify(MISSING_DEPENDENCY, "error");
          return;
        }
        const updated = updateConfig((c) => {
          c.enabled = arg === "on";
        });
        ctx.ui.notify(`Orchestrator mode: ${updated.enabled ? "ON" : "OFF"}`, "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/orchestrator needs TUI mode", "error");
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
    promptSnippet: "Run the enforced researcher->worker->security+QA pipeline",
    promptGuidelines: [
      "When orchestrator mode is ON, run code changes through the orchestrate tool; you may not edit files or launch the coder (worker) subagent directly until a pipeline run has completed for this request.",
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
      const roleAgent = (k: RoleKey) => role(k).agent;
      const args = {
        task: params.task,
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

      const spawn = await rpcRequest(pi, "spawn", { script: buildPipelineScript(), args, cwd: ctx.cwd }, SPAWN_TIMEOUT_MS);
      if (!spawn.ok) {
        pipelineState.unavailable = true;
        return {
          content: [
            {
              type: "text" as const,
              text: `The pi-subagents RPC bridge is unavailable, so the orchestrate pipeline cannot start (${spawn.error}). Check that pi-subagents is installed and enabled; file edits are no longer blocked for this session.`,
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
      const completion = await waitForCompletion(pi, runId, signal, PIPELINE_TIMEOUT_MS);

      if (completion.status !== "completed") {
        const why = completion.status === "aborted" ? "was aborted" : "is still running";
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

      const ok = completion.success;
      if (ok) pipelineState.verified = true;
      return {
        content: [{ type: "text" as const, text: `${completion.text}\n\n${STAGE_SUMMARY}` }],
        details: { runId, ok },
      };
    },
  });

  pi.on("tool_call", (event) => {
    return enforcementDecision(event.toolName, event.input as Record<string, unknown>, pipelineState, { enabled: modeEnabled });
  });

  // Warn once at startup when the pipeline dependency is missing. Deferred so
  // the probe never blocks pi's boot; it resolves on the next tick.
  pi.on("session_start", (_event, ctx) => {
    setTimeout(() => {
      void bridgeConfirmedMissing(pi).then((missing) => {
        if (missing) {
          ctx.ui.notify(MISSING_DEPENDENCY, "error");
          updateConfig((c) => {
            c.enabled = false;
          });
        }
      });
    }, 0);
  });

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    // subagent children load extensions too; never push orchestration rules into a child
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    const cfg = load();
    modeEnabled = cfg.enabled;
    pipelineState.verified = false;
    const direct = directNextTurn;
    directNextTurn = false;
    pipelineState.direct = false;
    pipelineState.lastRunId = undefined;
    if (!cfg.enabled) return;
    if (direct) {
      pipelineState.direct = true;
      event.systemPromptOptions.promptGuidelines.push("The operator explicitly armed /orchestrator direct for this turn. Handle only a small low-risk change directly; for auth, data, migrations or complex changes call orchestrate instead. State why the direct path is appropriate.");
      return;
    }
    for (const line of guidelines(cfg)) event.systemPromptOptions.promptGuidelines.push(line);
  });
}
