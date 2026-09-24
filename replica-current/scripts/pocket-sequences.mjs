// Source-equivalent inventory models only; these do not implement browser UI.
// Every branch trace is tied to the immutable product pin owned by audit-source.
const root = "desktop/native-notch/Sources/";
const source = (name) =>
  `${root}${name === "PocketSwipe.swift" ? "PocketSwipeSupport" : "unmute-notch"}/${name}`;
const expanded = (state) => ["task", "cockpit"].includes(state);
const open = (p) => p.mode === "open" && p.slots.length > 0;
const current = (p) =>
  p.at >= 0 && p.at < p.slots.length ? p.slots[p.at] : null;
const emptySwipe = () => ({ travelX: 0, travelY: 0, spent: false });

// A trace condition records the branch as written and its required ordered
// parent outcomes, including failed early-return branches (required:false).
function condition(trace, file, line, predicate, outcome, parents = []) {
  const b = {
    source: source(file),
    line,
    predicate,
    outcome,
    ancestors: parents.map((p) => ({ ...p })),
  };
  trace.push(b);
  return { source: b.source, line, predicate, outcome, required: outcome };
}

export function feedSwipe(state, sample, trace = [], parents = []) {
  const s = {
    deltaX: 0,
    deltaY: 0,
    isMomentum: false,
    isGestureStart: false,
    isGestureEnd: false,
    hasPreciseDeltas: true,
    ...sample,
  };
  const cond = (line, predicate, outcome, ps = parents) =>
    condition(trace, "PocketSwipe.swift", line, predicate, outcome, ps);
  const momentum = cond(76, "isMomentum", s.isMomentum);
  if (momentum.outcome) return null;
  parents = [...parents, momentum];
  const precise = cond(80, "hasPreciseDeltas", s.hasPreciseDeltas);
  if (!precise.outcome) {
    const wheel = cond(
      81,
      "abs(deltaX) >= 0.5 && abs(deltaX) > abs(deltaY)",
      Math.abs(s.deltaX) >= 0.5 && Math.abs(s.deltaX) > Math.abs(s.deltaY),
      [...parents, precise],
    );
    return wheel.outcome ? (s.deltaX < 0 ? 1 : -1) : null;
  }
  parents = [...parents, precise];
  const start = cond(86, "isGestureStart", s.isGestureStart);
  if (start.outcome) Object.assign(state, emptySwipe());
  const end = cond(87, "isGestureEnd", s.isGestureEnd);
  if (end.outcome) {
    Object.assign(state, emptySwipe());
    return null;
  }
  state.travelX += s.deltaX;
  state.travelY += s.deltaY;
  const travel = cond(
    94,
    "!spent && abs(travelX) >= 26 && abs(travelX) > abs(travelY) * 1.4",
    !state.spent &&
      Math.abs(state.travelX) >= 26 &&
      Math.abs(state.travelX) > Math.abs(state.travelY) * 1.4,
    [...parents, end],
  );
  if (!travel.outcome) return null;
  state.spent = true;
  return state.travelX < 0 ? 1 : -1;
}

