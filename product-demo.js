import { initialDemo, advanceDemo } from "./product-model.js";
const root = document.querySelector("[data-product-demo]");
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const waves = `<span class="wave" aria-hidden="true">${[5, 9, 14, 8, 4, 11, 7, 14, 5, 8, 12, 4].map((n, i) => `<i style="--h:${n}px;--d:${i * 0.07}s"></i>`).join("")}</span>`;
const samples = {
  dictation:
    "The new direction feels right. Let’s give the typography more room and keep the interactions simple.",
  scratchpad:
    "Update the landing page. Use the attached reference for the spacing. Keep the original logo.",
  meetings: "Design review",
  memory: "What did we decide about the landing page?",
};
if (root) {
  let state = initialDemo(root.dataset.mode || "remote"),
    timer,
    terminal = false,
    format = false,
    replyDraft = "",
    provider = "Claude Code";
  const live = document.createElement("p");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  root.append(live);
  const desktop = root.querySelector(".desktop"),
    surface = root.querySelector("[data-notch]"),
    content = root.querySelector("[data-window]"),
    caption = root.querySelector("[data-caption]");
  function notchBody() {
    const { mode, phase, view } = state;
    const status =
      phase === "working"
        ? "Working"
        : phase === "attention"
          ? "Needs you"
          : phase === "complete"
            ? "Ready"
            : "Ready";
    const bar = `<div class="notch-bar"><span><i class="status-dot ${phase === "attention" ? "amber" : phase === "complete" ? "teal" : ""}"></i>${phase === "working" ? waves : status}</span><span class="camera" aria-hidden="true"></span><button class="notch-collapse" data-action="collapse" aria-label="${view === "bar" ? "Expand" : "Collapse"} Notch" aria-expanded="${view !== "bar"}">unmute ${view === "bar" ? "⌄" : "⌃"}</button></div>`;
    if (view === "bar") return bar;
    if (mode === "remote") {
      if (view === "cockpit")
        return (
          bar +
          `<div class="notch-body"><div class="notch-topline"><span>Orchestrator</span><button data-action="task">Close overview</button></div><h3>Whose move is it?</h3><div class="task-row"><button data-action="task">Website design review</button><span>${status}</span></div><div class="task-row"><span>Organize screenshots</span><span><i class="status-dot"></i>Working</span></div><div class="task-row"><span>Meeting notes</span><span><i class="status-dot teal"></i>Ready</span></div><small>Example sessions · select the design review to continue</small></div>`
        );
      const titles = {
        idle: "An idea. Already in motion.",
        working: "Getting the review together.",
        attention: "One decision needs you.",
        complete: "The next step is ready.",
      };
      const copy = {
        idle: "Give your agent a task, from wherever you’re working.",
        working: "Your agent is reading the notes and preparing the next step.",
        attention:
          "The review is ready. Which direction should the next pass take?",
        complete: state.reply
          ? `Your reply: “${escape(state.reply)}”`
          : "The review is ready for you.",
      };
      return (
        bar +
        `<div class="notch-body"><div class="notch-topline"><button class="provider provider-switch" data-action="provider" aria-label="Switch example agent"><img src="assets/${provider === "Codex" ? "codex" : "claude"}.png" width="17" height="17" alt=""> ${provider} <span>⌄ / Website</span></button><button data-action="overview" aria-label="Open session overview">▦ Overview</button></div><h3>${titles[phase]}</h3><p>${copy[phase]}</p>${phase === "idle" ? '<div class="notch-request">“Review the landing page and put together a clearer direction.”</div>' : ""}${phase === "attention" ? `<form data-reply-form><input aria-label="Reply to the example agent" name="reply" value="${escape(replyDraft)}" placeholder="Give it a direction…" maxlength="200" required><div class="notch-actions"><button type="button" data-action="choose" class="primary">Give the product more space</button><button class="primary" type="submit">Reply</button></div></form>` : `<div class="notch-actions"><button class="primary" data-action="${phase === "idle" ? "start" : phase === "complete" ? "reset" : "finish"}">${phase === "idle" ? "Try this task" : phase === "complete" ? "Try again" : "Skip to result"}</button><button data-action="terminal" aria-expanded="${terminal}">${terminal ? "Hide" : "Show"} activity</button></div>`}${terminal ? '<pre class="terminal">Reading design-review.md\nReviewing page structure\nPreparing a direction for your review</pre>' : ""}</div>`
      );
    }
    const info = {
      dictation: [
        "Your words, where you work.",
        "Dictate a thought, then choose whether to format it.",
        "Try dictation",
      ],
      scratchpad: [
        "Keep the whole thought.",
        "Collect words and context before you deliver them.",
        "Collect a thought",
      ],
      meetings: [
        "Be in the conversation.",
        "Capture microphone and system audio. Your connected agent writes the notes.",
        "Preview meeting notes",
      ],
      memory: [
        "Pick up where you left off.",
        "Ask Unmute about past dictation, meetings, and work.",
        "Ask Unmute",
      ],
    }[mode];
    return (
      bar +
      `<div class="notch-body"><h3>${phase === "complete" ? { dictation: "Your thought, delivered.", scratchpad: "Everything in one place.", meetings: "Notes you can act on.", memory: "Here’s where you left it." }[mode] : info[0]}</h3><p>${phase === "working" ? "Working through this example…" : info[1]}</p><div class="notch-actions"><button class="primary" data-action="${phase === "idle" ? "start" : phase === "working" ? "finish" : "reset"}">${phase === "idle" ? info[2] : phase === "working" ? "Show result" : "Try again"}</button>${mode === "dictation" && phase === "complete" ? `<button data-action="format">${format ? "Show original" : "Make it three bullets"}</button>` : mode === "scratchpad" && phase === "complete" ? '<button data-action="copy">Copy thought</button>' : "<small>Interactive preview</small>"}</div></div>`
    );
  }
  function windowBody() {
    const completed = state.phase === "complete";
    if (state.mode === "remote")
      return '<div class="date">Your workspace</div><h3>A better first impression.</h3><p>Give the product room to speak.<br>Make the next step feel obvious.<br>Keep the details worth noticing.</p>';
    if (state.mode === "dictation")
      return `<div class="date">Notes · Product thoughts</div><h3>A thought worth keeping.</h3>${completed ? (format ? "<ul><li>Give the typography more room.</li><li>Keep the interactions simple.</li><li>Continue with the new direction.</li></ul>" : `<textarea aria-label="Example dictation" readonly spellcheck="false">${samples.dictation}</textarea>`) : "<p>Your words will appear here.<br>Choose “Try dictation” in the Notch.</p>"}`;
    if (state.mode === "scratchpad")
      return `<div class="date">Scratchpad · ${completed ? "2 items collected" : "Ready for your thought"}</div><h3>Room for the whole idea.</h3>${completed ? `<p>${samples.scratchpad}</p><div class="attachment">▧ &nbsp; Design reference · attached context</div><p class="status-live" data-copy-status role="status"></p>` : "<p>Speak, pause, collect context.<br>Deliver it together when you’re ready.</p>"}`;
    if (state.mode === "meetings")
      return `<div class="date">Meetings · Design review</div><h3>${completed ? "A conversation. Clear next steps." : "Less writing. More listening."}</h3>${completed ? "<p><strong>Decided</strong> — Lead with the interactive product.</p><p><strong>Next</strong> — Maya refines the copy. Alex reviews the mobile layout.</p>" : "<p>The example meeting notes will appear here.<br>No microphone is used in this preview.</p>"}`;
    return `<div class="date">Unmute Agent · Memory</div><h3>${completed ? "You already worked this out." : "Your context has a home."}</h3>${completed ? "<p>You decided to lead with the product demo, use quieter motion, and keep the original logo.</p><p>From your design review and saved project context.</p>" : "<p>“What did we decide about the landing page?”</p>"}`;
  }
  function render() {
    const previousHeight = surface.offsetHeight;
    const hadFocus = surface.contains(document.activeElement);
    const focused = document.activeElement?.dataset.action;
    surface.classList.toggle("collapsed", state.view === "bar");
    desktop.dataset.mode = state.mode;
    desktop.classList.toggle("is-working", state.phase === "working");
    surface.innerHTML = notchBody();
    content.innerHTML = windowBody();
    desktop.setAttribute("aria-labelledby", `tab-${state.mode}`);
    live.textContent = `${state.mode} preview: ${state.phase === "attention" ? "Needs you" : state.phase}.`;
    if (hadFocus) {
      const target =
        [...surface.querySelectorAll("[data-action]")].find(
          (b) => b.dataset.action === focused,
        ) ||
        surface.querySelector(".primary") ||
        surface.querySelector("button");
      target?.focus({ preventScroll: true });
    }
    if (
      !matchMedia("(prefers-reduced-motion: reduce)").matches &&
      previousHeight > 40
    ) {
      surface.animate(
        [
          { height: previousHeight + "px" },
          { height: surface.offsetHeight + "px" },
        ],
        { duration: 240, easing: "ease-in-out" },
      );
    }
    root.querySelectorAll("[data-mode-tab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.modeTab === state.mode));
      b.tabIndex = b.dataset.modeTab === state.mode ? 0 : -1;
    });
    caption.innerHTML = `<strong>${{ remote: "Say it. Set it in motion.", dictation: "From a thought to text.", scratchpad: "A place for unfinished thoughts.", meetings: "Keep the conversation. Get the notes.", memory: "Your work, remembered." }[state.mode]}</strong> ${state.mode === "remote" ? "Start the task, open the overview, and give the agent a direction." : "Choose the action in the Notch to explore."} <span>Example content. No microphone or apps are accessed.</span>`;
  }
  function act(action, value) {
    if (action === "provider") {
      provider = provider === "Codex" ? "Claude Code" : "Codex";
      render();
      return;
    }
    if (action === "collapse") {
      state = advanceDemo(state, "view", state.view === "bar" ? "task" : "bar");
      render();
      return;
    }
    if (action === "overview" || action === "task") {
      state = advanceDemo(
        state,
        "view",
        action === "overview" ? "cockpit" : "task",
      );
      render();
      return;
    }
    if (action === "terminal") {
      terminal = !terminal;
      render();
      return;
    }
    if (action === "format") {
      format = !format;
      render();
      return;
    }
    if (action === "copy") {
      navigator.clipboard
        ?.writeText(samples.scratchpad)
        .then(() => {
          root.querySelector("[data-copy-status]").textContent =
            "Copied to clipboard.";
        })
        .catch(() => {
          root.querySelector("[data-copy-status]").textContent =
            "Select the text above to copy it.";
        });
      return;
    }
    if (action === "choose") {
      action = "reply";
      value = "Give the product more space";
    }
    clearTimeout(timer);
    if (action === "reset") {
      terminal = false;
      format = false;
      replyDraft = "";
    }
    state = advanceDemo(state, action, value);
    render();
    if (state.phase === "working")
      timer = setTimeout(() => {
        state = advanceDemo(state, "finish");
        render();
      }, 1800);
  }
  root.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-mode-tab]");
    if (tab) {
      clearTimeout(timer);
      state = initialDemo(tab.dataset.modeTab);
      terminal = false;
      format = false;
      replyDraft = "";
      render();
      return;
    }
    const b = e.target.closest("[data-action]");
    if (b) act(b.dataset.action);
  });
  root.addEventListener("input", (e) => {
    if (e.target.name === "reply") replyDraft = e.target.value;
  });
  root.addEventListener("submit", (e) => {
    if (e.target.matches("[data-reply-form]")) {
      e.preventDefault();
      act("reply", new FormData(e.target).get("reply"));
    }
  });
  root.querySelector("[role=tablist]").addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const tabs = [...root.querySelectorAll("[data-mode-tab]")];
    const i = tabs.indexOf(document.activeElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? tabs.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.phase === "working") {
      clearTimeout(timer);
      state = advanceDemo(state, "finish");
      render();
    }
  });
  render();
}
