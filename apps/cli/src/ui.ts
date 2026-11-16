
import pc from "picocolors";

/**
 * Capibara CLI visuals.
 *
 * Deliberately in the school of Claude Code and Gemini CLI: a quiet wordmark,
 * one accent glyph, strong severity colour, dim detail — and every rule driven
 * by the environment (NO_COLOR, non-TTY) so piped output stays clean.
 */

export const ACCENT = pc.magenta;
export const BRAND = "capibara";

// Colour itself is governed by picocolors, which honours NO_COLOR and non-TTY output.
export const INTERACTIVE = process.stdout.isTTY === true;

// ---------------------------------------------------------------------------
// Wordmark
// ---------------------------------------------------------------------------

export function banner(version: string): string {
  const line1 = ` ${ACCENT("◆")} ${pc.bold(BRAND)} ${pc.dim(`v${version}`)}`;
  const line2 = pc.dim("  API breaking changes, mapped to the exact code they affect.");
  const width = Math.max(strip(line1).length, strip(line2).length) + 2;
  const top = pc.dim(`╭${"─".repeat(width)}╮`);
  const bottom = pc.dim(`╰${"─".repeat(width)}╯`);
  const pad = (text: string) => pc.dim("│") + text + " ".repeat(Math.max(0, width - strip(text).length)) + pc.dim("│");
  return [top, pad(line1), pad(line2), bottom].join("\n");
}

export function strip(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Symbols and chips
// ---------------------------------------------------------------------------

const ICONS = { ok: "✔", fail: "✗", warn: "!", info: "·", arrow: "→", dot: "◆" };

export const symbols = {
  ok: (s = "") => pc.green(ICONS.ok) + (s ? ` ${s}` : ""),
  fail: (s = "") => pc.red(ICONS.fail) + (s ? ` ${s}` : ""),
  warn: (s = "") => pc.yellow(ICONS.warn) + (s ? ` ${s}` : ""),
  info: (s = "") => pc.dim(ICONS.info) + (s ? ` ${s}` : ""),
  arrow: () => pc.dim(ICONS.arrow),
  dot: () => ACCENT(ICONS.dot)
};

export type Severity = "BREAKING" | "CONDITIONAL" | "NON_BREAKING";
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export function severityChip(severity: string): string {
  const label = severity.toLowerCase().replace("_", "-");
  if (severity === "BREAKING") return pc.bgRed(pc.bold(` ${label} `));
  if (severity === "CONDITIONAL") return pc.bgYellow(pc.black(` ${label} `));
  return pc.bgGreen(pc.black(` ${label} `));
}

export function confidenceChip(confidence: string): string {
  const label = confidence.toLowerCase();
  if (confidence === "HIGH") return pc.green(pc.bold(label));
  if (confidence === "MEDIUM") return pc.yellow(label);
  if (confidence === "UNKNOWN") return pc.magenta(label);
  return pc.dim(label);
}

export function countBar(counts: Array<{ label: string; count: number; color: (s: string) => string }>): string {
  return counts
    .filter((c) => c.count > 0)
    .map((c) => `${c.color(String(c.count))} ${pc.dim(c.label.toLowerCase())}`)
    .join(pc.dim("  ·  "));
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function section(title: string): string {
  return `\n${pc.bold(title.toUpperCase())} ${pc.dim("─".repeat(Math.max(3, 46 - title.length)))}`;
}

export function padColumn(text: string, width: number): string {
  const bare = strip(text);
  return text + " ".repeat(Math.max(1, width - bare.length));
}

export function truncate(text: string, max: number): string {
  if (strip(text).length <= max) return text;
  return strip(text).slice(0, max - 1) + "…";
}
