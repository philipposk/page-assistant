// U+2028/U+2029 end a line in JS and in most prompt renderings; built from char codes so
// the source file itself never contains them.
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const LINE_BREAKING = new RegExp(`[\\x00-\\x1f\\x7f${LINE_SEPARATORS}]+`, "g");

/**
 * Collapse to one trimmed line of at most `max` characters. For host- or user-supplied
 * text placed into the system prompt or llm.txt, where a newline would start a new line
 * of instructions.
 */
export function oneLine(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(LINE_BREAKING, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
