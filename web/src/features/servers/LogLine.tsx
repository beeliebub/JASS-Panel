import { memo } from "react";

// Renders untrusted console output as text and fixed, CSP-safe colour classes.
type ColorName =
  | "ansiBlack" | "ansiRed" | "ansiGreen" | "ansiYellow" | "ansiBlue" | "ansiMagenta" | "ansiCyan" | "ansiWhite"
  | "ansiBrightBlack" | "ansiBrightRed" | "ansiBrightGreen" | "ansiBrightYellow" | "ansiBrightBlue" | "ansiBrightMagenta" | "ansiBrightCyan" | "ansiBrightWhite"
  | "minecraftBlack" | "minecraftDarkBlue" | "minecraftDarkGreen" | "minecraftDarkAqua" | "minecraftDarkRed" | "minecraftDarkPurple" | "minecraftGold" | "minecraftGray"
  | "minecraftDarkGray" | "minecraftBlue" | "minecraftGreen" | "minecraftAqua" | "minecraftRed" | "minecraftLightPurple" | "minecraftYellow" | "minecraftWhite";

const COLOR_CLASSES: Record<ColorName, { readonly text: string; readonly background: string }> = {
  ansiBlack: { text: "text-[#000000]", background: "bg-[#000000]" },
  ansiRed: { text: "text-[#aa0000]", background: "bg-[#aa0000]" },
  ansiGreen: { text: "text-[#00aa00]", background: "bg-[#00aa00]" },
  ansiYellow: { text: "text-[#aa5500]", background: "bg-[#aa5500]" },
  ansiBlue: { text: "text-[#0000aa]", background: "bg-[#0000aa]" },
  ansiMagenta: { text: "text-[#aa00aa]", background: "bg-[#aa00aa]" },
  ansiCyan: { text: "text-[#00aaaa]", background: "bg-[#00aaaa]" },
  ansiWhite: { text: "text-[#aaaaaa]", background: "bg-[#aaaaaa]" },
  ansiBrightBlack: { text: "text-[#555555]", background: "bg-[#555555]" },
  ansiBrightRed: { text: "text-[#ff5555]", background: "bg-[#ff5555]" },
  ansiBrightGreen: { text: "text-[#55ff55]", background: "bg-[#55ff55]" },
  ansiBrightYellow: { text: "text-[#ffff55]", background: "bg-[#ffff55]" },
  ansiBrightBlue: { text: "text-[#5555ff]", background: "bg-[#5555ff]" },
  ansiBrightMagenta: { text: "text-[#ff55ff]", background: "bg-[#ff55ff]" },
  ansiBrightCyan: { text: "text-[#55ffff]", background: "bg-[#55ffff]" },
  ansiBrightWhite: { text: "text-[#ffffff]", background: "bg-[#ffffff]" },
  minecraftBlack: { text: "text-[#000000]", background: "bg-[#000000]" },
  minecraftDarkBlue: { text: "text-[#0000aa]", background: "bg-[#0000aa]" },
  minecraftDarkGreen: { text: "text-[#00aa00]", background: "bg-[#00aa00]" },
  minecraftDarkAqua: { text: "text-[#00aaaa]", background: "bg-[#00aaaa]" },
  minecraftDarkRed: { text: "text-[#aa0000]", background: "bg-[#aa0000]" },
  minecraftDarkPurple: { text: "text-[#aa00aa]", background: "bg-[#aa00aa]" },
  minecraftGold: { text: "text-[#ffaa00]", background: "bg-[#ffaa00]" },
  minecraftGray: { text: "text-[#aaaaaa]", background: "bg-[#aaaaaa]" },
  minecraftDarkGray: { text: "text-[#555555]", background: "bg-[#555555]" },
  minecraftBlue: { text: "text-[#5555ff]", background: "bg-[#5555ff]" },
  minecraftGreen: { text: "text-[#55ff55]", background: "bg-[#55ff55]" },
  minecraftAqua: { text: "text-[#55ffff]", background: "bg-[#55ffff]" },
  minecraftRed: { text: "text-[#ff5555]", background: "bg-[#ff5555]" },
  minecraftLightPurple: { text: "text-[#ff55ff]", background: "bg-[#ff55ff]" },
  minecraftYellow: { text: "text-[#ffff55]", background: "bg-[#ffff55]" },
  minecraftWhite: { text: "text-[#ffffff]", background: "bg-[#ffffff]" },
};

const ANSI_DARK_COLORS = [
  "ansiBlack", "ansiRed", "ansiGreen", "ansiYellow", "ansiBlue", "ansiMagenta", "ansiCyan", "ansiWhite",
] as const satisfies readonly ColorName[];
const ANSI_BRIGHT_COLORS = [
  "ansiBrightBlack", "ansiBrightRed", "ansiBrightGreen", "ansiBrightYellow", "ansiBrightBlue", "ansiBrightMagenta", "ansiBrightCyan", "ansiBrightWhite",
] as const satisfies readonly ColorName[];
const MINECRAFT_COLORS: Record<string, ColorName> = {
  "0": "minecraftBlack",
  "1": "minecraftDarkBlue",
  "2": "minecraftDarkGreen",
  "3": "minecraftDarkAqua",
  "4": "minecraftDarkRed",
  "5": "minecraftDarkPurple",
  "6": "minecraftGold",
  "7": "minecraftGray",
  "8": "minecraftDarkGray",
  "9": "minecraftBlue",
  a: "minecraftGreen",
  b: "minecraftAqua",
  c: "minecraftRed",
  d: "minecraftLightPurple",
  e: "minecraftYellow",
  f: "minecraftWhite",
};

