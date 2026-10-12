// The capability catalogue from the design, kept in the shared module so the UI offers the same names. The helpers below are the only
// place the daemon asks what kind of capability a name is.
import {
  PANEL_ACCESS,
  PANEL_CAPABILITY_NAMES,
  PANEL_OPERATOR,
  SERVER_CAPABILITY_NAMES,
} from "../../shared/capabilities.js";

export { PANEL_ACCESS, PANEL_OPERATOR };
export const SERVER_CAPABILITIES = SERVER_CAPABILITY_NAMES;
export const PANEL_CAPABILITIES = PANEL_CAPABILITY_NAMES;

export type ServerCapability = (typeof SERVER_CAPABILITIES)[number];
export type PanelCapability = (typeof PANEL_CAPABILITIES)[number];
export type Capability = ServerCapability | PanelCapability;

const SERVER_SET: ReadonlySet<string> = new Set<string>(SERVER_CAPABILITIES);
const PANEL_SET: ReadonlySet<string> = new Set<string>(PANEL_CAPABILITIES);

export function isServerCapability(value: string): value is ServerCapability {
  return SERVER_SET.has(value);
}

export function isPanelCapability(value: string): value is PanelCapability {
  return PANEL_SET.has(value);
}

export function isCapability(value: string): value is Capability {
  return isServerCapability(value) || isPanelCapability(value);
}