export function evaluatePocketSequence(
  input,
  actions = input.controller.sequence ?? [],
) {
  const state = {
    pocket: structuredClone(input.pocket),
    model: structuredClone(input.model),
    controller: { ...input.controller },
    swipe: emptySwipe(),
    enabled:
      open(input.pocket) &&
      !expanded(input.model.state) &&
      input.pocket.slots.length > 1,
    window: "pocket",
    monitor: open(input.pocket) && !expanded(input.model.state),
    catcherMounted: open(input.pocket) && !expanded(input.model.state),
    generation: 0,
    pendingReveal: null,
  };
  delete state.controller.sequence;
  const focus = () => {
    if (!open(state.pocket)) state.controller.pocketHoldsKey = false;
    state.allowsKey = expanded(state.model.state) || open(state.pocket);
    state.isKeyWindow =
      expanded(state.model.state) ||
      (open(state.pocket) && state.controller.pocketHoldsKey);
  };
  focus();
  const reconcileCatcher = () => {
    const mounted = open(state.pocket) && !expanded(state.model.state);
    const enabled = mounted && state.pocket.slots.length > 1;
    // NotchView:288/323 mounts the representable only on the live arrangement.
    // PocketSwipeArea:43-45 dismantles it when that branch disappears.
    if (state.catcherMounted !== mounted) {
      state.monitor = mounted;
      state.swipe = emptySwipe();
    }
    if (state.enabled !== enabled) state.swipe = emptySwipe();
    state.catcherMounted = mounted;
    state.enabled = enabled;
  };
  return actions.map((action) => {
    const branches = [],
      events = [],
      emissions = [],
      refits = [];
    let consumed = false;
    const c = (line, predicate, outcome, parents = []) =>
      condition(
        branches,
        "AppController.swift",
        line,
        predicate,
        outcome,
        parents,
      );
    const emit = (event, line, file = "AppController.swift") => {
      events.push(event);
      emissions.push({
        result: event,
        provenance: { source: source(file), line },
      });
    };
    const refit = () =>
      refits.push({
        animated: true,
        cardHeight: current(state.pocket)?.ask?.length ? 106 : 68,
      });
    if (action.type === "click") {
      // NotchView:275 disallows all snapshot hit testing. The catcher at
      // PocketSwipeArea:57 returns nil; native child Buttons win over the
      // card's parent onTapGesture (PocketView:461-465).
      if (!expanded(state.model.state) && open(state.pocket)) {
        state.controller.pocketHoldsKey = true;
        focus();
        const shoulders = input.geometry.hasNotch;
        if (action.target === "dashboard")
          emit(
            { type: "openDashboard" },
            shoulders ? 406 : 470,
            "PocketView.swift",
          );
        else if (action.target === "release")
          emit(
            { type: "pocketRelease" },
            shoulders ? 410 : 474,
            "PocketView.swift",
          );
        else if (
          ["previous", "next"].includes(action.target) &&
          state.pocket.slots.length > 1
        )
          emit(
            {
              type: "pocketMove",
              delta: action.target === "previous" ? -1 : 1,
            },
            253,
            "PocketView.swift",
          );
        else if (action.target === "card" && current(state.pocket))
          emit(
            { type: "pocketExpand", id: current(state.pocket).id },
            465,
            "PocketView.swift",
          );
      }
    } else if (action.type === "key") {
      const delivery = {
        source: source("AppController.swift"),
        line: 954,
        predicate: "window owns keyboard",
        outcome: state.isKeyWindow,
        required: true,
      };
      const foreign = delivery.outcome
        ? c(
            1583,
            "event window exists and is foreign",
            action.eventWindow != null && action.eventWindow !== state.window,
            [delivery],
          )
        : null;
      if (delivery.outcome && !foreign.outcome) {
        const parents = [delivery, foreign];
        const esc = c(1587, "keyCode == 53", action.keyCode === 53, parents);
        if (esc.outcome) {
          consumed = true;
          const popup = c(
            1766,
            "expanded && visible popup",
            expanded(state.model.state) &&
              (state.model.proposal != null ||
                state.model.proposalLoadingId != null),
            [...parents, esc],
          );
          if (popup.outcome) {
            if (state.model.proposal)
              emit({ type: "converseStop", id: state.model.proposal.id }, 1767);
            state.model.proposal = null;
            state.model.proposalLoadingId = null;
            state.model.convLog = "";
          } else {
            const isOpen = c(1776, "model.pocket.isOpen", open(state.pocket), [
              ...parents,
              esc,
              popup,
            ]);
            if (isOpen.outcome) emit({ type: "pocketRelease" }, 1777);
            else if (state.model.state !== "dormant")
              emit({ type: "collapsed" }, 1789);
          }
        } else {
          const typing = ["editableText", "terminal"].includes(
            action.firstResponder,
          );
          const bare = !(action.modifiers ?? []).some((m) =>
            ["command", "control", "option", "shift"].includes(m),
          );
          const guard = c(
            1615,
            "!typing && bareKey && pocket.isOpen && !expanded",
            !typing &&
              bare &&
              open(state.pocket) &&
              !expanded(state.model.state),
            [...parents, esc],
          );
          if (guard.outcome) {
            if ([123, 124].includes(action.keyCode)) {
              const many = c(
                action.keyCode === 123 ? 1618 : 1622,
                "slots.count > 1",
                state.pocket.slots.length > 1,
                [...parents, esc, guard],
              );
              if (many.outcome) {
                emit(
                  {
                    type: "pocketMove",
                    delta: action.keyCode === 123 ? -1 : 1,
                  },
                  action.keyCode === 123 ? 1619 : 1623,
                );
                consumed = true;
              }
            } else if ([36, 76].includes(action.keyCode)) {
              const valid = c(
                1626,
                "current != nil",
                current(state.pocket) != null,
                [...parents, esc, guard],
              );
              if (valid.outcome) {
                emit(
                  { type: "pocketExpand", id: current(state.pocket).id },
                  1628,
                );
                consumed = true;
              }
            }
          }
        }
      }
    } else if (action.type === "scroll") {
      const running = {
        source: source("PocketSwipeArea.swift"),
        line: 66,
        predicate: "monitor installed",
        outcome: state.monitor,
        required: true,
      };
      if (running.outcome) {
        const scope = condition(
          branches,
          "PocketSwipeArea.swift",
          82,
          "enabled && window exists && event.window === window",
          state.enabled &&
            state.window != null &&
            action.eventWindow === state.window,
          [running],
        );
        if (scope.outcome) {
          const inside = condition(
            branches,
            "PocketSwipeArea.swift",
            83,
            "bounds.contains(event location)",
            action.inside,
            [running, scope],
          );
          if (!inside.outcome) state.swipe = emptySwipe();
          else {
            const step = feedSwipe(state.swipe, action.sample, branches, [
              running,
              scope,
              inside,
            ]);
            const stepped = condition(
              branches,
              "PocketSwipeArea.swift",
              97,
              "swipe.feed returns step",
              step != null,
              [running, scope, inside],
            );
            if (stepped.outcome) {
              emit({ type: "pocketMove", delta: step }, 324, "NotchView.swift");
              consumed = true;
            }
          }
        }
      }
    } else if (action.type === "enabled") {
      const changed = condition(
        branches,
        "PocketSwipeArea.swift",
        38,
        "view.enabled != enabled",
        state.enabled !== action.value,
      );
      if (changed.outcome) state.swipe = emptySwipe();
      state.enabled = action.value;
    } else if (
      action.type === "stopMonitor" ||
      action.type === "detachWindow"
    ) {
      condition(
        branches,
        "PocketSwipeArea.swift",
        73,
        "monitor != nil",
        state.monitor,
      );
      state.monitor = false;
      state.swipe = emptySwipe();
      if (action.type === "detachWindow") state.window = null;
    } else if (action.type === "startMonitor") {
      const absent = condition(
        branches,
        "PocketSwipeArea.swift",
        65,
        "monitor == nil",
        !state.monitor,
      );
      if (absent.outcome) state.monitor = true;
    } else if (action.type === "outsideClick") {
      const compact = c(1536, "!expanded", !expanded(state.model.state));
      if (compact.outcome) {
        const owns = c(
          1537,
          "pocket.isOpen && pocketHoldsKey",
          open(state.pocket) && state.controller.pocketHoldsKey,
          [compact],
        );
        if (owns.outcome) state.controller.pocketHoldsKey = false;
        focus();
      }
    } else if (action.type === "insideClick") {
      const claims = c(
        975,
        "pocket.isOpen && !expanded",
        open(state.pocket) && !expanded(state.model.state),
      );
      if (claims.outcome) state.controller.pocketHoldsKey = true;
      focus();
    } else if (action.type === "payload") {
      const wasOpen = open(state.pocket),
        wasAt = state.pocket.at;
      state.pocket = structuredClone(action.pocket);
      const claim = c(
        566,
        "p.isOpen && (!wasOpen || p.at != wasAt)",
        open(state.pocket) && (!wasOpen || state.pocket.at !== wasAt),
      );
      if (claim.outcome && !expanded(state.model.state))
        state.controller.pocketHoldsKey = true;
      focus();
      const visible = c(
        574,
        "!expanded || state == attention",
        !expanded(state.model.state) || state.model.state === "attention",
      );
      if (visible.outcome) refit();
      reconcileCatcher();
    } else if (action.type === "capture") {
      const before = state.model.captureAimed;
      state.model.capturePhase = action.capturePhase;
      state.model.captureLevel =
        action.phase === "recording" ? action.level : 0;
      state.model.captureAimed =
        action.phase === "recording" &&
        action.kind === "remote" &&
        action.capturePhase === "listening";
      const changed = c(
        657,
        "captureAimed != wasAimed && pocket.isOpen && !expanded",
        before !== state.model.captureAimed &&
          open(state.pocket) &&
          !expanded(state.model.state),
      );
      if (changed.outcome) refit();
    } else if (action.type === "state") {
      const wasExpanded = expanded(state.model.state),
        destinationExpanded = expanded(action.destination);
      const fromPocket =
        !wasExpanded && destinationExpanded && open(state.pocket);
      const preserve =
        wasExpanded &&
        destinationExpanded &&
        !state.model.expandedContentReady &&
        state.model.transitionPocket != null;
      const p = c(712, "!preserveContentHandoff", !preserve);
      if (!preserve) {
        state.generation++;
        const delay = c(
          717,
          "expandingFromPocket && !contentPrepared && !reduceMotion",
          fromPocket &&
            !action.contentPrepared &&
            !state.controller.motionReduceMotion,
          [p],
        );
        state.model.transitionPocket = delay.outcome
          ? structuredClone(state.pocket)
          : null;
        state.model.expandedContentReady = !delay.outcome;
      }
      state.model.state = action.destination;
      const down = c(
        813,
        "wasExpanded && !engaged && pocket.isOpen",
        wasExpanded && !destinationExpanded && open(state.pocket),
      );
      if (down.outcome) state.controller.pocketHoldsKey = true;
      const reveal =
        fromPocket &&
        !state.controller.motionReduceMotion &&
        !preserve &&
        !state.model.expandedContentReady;
      if (reveal) state.pendingReveal = state.generation;
      focus();
      reconcileCatcher();
    } else if (action.type === "frameComplete") {
      const valid = c(
        822,
        "pending reveal generation matches && expanded",
        state.pendingReveal != null &&
          state.pendingReveal === action.generation &&
          state.generation === action.generation &&
          expanded(state.model.state),
      );
      if (valid.outcome) {
        state.model.expandedContentReady = true;
        state.model.transitionPocket = null;
        state.pendingReveal = null;
      }
    } else throw new Error(`Unknown Pocket sequence action: ${action.type}`);
    return {
      action: structuredClone(action),
      events,
      emissions,
      consumed,
      refits,
      state: structuredClone(state),
      branches,
    };
  });
}