type FormatState = {
  foreground: ColorName | null;
  background: ColorName | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
};

type TextToken = { readonly text: string; readonly classes: readonly string[] };

const FORMAT_CLASSES = {
  bold: "font-bold",
  dim: "opacity-60",
  italic: "italic",
  underline: "underline",
  strike: "line-through",
} as const;

const ANSI_RGB: Record<ColorName, readonly [number, number, number]> = {
  ansiBlack: [0, 0, 0], ansiRed: [170, 0, 0], ansiGreen: [0, 170, 0], ansiYellow: [170, 85, 0],
  ansiBlue: [0, 0, 170], ansiMagenta: [170, 0, 170], ansiCyan: [0, 170, 170], ansiWhite: [170, 170, 170],
  ansiBrightBlack: [85, 85, 85], ansiBrightRed: [255, 85, 85], ansiBrightGreen: [85, 255, 85], ansiBrightYellow: [255, 255, 85],
  ansiBrightBlue: [85, 85, 255], ansiBrightMagenta: [255, 85, 255], ansiBrightCyan: [85, 255, 255], ansiBrightWhite: [255, 255, 255],
  minecraftBlack: [0, 0, 0], minecraftDarkBlue: [0, 0, 170], minecraftDarkGreen: [0, 170, 0], minecraftDarkAqua: [0, 170, 170],
  minecraftDarkRed: [170, 0, 0], minecraftDarkPurple: [170, 0, 170], minecraftGold: [255, 170, 0], minecraftGray: [170, 170, 170],
  minecraftDarkGray: [85, 85, 85], minecraftBlue: [85, 85, 255], minecraftGreen: [85, 255, 85], minecraftAqua: [85, 255, 255],
  minecraftRed: [255, 85, 85], minecraftLightPurple: [255, 85, 255], minecraftYellow: [255, 255, 85], minecraftWhite: [255, 255, 255],
};

const DEFAULT_FORMAT: FormatState = {
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
};

function styleClasses(format: FormatState): string[] {
  const classes: string[] = [];
  if (format.foreground !== null) classes.push(COLOR_CLASSES[format.foreground].text);
  if (format.background !== null) classes.push(COLOR_CLASSES[format.background].background);
  if (format.bold) classes.push(FORMAT_CLASSES.bold);
  if (format.dim) classes.push(FORMAT_CLASSES.dim);
  if (format.italic) classes.push(FORMAT_CLASSES.italic);
  if (format.underline) classes.push(FORMAT_CLASSES.underline);
  if (format.strike) classes.push(FORMAT_CLASSES.strike);
  return classes;
}

function copyFormat(format: FormatState): FormatState {
  return { ...format };
}

function resetFormat(format: FormatState): void {
  Object.assign(format, DEFAULT_FORMAT);
}

