// How a unit state reads to a person. Unknown is shown as unknown; it is never presented as stopped or healthy.
import type { UnitStateView } from "@shared/servers.js";

export function stateLabel(state: UnitStateView): string {
  if (!state.known) return "Unknown";
  switch (state.activeState) {
    case "active":
      // A server is only running once it has printed Done: until then the console refuses input, so the panel does not call it running.
      return state.loaded ? "Running" : "Starting";
    case "activating":
      return "Starting";
    case "deactivating":
      return "Stopping";
    case "inactive":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return state.activeState;
  }
}

export function stateTone(state: UnitStateView): "good" | "warn" | "danger" | "muted" {
  if (!state.known) return "muted";
  if (state.activeState === "active") return state.loaded ? "good" : "warn";
  if (state.activeState === "failed") return "danger";
  if (state.activeState === "activating" || state.activeState === "deactivating") return "warn";
  return "muted";
}

export function toneClass(tone: "good" | "warn" | "danger" | "muted"): string {
  switch (tone) {
    case "good":
      return "text-panel-good";
    case "warn":
      return "text-panel-warn";
    case "danger":
      return "text-panel-danger";
    case "muted":
      return "text-panel-muted";
  }
}
