import React, { useState, useEffect, useRef } from "react";

// ---------------------------------------------------------------------
// Vimes — terminal (TUI) mockup
// Same product as the GUI mockup, rendered as an ncurses/tmux-style app.
// Keys: j/k or ↑/↓ move session cursor · 1/2/3 switch right pane
//       i enter insert mode · Esc back to normal
// ---------------------------------------------------------------------

const C = {
  bg: "#0a0b0d",
  pane: "#0d0e10",
  line: "#22262b",
  dim: "#5a6169",
  fg: "#c8cdd3",
  bright: "#e8ecef",
  accent: "#e0803c", // vimes amber
  green: "#4ec9a0",
  red: "#e06c75",
  blue: "#61afef",
  violet: "#b48ead",
  yellow: "#e5c07b",
};

const sessions = [
  { kind: "repo", label: "acme-web" },
  { kind: "dir", label: "frontend/checkout", depth: 1 },
  { kind: "s", label: "Refactor checkout flow", state: "run", depth: 2, id: "a1f2" },
  { kind: "s", label: "Payment form validation", state: "wait", depth: 2, id: "c3d9" },
  { kind: "dir", label: "frontend/design-system", depth: 1 },
  { kind: "s", label: "Migrate to design tokens", state: "run", depth: 2, id: "77be" },
  { kind: "s", label: "Storybook coverage", state: "idle", depth: 2, id: "0e41" },
  { kind: "dir", label: "backend/auth", depth: 1 },
  { kind: "s", label: "API rate limiting", state: "run", depth: 2, id: "5b20" },
  { kind: "s", label: "OAuth device flow", state: "review", depth: 2, id: "9ac7" },
  { kind: "dir", label: "backend/payments", depth: 1 },
  { kind: "s", label: "Stripe webhooks", state: "run", depth: 2, id: "31da" },
  { kind: "s", label: "Idempotency keys", state: "fail", depth: 2, id: "6f88" },
  { kind: "repo", label: "ml-pipeline" },
  { kind: "s", label: "Hyperparam sweep", state: "run", depth: 1, id: "b4c1" },
  { kind: "s", label: "Data drift report", state: "fail", depth: 1, id: "e2a5" },
  { kind: "repo", label: "infra" },
  { kind: "s", label: "Terraform audit", state: "fail", depth: 1, id: "8d30" },
  { kind: "s", label: "VPC refactor", state: "idle", depth: 1, id: "1caa" },
];

const stateGlyph = {
  run: { g: "●", c: C.accent, t: "run" },
  wait: { g: "◐", c: C.blue, t: "wait" },
  review: { g: "◆", c: C.violet, t: "rev" },
  idle: { g: "○", c: C.dim, t: "idle" },
  fail: { g: "✗", c: C.red, t: "fail" },
};

const extensions = [
  { key: "tasks", label: "tasks", ver: "1.4.0", on: true, note: "backlog→done, promotion gates" },
  { key: "orchestr", label: "orchestrator", ver: "0.9.1", on: true, note: "usage-aware dispatch" },
  { key: "sesshost", label: "session-host", ver: "2.0.3", on: true, note: "sdk/pty, dormant resume" },
  { key: "hooks", label: "hooks", ver: "0.3.0", on: false, note: "event-spine triggers" },
  { key: "docs", label: "docs-standard", ver: "0.1.2", on: false, note: "repo wiki + code maps" },
  { key: "tmuxmode", label: "breakout", ver: "0.5.0", on: false, note: "tmux-style branching" },
];

const files = [
  { n: "docs/", t: "dir" },
  { n: "src/", t: "dir" },
  { n: "CLAUDE.md", t: "f", m: "U" },
  { n: "package.json", t: "f" },
  { n: "README.md", t: "f", m: "M" },
];

