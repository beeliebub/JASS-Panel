// Validation for server input and for server rows read back from the database. Every value that reaches a unit file or a
// command line passes through here first; the unit renderer checks again, so neither layer is the only defence.
import { z } from "zod";
import { hasControlCharacter } from "../../shared/text.js";
import { SERVER_ID_PATTERN } from "./ids.js";

const NO_CONTROL = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((value) => !hasControlCharacter(value), `${label} may not contain control characters`);

export const serverIdSchema = z.string().regex(SERVER_ID_PATTERN, "the id must be lowercase letters, digits and dashes, 1 to 32 characters, starting with a letter or digit");

const argumentSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !hasControlCharacter(value), "an argument may not contain control characters");

export const paperPresetSchema = z.strictObject({
  kind: z.literal("paper"),
  javaPath: z.string().startsWith("/").max(512).refine((value) => !hasControlCharacter(value), "the Java path may not contain control characters"),
  minMb: z.int().min(256).max(65_536),
  maxMb: z.int().min(256).max(65_536),
  jarFile: z.string().regex(/^[A-Za-z0-9._-]+\.jar$/, "the jar file name must end in .jar and use letters, digits, dots, dashes and underscores"),
  extraFlags: z.array(z.string().regex(/^-[A-Za-z0-9=._:+,-]{1,63}$/, "each extra flag must start with a dash and use simple characters")).max(16).default([]),
});

export const customCommandSchema = z.strictObject({
  kind: z.literal("custom"),
  argv: z.array(argumentSchema).min(1).max(64),
});

export const addServerSchema = z.strictObject({
  id: serverIdSchema,
  displayName: NO_CONTROL("the display name").max(64),
  directory: z.string().startsWith("/").max(1024).refine((value) => !hasControlCharacter(value), "the directory may not contain control characters"),
  command: z.discriminatedUnion("kind", [paperPresetSchema, customCommandSchema]),
  logPath: z.string().max(256).refine((value) => !hasControlCharacter(value), "the log path may not contain control characters").default("logs/latest.log"),
  autostart: z.boolean().default(false),
}).refine((value) => value.command.kind === "custom" || value.command.minMb <= value.command.maxMb, "the minimum memory must not be more than the maximum");

export type AddServerInput = z.infer<typeof addServerSchema>;

/** The argv a Paper preset produces. The Java binary is resolved by the caller before this runs; the flags are fixed here. */
export function paperArgv(preset: z.infer<typeof paperPresetSchema>): string[] {
  return [
    preset.javaPath,
    `-Xms${preset.minMb}M`,
    `-Xmx${preset.maxMb}M`,
    ...preset.extraFlags,
    "-jar",
    preset.jarFile,
    "nogui",
  ];
}

export function relativeLogPath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\0") || hasControlCharacter(value)) return false;
  return value.split("/").every((segment) => segment !== ".." && segment !== "");
}
