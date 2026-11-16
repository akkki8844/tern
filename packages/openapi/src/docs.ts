import { RULE_CATALOG, type RuleId } from "./diff/rules.js";
import { DIRECTIONS, type Direction } from "./model/canonical.js";
import type { Severity } from "./diff/changes.js";

/**
 * Render the rule catalog as Markdown.
 *
 * `docs/openapi-rules.md` is generated from this function and a test asserts the two
 * stay identical, so the published catalog can never drift away from the code that
 * actually makes the decisions.
 */
export function renderRuleCatalogMarkdown(): string {
  const lines: string[] = [];
  lines.push("<!-- GENERATED FILE — do not edit by hand.");
  lines.push("     Source: packages/openapi/src/diff/rules.ts");
  lines.push("     Regenerate: npm run docs:rules -w @capibara/openapi -->");
  lines.push("");
  lines.push("# Breaking-change rule catalog");
  lines.push("");
  lines.push(
    "Every classification Capibara makes comes from exactly one rule below. Severity depends on"
  );
  lines.push("**direction**: narrowing what a server accepts breaks *requests*, while widening what a");
  lines.push("server returns breaks *responses*, so the same structural edit has two answers.");
  lines.push("");
  lines.push("## Severity");
  lines.push("");
  lines.push("| Value | Meaning |");
  lines.push("| --- | --- |");
  lines.push("| `BREAKING` | Existing clients stop working. |");
  lines.push(
    "| `CONDITIONAL` | Breaks *some* clients. Whether it breaks this repository is what the scanner determines. |"
  );
  lines.push("| `NON_BREAKING` | No existing client can be broken by this change. |");
  lines.push("| `UNKNOWN` | An unsupported construct is involved; Capibara makes no claim. |");
  lines.push("");
  lines.push("## Confidence");
  lines.push("");
  lines.push("Confidence describes the **evidence**, not a probability.");
  lines.push("");
  lines.push("| Value | Meaning |");
  lines.push("| --- | --- |");
  lines.push("| `HIGH` | An unambiguous local rule over fully analysed data. |");
  lines.push("| `MEDIUM` | The rule is sound, but the effect depends on client behaviour Capibara cannot observe. |");
  lines.push("| `LOW` | Detected structurally; the semantic effect depends on composition Capibara models partially. |");
  lines.push("| `UNKNOWN` | An unsupported construct is involved. |");
  lines.push("");

  const byKind = new Map<string, RuleId[]>();
  for (const id of Object.keys(RULE_CATALOG).sort() as RuleId[]) {
    const kind = RULE_CATALOG[id].kind;
    const list = byKind.get(kind) ?? [];
    list.push(id);
    byKind.set(kind, list);
  }

  const kindTitles: Record<string, string> = {
    path: "Paths",
    operation: "Operations",
    parameter: "Parameters",
    requestBody: "Request bodies",
    response: "Responses",
    schema: "Schemas",
    component: "Components",
    document: "Document"
  };

  lines.push(`## Rules (${Object.keys(RULE_CATALOG).length})`);
  lines.push("");

  for (const kind of [...byKind.keys()].sort()) {
    lines.push(`### ${kindTitles[kind] ?? kind}`);
    lines.push("");
    lines.push("| Rule | Request | Response | Confidence | Why |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const id of byKind.get(kind)!) {
      const definition = RULE_CATALOG[id];
      lines.push(
        `| \`${id}\` | ${badge(resolve(id, "request"))} | ${badge(resolve(id, "response"))} | ${definition.confidence} | ${escapeCell(definition.rationale)} |`
      );
    }
    lines.push("");

    const withLimits = byKind.get(kind)!.filter((id) => RULE_CATALOG[id].limitations);
    if (withLimits.length > 0) {
      lines.push("Known limitations:");
      lines.push("");
      for (const id of withLimits) {
        lines.push(`- \`${id}\` — ${RULE_CATALOG[id].limitations}`);
      }
      lines.push("");
    }
  }

  lines.push("## Directions");
  lines.push("");
  lines.push(`Valid values: ${DIRECTIONS.map((d) => `\`${d}\``).join(", ")}.`);
  lines.push("");
  lines.push("- `request` — the value travels from the client to the server.");
  lines.push("- `response` — the value travels from the server to the client.");
  lines.push("- `both` — the change is not specific to one direction (an operation was removed).");
  lines.push("- `unknown` — the direction could not be determined.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function resolve(id: RuleId, direction: Direction): Severity {
  const table = RULE_CATALOG[id].severity as Partial<Record<Direction, Severity>> & { default: Severity };
  return table[direction] ?? table.default;
}

function badge(severity: Severity): string {
  switch (severity) {
    case "BREAKING":
      return "**breaking**";
    case "CONDITIONAL":
      return "conditional";
    case "NON_BREAKING":
      return "safe";
    default:
      return "unknown";
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