function colorFromRgb(red: number, green: number, blue: number): ColorName {
  let nearest: ColorName = ANSI_DARK_COLORS[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const color of [...ANSI_DARK_COLORS, ...ANSI_BRIGHT_COLORS]) {
    const [candidateRed, candidateGreen, candidateBlue] = ANSI_RGB[color];
    const distance = (red - candidateRed) ** 2 + (green - candidateGreen) ** 2 + (blue - candidateBlue) ** 2;
    if (distance < nearestDistance) {
      nearest = color;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function parseSgr(line: string, start: number): { readonly end: number; readonly parameters: readonly number[] } | null {
  if (line[start] !== "\u001b" || line[start + 1] !== "[") return null;
  const parameters: number[] = [];
  let value = 0;
  let hasDigit = false;
  const endLimit = Math.min(line.length, start + 64);
  for (let index = start + 2; index < endLimit; index += 1) {
    const character = line[index];
    if (character === undefined) return null;
    if (character >= "0" && character <= "9") {
      value = value * 10 + character.charCodeAt(0) - 48;
      if (value > 255) return null;
      hasDigit = true;
    } else if (character === ";") {
      parameters.push(hasDigit ? value : 0);
      if (parameters.length > 32) return null;
      value = 0;
      hasDigit = false;
    } else if (character === "m") {
      parameters.push(hasDigit ? value : 0);
      return { end: index + 1, parameters };
    } else {
      return null;
    }
  }
  return null;
}

function applySgr(format: FormatState, parameters: readonly number[]): boolean {
  const next = copyFormat(format);
  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index];
    if (code === undefined) return false;
    if (code === 0) {
      resetFormat(next);
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 9) {
      next.strike = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 29) {
      next.strike = false;
    } else if (code >= 30 && code <= 37) {
      next.foreground = ANSI_DARK_COLORS[code - 30] ?? null;
    } else if (code === 38 || code === 48) {
      const isForeground = code === 38;
      const mode = parameters[index + 1];
      let color: ColorName | null = null;
      if (mode === 5) {
        const paletteValue = parameters[index + 2];
        if (paletteValue === undefined || paletteValue > 255) return false;
        color = xtermColor(paletteValue);
        index += 2;
      } else if (mode === 2) {
        const red = parameters[index + 2];
        const green = parameters[index + 3];
        const blue = parameters[index + 4];
        if (red === undefined || green === undefined || blue === undefined) return false;
        color = colorFromRgb(red, green, blue);
        index += 4;
      } else {
        return false;
      }
      if (isForeground) next.foreground = color;
      else next.background = color;
    } else if (code === 39) {
      next.foreground = null;
    } else if (code >= 40 && code <= 47) {
      next.background = ANSI_DARK_COLORS[code - 40] ?? null;
    } else if (code === 49) {
      next.background = null;
    } else if (code >= 90 && code <= 97) {
      next.foreground = ANSI_BRIGHT_COLORS[code - 90] ?? null;
    } else if (code >= 100 && code <= 107) {
      next.background = ANSI_BRIGHT_COLORS[code - 100] ?? null;
    } else {
      return false;
    }
  }
  Object.assign(format, next);
  return true;
}

function xtermColor(value: number): ColorName {
  if (value < 16) {
    return value < 8 ? ANSI_DARK_COLORS[value] ?? "ansiBlack" : ANSI_BRIGHT_COLORS[value - 8] ?? "ansiBlack";
  }
  if (value >= 232) {
    const level = 8 + (value - 232) * 10;
    return colorFromRgb(level, level, level);
  }
  const paletteIndex = value - 16;
  const levels = [0, 95, 135, 175, 215, 255] as const;
  const red = levels[Math.floor(paletteIndex / 36) % 6] ?? 0;
  const green = levels[Math.floor(paletteIndex / 6) % 6] ?? 0;
  const blue = levels[paletteIndex % 6] ?? 0;
  return colorFromRgb(red, green, blue);
}

function minecraftCode(code: string): { readonly color: ColorName } | { readonly format: keyof typeof FORMAT_CLASSES } | { readonly reset: true } | null {
  const normalized = code.toLowerCase();
  const color = MINECRAFT_COLORS[normalized];
  if (color !== undefined) return { color };
  if (normalized === "l") return { format: "bold" };
  if (normalized === "o") return { format: "italic" };
  if (normalized === "n") return { format: "underline" };
  if (normalized === "m") return { format: "strike" };
  if (normalized === "r") return { reset: true };
  return null;
}

function isInvisibleControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    || /\p{Cf}/u.test(String.fromCodePoint(codePoint));
}

function visibleControl(codePoint: number): string {
  if (codePoint === 0x7f) return "␡";
  if (codePoint <= 0x1f) return String.fromCodePoint(0x2400 + codePoint);
  return `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
}

export function makeInvisibleControlsVisible(value: string): string {
  let visible = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    visible += isInvisibleControl(codePoint) ? visibleControl(codePoint) : character;
  }
  return visible;
}

function parseLogLine(line: string): TextToken[] {
  const tokens: TextToken[] = [];
  let format = { ...DEFAULT_FORMAT };
  let currentText = "";
  let currentClasses = styleClasses(format);
  const flush = (): void => {
    if (currentText.length === 0) return;
    tokens.push({ text: currentText, classes: currentClasses });
    currentText = "";
  };
  const updateFormat = (update: () => void): void => {
    flush();
    update();
    currentClasses = styleClasses(format);
  };

  for (let index = 0; index < line.length;) {
    const character = line[index];
    if (character === "\u001b") {
      const sgr = parseSgr(line, index);
      if (sgr !== null && applySgr(format, sgr.parameters)) {
        updateFormat(() => { index = sgr.end; });
        continue;
      }
    }

    if (character === "§" && index + 1 < line.length) {
      const code = minecraftCode(line[index + 1] ?? "");
      if (code !== null) {
        updateFormat(() => {
          if ("color" in code) {
            format.foreground = code.color;
            format.bold = false;
            format.dim = false;
            format.italic = false;
            format.underline = false;
            format.strike = false;
          } else if ("format" in code) {
            format[code.format] = true;
          } else {
            format = { ...DEFAULT_FORMAT };
          }
          index += 2;
        });
        continue;
      }
    }

    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const visible = isInvisibleControl(codePoint) ? visibleControl(codePoint) : String.fromCodePoint(codePoint);
    currentText += visible;
    index += codePoint > 0xffff ? 2 : 1;
  }
  flush();
  return tokens;
}

export type LogLineProps = {
  readonly line: string;
  readonly wrap?: boolean;
};

export const LogLine = memo(function LogLine({ line, wrap = true }: LogLineProps) {
  const tokens = parseLogLine(line);
  return (
    <span className={wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}>
      {tokens.map((token, index) => token.classes.length === 0
        ? <span key={index}>{token.text}</span>
        : <span className={token.classes.join(" ")} key={index}>{token.text}</span>)}
    </span>
  );
});
