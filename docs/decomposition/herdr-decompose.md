# Decomposition: herdrdev/herdr → Vimes
**Date:** 2026-07-29 · **Target project:** Vimes (agent-first remote IDE for Claude Code) · **Repo analyzed:** https://github.com/herdrdev/herdr (Apache-2.0, Rust, Homebrew/mise/Nix, ~19 agents, plugin marketplace, sponsor-funded full-time)

**Purpose:** prior-art pattern extraction through the Vimes lens. Patterns are ideas to adapt, never code to copy. References to D-records, slices, invariants, rules, and pillars point at the canonical Vimes docs in this repo. Seventh in the series (jinn, agent-teams-ai, codor, agenc-core, agentswarms, agent-of-empires, this); cross-corroborations flagged. Nothing here self-applies.

> **Read this one for the plugin architecture first.** Herdr has a *shipped, documented, marketplace-backed* plugin system whose stated design goal is the same one Vimes just adopted: "plugins exist so Herdr can stay lean… the core stays focused… plugins turn that existing extension surface into reusable workflows." It is the closest thing to a working reference for the Vimes-as-engine vision, and §2.1 is the centre of gravity of this document.

---

## 1. Landscape

Herdr is an agent multiplexer that lives in the terminal: a single Rust binary, tmux-style prefix keys *and* first-class mouse, panes/tabs/workspaces, agents detected and state-labelled inside panes (blocked / working / idle), detach-and-reattach with sessions surviving restarts, worktree integration, a socket API + full CLI that **agents themselves can drive**, and a plugin system with a public marketplace. Explicitly positions its views as "real terminal views, not a wrapped interpretation."

**Why it matters to Vimes:** three things, in descending order. (1) It is the best available reference for the engine-plus-plugins architecture Vimes just committed to, including the parts that are easy to get wrong (trust, versioning, state isolation, what the plugin API actually *is*). (2) Its agent-state detection is screen-scraping — the exact approach Vimes forbids under rule 0.8 — but done so well, and so honestly, that it constitutes the best available evidence *for* Vimes's rule while also offering a data-driven pattern worth stealing for a narrow case. (3) Its socket-API-plus-skill design is a working instance of "the agent operates the platform," which is Vimes's slice-7 MCP surface reached from the CLI direction.

## 2. Patterns worth lifting

### 2.1 The plugin architecture — a working reference for Vimes-as-engine
**Where:** `docs/preview/website/src/content/docs/plugins.mdx`, `src/app/api/plugins/{manifest,runtime,context,env,panes}.rs`, `src/plugin_command.rs`, `src/plugin_paths.rs`.

The whole design in one line: **"A plugin is not an SDK integration. It is a directory with a `herdr-plugin.toml` manifest and commands Herdr can launch."** Herdr owns the host surface (installation, manifest validation, keybindings, panes, events, invocation context, socket access); the plugin owns its implementation language, dependencies, files, and durable state. Seven design decisions worth transplanting:

1. **The existing API *is* the plugin API.** "There is no separate plugin SDK or restricted command set. The entire Herdr CLI is the plugin API." Plugins call back through `HERDR_BIN_PATH` (portable across Unix sockets and Windows named pipes) or raw socket JSON. **Vimes equivalent: the daemon's HTTP/WS + MCP surface is the plugin API** — no second interface to design, version, or keep in sync, and it means dogfooding the public API is automatic because the first-party modules use it too.
2. **Manifest-declared, not runtime-registered.** Actions, event hooks, panes, and link handlers are all declared in the manifest; runtime action registration is explicitly *not* in v1. This is the discipline that keeps the host's model of the world static and inspectable — you can validate, list, and reason about what a plugin can do without running it. Strongly aligned with Vimes's determinism posture.
3. **Language-agnostic by argv.** Bash, JS, Lua, a Rust binary — anything the machine can run. For Vimes this decouples the plugin ecosystem from the Node/TS daemon and means a plugin never links against daemon internals.
4. **`min_herdr_version` in the manifest; the host refuses to install a plugin that needs a newer host.** Cheap, and it makes the compatibility failure a clear message rather than a mysterious runtime break. Same family as the version-lockfile discipline (4th appearance in the series).
5. **Per-plugin config and state directories.** Isolation by construction — which is exactly the "modules cannot see each other's private state" rule Vimes just articulated, made concrete on disk.
6. **Extension point taxonomy worth copying nearly verbatim**: `[[build]]` (setup), `[[startup]]` (long-running), `[[actions]]` (invocable, with `contexts = ["workspace"|…]` scoping *where* an action is offered), `[[events]]` (subscribe to host events like `worktree.created`), `[[panes]]` (contributed UI surfaces with placement), `[[link_handlers]]` (regex → action routing). Map onto Vimes: actions scoped to `["task"|"session"|"board"|"project"]`, events subscribing to the **spine** (the fit is exact — the spine is already an event bus), panes as contributed board/session views, and link handlers for turning a URL into a work-order.
7. **Trust is stated, not solved.** The docs are refreshingly plain: a plugin is ordinary code running as your user with your environment and the full CLI; Herdr validates the manifest and isolates state but *does not sandbox*. Install preview shows the source and the commands before confirming; `--yes` and `--ref` pinning for trusted sources. **For Vimes this is a real decision, not a footnote** — a Vimes plugin would run on a box that has the daemon's credentials, the Access-authenticated surface, and every project. The honest options are the same three: state the trust model plainly, show a preview before install, and (later, if ever) sandbox. Worth a decision record before the first third-party plugin exists rather than after.

### 2.2 Data-driven detection manifests — the right shape for the wrong problem
**Where:** `src/detect/manifests/*.toml` (19 agents), `src/detect/manifest.rs`, `manifest_update.rs`.

Per-agent TOML manifests declare prioritised rules over terminal output regions:

```toml
id = "claude"; version = "2026.08.04.1"; min_engine_version = 2
[[rules]]
id = "osc_title_working"; state = "working"; priority = 1100
region = "osc_title"; visible_working = true
regex = ['^[\x{2800}-\x{28FF}] ']          # braille spinner glyphs
[[rules]]
id = "transcript_viewer"; state = "unknown"; priority = 1000
region = "bottom_non_empty_lines(3)"; skip_state_update = true
contains = ["showing detailed transcript"]  # don't misread a viewer as activity
```

Regions (`osc_title`, `osc_progress`, `whole_recent`, `after_last_horizontal_rule`, `bottom_non_empty_lines(n)`), priorities, `any`/`contains`/`regex`/`line_regex` composition, `skip_state_update` for "this screen means nothing, don't update", plus a `DetectionExplain` struct that reports *which rule matched and why* — and dated manifest versions with an update mechanism, because these break constantly (the claude manifest is dated 2026-08-04).

**Two opposite conclusions, both worth recording:**
- **Against adoption (the main one):** this is rule 0.8's justification in concrete form. Nineteen manifests, a rule engine, region grammar, priority arbitration, an explain-debugger, and a *versioned update channel* — all to approximate what Vimes gets exactly and for free from hooks, the SDK stream, and the JSONL tail. The `transcript_viewer` rule (a user scrolling their transcript must not be read as activity) is the kind of false positive that only exists because the screen is being read. **This is the strongest evidence in the series for the never-parse-the-screen rule** — an excellent team spending real engineering to be approximately right about something Vimes knows exactly.
- **For adoption (narrow):** the *shape* — dated, versioned, data-driven rule files with an update channel and an explain mode — is exactly right for any place Vimes must interpret an external surface it doesn't control. Vimes has one such place today (parsing/classifying transcript and hook payload shapes across CLI versions) and will have more if ACP or other providers arrive. Golden fixtures already cover this; a *dated, data-driven* classifier with an explain output is the upgrade path if version drift ever gets hairy.

### 2.3 The socket API + agent skill — platform control as a first-class agent capability
**Where:** `skills/herdr/SKILL.md`, `src/app/api/*` (agents, panes, tabs, workspaces, worktrees, layouts, session, integrations), `HERDR_ENV=1`.

