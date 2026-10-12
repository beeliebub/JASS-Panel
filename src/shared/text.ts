// Text checks shared by the daemon and the UI. A control character is anything a terminal or a unit file could read as structure:
// the C0 range, DEL, and the Unicode line and paragraph separators, which some parsers treat as line breaks.
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}
