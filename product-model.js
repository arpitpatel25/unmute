export const prices = {
  dictation: { month: 4.99, year: 49 },
  unmute: { month: 7.99, year: 79 },
};
export function initialDemo(mode = "remote") {
  return {
    mode: ["remote", "dictation", "scratchpad", "meetings", "memory"].includes(
      mode,
    )
      ? mode
      : "dictation",
    phase: "idle",
    reply: "",
    view: "task",
  };
}
export function advanceDemo(state, event, value = "") {
  if (event === "reset") return initialDemo(state.mode);
  if (event === "start" && state.phase === "idle")
    return { ...state, phase: "working" };
  if (event === "finish" && state.phase === "working")
    return {
      ...state,
      phase: state.mode === "remote" ? "attention" : "complete",
    };
  if (event === "reply" && state.phase === "attention" && value.trim())
    return { ...state, phase: "complete", reply: value.trim() };
  if (event === "view") return { ...state, view: value };
  return state;
}