Agents inside Herdr panes can drive Herdr: spawn panes, read output, wait on each other. The skill file is a small masterclass in scoping an agent capability:
- **Environment-gated**: the agent must verify `HERDR_ENV=1` and *stop* if the check fails — "do not inspect or control the focused Herdr session from outside Herdr." Capability is bound to being *inside* the platform.
- **Narrow triggering**, stated as a negative: use only when the user explicitly mentions Herdr — "do not use merely because a task could benefit from a background terminal, delegation, or parallel work."
- **The binary is the authority**: the skill tells the agent to run `herdr --help` and the command-group help rather than embedding a command reference that will rot. Documentation that can't go stale because it defers to the live surface.

**Vimes adaptation:** all three transfer directly to the slice-7 MCP surface. Bind capability to context (a worker's tools are scoped to *its* task/attempt — already the per-role token plan, now with an env-gate precedent); write the tool descriptions with explicit negative triggers; and prefer *pointer* documentation (a `describe` tool, or tool descriptions that defer to the live schema) over prose that drifts from the API. The third one interacts nicely with the briefing-as-tool decision: fresh context beats baked context for the same reason.

### 2.4 `min_engine_version` on data files
**Where:** manifest headers — `min_engine_version = 2` alongside a dated `version`.

The rule *files* declare which engine they need, independently of the app's own version. For Vimes: golden fixtures, work-order schemas, and (later) plugin manifests should carry their own compatibility floor, so an old fixture set against a new core fails with "this fixture predates engine v2" instead of an inscrutable mismatch. Trivial, and it pays the first time a fixture refresh lags a schema change.

### 2.5 Keyboard *and* mouse, both first-class
**Where:** README positioning — "tmux-style prefix keys *and* click, drag, split. pick per moment, not per tool."

A small but real UX principle for the plugin-modes vision: the tmux-style mode Vimes plans shouldn't force keyboard-only interaction any more than the board should force mouse-only. Vimes's mobile-first surface is inherently touch, and its desktop surface should not therefore be mouse-only — keyboard-driven navigation of the board and session list is the kind of thing that quietly decides whether a power user adopts the tool. Cheap to honour early, expensive to retrofit into a component library that assumed pointer events.

## 3. Patterns to skip (with reasons)

- **Terminal-native rendering as the primary surface.** Herdr's thesis is real terminal views in a real terminal; Vimes's is structured views in a browser with a PTY escape hatch. Settled on both sides, and the divergence is the whole reason Vimes can render acceptance criteria and verdicts at all.
- **Screen-scraped state detection.** See §2.2 — deliberately declined, with this repo as the evidence.
- **The multiplexer product surface** (panes/tabs/layouts/splits, prefix-key bindings, Ghostty/Kitty graphics protocols, popup sizing). Eighth corroboration that multi-agent breadth is a different product; Vimes's session list is the analogue and doesn't need panes.
- **Nineteen-agent manifest maintenance.** Same bill, eighth appearance. Vimes's answer stays: one adapter done honestly, ACP evaluated as the seam (per the AoE decomposition).
- **Distribution surface** (Homebrew/mise/Nix/Windows installer, install.sh, marketplace website, sponsorship tiers). Monetization-era concerns; noted in §5 that the *marketplace* specifically is a strategic pattern worth remembering.

## 4. Feature gap analysis

| Feature | In Herdr as | Vimes priority | Notes |
|---|---|---|---|
| Manifest-declared plugin contract (actions/events/panes/link-handlers, contexts, build/startup) | `herdr-plugin.toml` | **High (design)** | The reference shape for Vimes-as-engine |
| "The existing API *is* the plugin API" | CLI/socket as plugin surface | **High (rule)** | No second interface; first-party modules dogfood it |
| Per-plugin config/state isolation | plugin paths | **High** | Makes "modules can't see each other's state" concrete |
| `min_*_version` compatibility floors (app *and* data files) | manifest headers | Medium | Extends to fixtures and work-order schemas |
| Plugin trust model stated + install preview + `--ref` pinning | plugins doc | Medium | Needs a Vimes decision record before third-party plugins |
| Env-gated, negatively-triggered agent capability | `skills/herdr/SKILL.md` | Medium | Directly shapes slice-7 MCP tool descriptions |
| "Binary is the authority" doc pattern | skill file | Medium | Pointer docs over rotting command references |
| Explain-mode for any classifier | `DetectionExplain` | Low | Only where Vimes must classify untrusted external shapes |
| Keyboard + mouse both first-class | README principle | Low | Cheap now, expensive to retrofit |

## 5. Open questions

1. **Where is the Vimes plugin boundary drawn — API-level or module-level?** Herdr's plugins are *external processes* calling back through the CLI. Vimes's first "plugins" (task machine, orchestration, game layer) are in-process TypeScript modules over the spine. Those are different things wearing one word, and the fork matters: external-process plugins get language freedom and crash isolation but can only use the public API; in-process modules get direct spine access and cheap composition but can break the daemon. Likely answer is *both tiers* — in-process modules for first-party workflow layers, external argv plugins for third-party extensions — but that should be a deliberate decision record, because the API surface a third-party plugin needs is a superset of what a first-party module needs, and discovering that later means retrofitting.
2. **Does the plugin trust model change the auth posture?** Finding A established that the daemon is a remote shell behind Access. A third-party plugin runs *inside* that trust boundary with the daemon's credentials. Herdr's answer (state it plainly, preview before install, don't sandbox) is defensible for a local multiplexer; Vimes's daemon holds Access-authenticated reach to every project and the orchestration credit. Decide before, not after.
3. **Marketplace as a strategic asset.** Herdr ships a public plugin marketplace and is sponsor-funded full-time. If Vimes's differentiator is the verification loop, then *work-order templates, acceptance-criteria libraries, and review rubrics* are the natural marketplace goods — shareable, valuable, and inherently tied to Vimes's unique layer rather than to session management. Worth remembering when the monetization question stops being hypothetical.

## 6. Action items (carry-over list for the build workflow)

| # | Item | Effort | Lands in |
|---|---|---|---|
| 1 | Draft the Vimes plugin manifest shape modelled on `herdr-plugin.toml`: id/name/version/`min_vimes_version`, `[[build]]`/`[[startup]]`/`[[actions]]` (with `contexts`)/`[[events]]` (spine subscriptions)/`[[panes]]`/`[[link_handlers]]` | moderate (design) | engine/plugin epic |
| 2 | Rule: the daemon's public API (HTTP/WS + MCP) *is* the plugin API — no separate SDK, first-party modules use the same surface | trivial (rule) | engine design |
| 3 | Decide the two-tier boundary: in-process modules vs external argv plugins, and which API each gets (§5 Q1) | low (decision) | engine epic |
| 4 | Per-plugin config/state directories; no cross-plugin state access | low | engine epic |
| 5 | Plugin trust decision record: preview-before-install, ref pinning, stated non-sandboxing — evaluated against the Access-authenticated daemon (§5 Q2) | low (decision) | before 3rd-party plugins |
| 6 | Add compatibility floors to data artifacts (golden fixtures, work-order schema, plugin manifests): `min_engine_version`-style headers | trivial | schema notes |
| 7 | Apply the skill-file discipline to slice-7 MCP tools: context-gated capability, explicit negative triggers, defer to live schema over prose | low | slice 7 |
| 8 | Keyboard-first navigation for board/session list alongside pointer/touch | low | UI doctrine doc |

---
*End of decomposition. Cross-corroborations across the seven-repo series: version/compatibility pinning (4th, now extended to data files); multi-provider/multi-agent breadth cost (8th); agent-drives-the-platform surface (3rd — jinn MCP, ATA MCP, herdr socket+skill); per-unit state isolation (2nd, codor). New here: a shipped manifest-based plugin contract with a marketplace, "the existing API is the plugin API," data-driven versioned detection manifests with explain mode, and env-gated agent capability scoping. Notably absent here and present in Vimes: the eighth consecutive project with no work-order, no acceptance criteria, and no verdict — Herdr's own README frames its horizon as "the path to a real agent runtime," which is the layer Vimes already built.*