// --- ncurses-style pane with an inline title on the top border ---------
function Pane({ title, hint, children, className = "", bodyClass = "" }) {
  return (
    <div
      className={`relative flex flex-col min-h-0 ${className}`}
      style={{ border: `1px solid ${C.line}`, background: C.pane }}
    >
      <div className="absolute -top-[9px] left-3 flex items-center gap-1 px-1" style={{ background: C.pane }}>
        <span style={{ color: C.accent }}>{title}</span>
        {hint && <span style={{ color: C.dim }}>{hint}</span>}
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto pt-3 ${bodyClass}`}>{children}</div>
    </div>
  );
}

export default function VimesTui() {
  const [cursor, setCursor] = useState(2);
  const [pane, setPane] = useState("files");
  const [mode, setMode] = useState("NORMAL");
  const [cmd, setCmd] = useState("");
  const rootRef = useRef(null);

  const selectable = sessions
    .map((s, i) => (s.kind === "s" ? i : -1))
    .filter((i) => i >= 0);

  useEffect(() => {
    const onKey = (e) => {
      if (mode === "INSERT") {
        if (e.key === "Escape") setMode("NORMAL");
        return;
      }
      const pos = selectable.indexOf(cursor);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor(selectable[Math.min(pos + 1, selectable.length - 1)]);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor(selectable[Math.max(pos - 1, 0)]);
      } else if (e.key === "1") setPane("files");
      else if (e.key === "2") setPane("ext");
      else if (e.key === "3") setPane("tasks");
      else if (e.key === "i") {
        e.preventDefault();
        setMode("INSERT");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, mode, selectable]);

  const active = sessions[cursor];

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className="w-full outline-none"
      style={{
        background: "#000",
        padding: "0",
        fontFamily:
          "'SF Mono','JetBrains Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace",
        fontSize: "12.5px",
        lineHeight: "1.55",
      }}
    >
      {/* terminal emulator chrome */}
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ background: "#16181b", borderBottom: `1px solid ${C.line}` }}
      >
        <span className="flex gap-1.5">
          <span className="h-[10px] w-[10px] rounded-full" style={{ background: "#ff5f57" }} />
          <span className="h-[10px] w-[10px] rounded-full" style={{ background: "#febc2e" }} />
          <span className="h-[10px] w-[10px] rounded-full" style={{ background: "#28c840" }} />
        </span>
        <span className="flex-1 text-center" style={{ color: C.dim, fontSize: "11.5px" }}>
          wes@dev — vimes — 198×52
        </span>
      </div>

      {/* app body */}
      <div className="flex flex-col" style={{ background: C.bg, height: "760px" }}>
        {/* header line */}
        <div
          className="flex items-center justify-between px-3 py-1 shrink-0"
          style={{ background: C.accent, color: "#100c07", fontWeight: 600 }}
        >
          <span>VIMES 0.9.4</span>
          <span className="hidden sm:inline">
            acme-web · main · 22 sessions · 4 running · 3 fail
          </span>
          <span>16:36:21</span>
        </div>

        {/* window/tab strip, tmux style */}
        <div
          className="flex items-center gap-0 px-2 py-[3px] shrink-0"
          style={{ borderBottom: `1px solid ${C.line}`, color: C.dim }}
        >
          <span className="px-2" style={{ color: C.bright, background: C.line }}>
            0:checkout*
          </span>
          <span className="px-2">1:payments</span>
          <span className="px-2">2:e2e-flake</span>
          <span className="px-2">3:terraform!</span>
          <span className="ml-auto px-2" style={{ color: C.dim }}>
            [vimes] tunnel↑
          </span>
        </div>

        {/* three panes */}
        <div className="flex-1 min-h-0 flex gap-3 p-3">
          {/* sessions */}
          <Pane title="─ sessions " hint="[s]" className="w-[290px] shrink-0">
            {/* usage window — first class, above the sessions that spend it */}
            <div
              className="px-2 pb-2 mb-1"
              style={{ borderBottom: `1px solid ${C.line}` }}
            >
              <div className="flex justify-between">
                <span style={{ color: C.dim }}>5h window</span>
                <span style={{ color: C.fg }}>3h12m left</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span style={{ color: C.accent }}>
                  {"█".repeat(11)}
                  <span style={{ color: C.line }}>{"░".repeat(9)}</span>
                </span>
                <span style={{ color: C.accent }}>55%</span>
              </div>
              <div className="flex justify-between" style={{ color: C.dim }}>
                <span>4 running · 2 queued</span>
                <span>7d 41%</span>
              </div>
            </div>
            <div className="px-2 pb-2">
              {sessions.map((s, i) => {
                if (s.kind === "repo")
                  return (
                    <div key={i} className="mt-2 mb-0.5 px-1" style={{ color: C.bright }}>
                      ▾ {s.label}
                    </div>
                  );
                if (s.kind === "dir")
                  return (
                    <div key={i} className="px-1" style={{ color: C.dim, paddingLeft: 8 }}>
                      ▾ {s.label}/
                    </div>
                  );
                const st = stateGlyph[s.state];
                const sel = i === cursor;
                return (
                  <div
                    key={i}
                    onClick={() => setCursor(i)}
                    className="flex items-center gap-1.5 px-1 cursor-pointer whitespace-nowrap"
                    style={{
                      paddingLeft: 8 + s.depth * 8,
                      background: sel ? C.line : "transparent",
                      color: sel ? C.bright : C.fg,
                    }}
                  >
                    <span style={{ color: st.c }}>{st.g}</span>
                    <span className="truncate flex-1">{s.label}</span>
                    <span style={{ color: C.dim }}>{s.id}</span>
                  </div>
                );
              })}
            </div>
          </Pane>

          {/* transcript */}
          <Pane
            title={`─ ${active?.label ?? "session"} `}
            hint={`[${active?.id ?? "----"}]`}
            className="flex-1 min-w-0"
          >
            <div className="px-3 pb-3">
              <div style={{ color: C.dim }}>
                claude-code v2.1.202 · opus-4.8 (1M) · effort=xhigh · channel=sdk
                <br />
                cwd ~/vmx/acme-web · window 3h12m left · events 14882
              </div>

              <div className="my-2" style={{ color: C.line }}>
                {"─".repeat(120)}
              </div>

              <div style={{ color: C.fg }}>
                <span style={{ color: C.green }}>❯ </span>
                outline a 5-step plan to refactor the checkout flow for accessibility, one short
                line per step, then a 6-line example diff for step 1.
              </div>

              <div className="mt-3" style={{ color: C.fg }}>
                <span style={{ color: C.accent }}>vmx</span>
                <span style={{ color: C.dim }}> · here's the plan.</span>
              </div>

              <div className="mt-2 space-y-0.5" style={{ color: C.fg }}>
                <div>
                  <span style={{ color: C.dim }}>1. </span>Add explicit{" "}
                  <span style={{ color: C.blue }}>&lt;label&gt;</span> +{" "}
                  <span style={{ color: C.blue }}>id</span> associations and ARIA attributes to
                  every form field.
                </div>
                <div>
                  <span style={{ color: C.dim }}>2. </span>Enforce a logical tab order with
                  visible, high-contrast focus indicators.
                </div>
                <div>
                  <span style={{ color: C.dim }}>3. </span>Wire validation errors to fields via{" "}
                  <span style={{ color: C.blue }}>aria-describedby</span>, announce with{" "}
                  <span style={{ color: C.blue }}>aria-live</span>.
                </div>
                <div>
                  <span style={{ color: C.dim }}>4. </span>Make the step indicator
                  keyboard-operable and expose current step.
                </div>
                <div>
                  <span style={{ color: C.dim }}>5. </span>Audit contrast, add landmarks + a
                  skip-to-main link.
                </div>
              </div>

              <div className="mt-3" style={{ color: C.dim }}>
                diff --git a/src/checkout/EmailField.tsx
              </div>
              <div className="mt-1" style={{ borderLeft: `1px solid ${C.line}` }}>
                {[
                  ["-", `<input type="email" name="email" placeholder="Email" />`],
                  ["+", `<label htmlFor="email">Email address</label>`],
                  ["+", `<input id="email" type="email" name="email"`],
                  ["+", `       autoComplete="email"`],
                  ["+", `       aria-required="true"`],
                  ["+", `       aria-describedby="email-error" />`],
                ].map(([sign, text], i) => (
                  <div
                    key={i}
                    className="pl-2 whitespace-pre overflow-x-auto"
                    style={{
                      color: sign === "+" ? C.green : C.red,
                      background: sign === "+" ? "rgba(78,201,160,0.06)" : "rgba(224,108,117,0.06)",
                    }}
                  >
                    {sign} {text}
                  </div>
                ))}
              </div>

              <div className="mt-3" style={{ color: C.fg }}>
                Apply step 1 to the real checkout components? Point me at the directory or I'll
                locate it.
              </div>

              <div className="mt-2" style={{ color: C.dim }}>
                ⏱ 20s · 8.2k in / 1.1k out · promote with{" "}
                <span style={{ color: C.accent }}>:promote review</span>
              </div>
            </div>
          </Pane>

          {/* context pane — switchable */}
          <Pane
            title={`─ ${pane === "files" ? "files" : pane === "ext" ? "extensions" : "tasks"} `}
            hint="[1/2/3]"
            className="w-[280px] shrink-0"
          >
            <div className="px-2 pb-2">
              {pane === "files" &&
                files.map((f) => (
                  <div key={f.n} className="flex px-1" style={{ color: f.t === "dir" ? C.blue : C.fg }}>
                    <span className="flex-1">
                      {f.t === "dir" ? "▸ " : "  "}
                      {f.n}
                    </span>
                    {f.m && (
                      <span style={{ color: f.m === "M" ? C.violet : C.accent }}>{f.m}</span>
                    )}
                  </div>
                ))}

              {pane === "ext" && (
                <div>
                  {extensions.map((e) => (
                    <div key={e.key} className="px-1 mb-1.5">
                      <div className="flex items-baseline gap-1">
                        <span style={{ color: e.on ? C.green : C.dim }}>
                          [{e.on ? "x" : " "}]
                        </span>
                        <span style={{ color: e.on ? C.bright : C.fg }}>{e.label}</span>
                        <span style={{ color: C.dim, fontSize: "11px" }}>{e.ver}</span>
                      </div>
                      <div className="pl-5" style={{ color: C.dim, fontSize: "11px" }}>
                        {e.note}
                      </div>
                    </div>
                  ))}
                  <div className="mt-2 px-1" style={{ color: C.dim }}>
                    {"─".repeat(30)}
                    <div>
                      <span style={{ color: C.accent }}>:ext install</span> &lt;name&gt;
                    </div>
                    <div>
                      <span style={{ color: C.accent }}>:ext search</span> registry
                    </div>
                  </div>
                </div>
              )}

              {pane === "tasks" && (
                <div className="px-1 space-y-1">
                  {[
                    ["backlog", 6, C.dim],
                    ["in progress", 3, C.accent],
                    ["review", 2, C.violet],
                    ["done", 41, C.green],
                  ].map(([label, n, col]) => (
                    <div key={label} className="flex justify-between" style={{ color: col }}>
                      <span>{label}</span>
                      <span>{n}</span>
                    </div>
                  ))}
                  <div className="pt-2" style={{ color: C.line }}>
                    {"─".repeat(30)}
                  </div>
                  <div style={{ color: C.fg }}>25f9c558 checkout a11y</div>
                  <div style={{ color: C.dim }}>↳ plan ✓ · implement ✓ · review ◐</div>
                </div>
              )}
            </div>
          </Pane>
        </div>

        {/* prompt line */}
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-1.5"
          style={{ borderTop: `1px solid ${C.line}` }}
        >
          <span style={{ color: mode === "INSERT" ? C.green : C.accent }}>
            {mode === "INSERT" ? "❯" : ":"}
          </span>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onFocus={() => setMode("INSERT")}
            placeholder={mode === "INSERT" ? "message vmx…" : "press i to type, : for command"}
            className="flex-1 bg-transparent outline-none"
            style={{ color: C.fg, fontFamily: "inherit", fontSize: "inherit" }}
          />
          <span
            className="inline-block w-[7px] h-[15px]"
            style={{ background: mode === "INSERT" ? C.green : C.dim }}
          />
        </div>

        {/* status line */}
        <div className="shrink-0 flex items-stretch text-[11.5px]" style={{ background: C.pane }}>
          <span
            className="px-2 py-[3px] font-semibold"
            style={{
              background: mode === "INSERT" ? C.green : C.accent,
              color: "#0b0c0e",
            }}
          >
            {mode}
          </span>
          <span className="px-2 py-[3px]" style={{ background: C.line, color: C.fg }}>
             main
          </span>
          <span className="px-2 py-[3px] flex-1" style={{ color: C.dim }}>
            perms:ask · notify:on · bypass off · spine:sqlite ok
          </span>
          <span className="px-2 py-[3px]" style={{ color: C.dim }}>
            bg 1/16 · {selectable.indexOf(cursor) + 1}/{selectable.length}
          </span>
        </div>

        {/* keybind hint line */}
        <div
          className="shrink-0 px-3 py-[3px] text-[11px] flex gap-4 flex-wrap"
          style={{ background: "#111214", color: C.dim, borderTop: `1px solid ${C.line}` }}
        >
          {[
            ["j/k", "move"],
            ["↵", "attach"],
            ["1/2/3", "pane"],
            ["i", "insert"],
            ["^b", "prefix"],
            [":", "command"],
            ["?", "help"],
          ].map(([k, v]) => (
            <span key={k}>
              <span style={{ color: C.accent }}>{k}</span> {v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
