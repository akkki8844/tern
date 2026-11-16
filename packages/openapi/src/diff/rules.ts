import type { ChangeKind, Confidence, Direction, Severity } from "./changes.js";

/**
 * The breaking-change rule catalog.
 *
 * Every classification Tern makes comes from exactly one entry in this table. A rule
 * is a *decision*, not a description: two situations that need different answers get
 * different rule ids rather than a shared id with conditional logic buried in the
 * engine. That makes the whole classification surface visible here, greppable, and
 * testable one rule at a time.
 *
 * `docs/openapi-rules.md` is generated from this table, and a test fails if the two
 * ever drift apart.
 */
export interface RuleDefinition {
  /** Coarse grouping, used for reporting. */
  readonly kind: ChangeKind;
  /** Short human title. */
  readonly title: string;
  /**
   * Severity per compatibility direction.
   *
   * Direction is the single most important input: narrowing what a server accepts
   * breaks *requests*, while widening what a server returns breaks *responses*. The
   * same structural edit therefore has opposite consequences depending on where it
   * sits, and this table records both answers explicitly.
   */
  readonly severity: Readonly<Partial<Record<Direction, Severity>>> & { readonly default: Severity };
  readonly confidence: Confidence;
  /** Why this classification holds, phrased in terms of an existing client. */
  readonly rationale: string;
  /** What this rule cannot see. Absent means the rule is exact. */
  readonly limitations?: string;
}

function rule(definition: RuleDefinition): RuleDefinition {
  return definition;
}

export const RULE_CATALOG = {
  // -------------------------------------------------------------------------
  // Paths and operations
  // -------------------------------------------------------------------------
  PATH_REMOVED: rule({
    kind: "path",
    title: "Path removed",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Every existing call to this path now fails; there is no operation left to serve it."
  }),
  PATH_ADDED: rule({
    kind: "path",
    title: "Path added",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Existing clients do not call a path that did not previously exist."
  }),
  OPERATION_REMOVED: rule({
    kind: "operation",
    title: "Operation removed",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Clients calling this method on this path now receive 404 or 405."
  }),
  OPERATION_ADDED: rule({
    kind: "operation",
    title: "Operation added",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "A new operation cannot affect calls that were already being made."
  }),
  OPERATION_ID_CHANGED: rule({
    kind: "operation",
    title: "operationId changed",
    severity: { default: "CONDITIONAL" },
    confidence: "HIGH",
    rationale:
      "The HTTP contract is unchanged, but generated clients name their methods after operationId, so any repository using a generated SDK must be updated.",
    limitations: "Whether this matters depends on whether the consuming repository uses a generated client."
  }),
  OPERATION_ID_REMOVED: rule({
    kind: "operation",
    title: "operationId removed",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Generators fall back to a name derived from the method and path, so a generated client method is likely to be renamed.",
    limitations: "The replacement name depends on the generator."
  }),
  OPERATION_ID_ADDED: rule({
    kind: "operation",
    title: "operationId added",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "The operation previously had a generator-derived method name and will now be named after the new operationId.",
    limitations: "Only affects repositories using a generated client."
  }),
  OPERATION_DEPRECATED: rule({
    kind: "operation",
    title: "Operation deprecated",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Deprecation is advisory; the operation still functions."
  }),

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------
  PARAMETER_REMOVED: rule({
    kind: "parameter",
    title: "Parameter removed",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "The server no longer declares this parameter. Requests that still send it are usually ignored rather than rejected, but any behaviour the caller relied on silently disappears.",
    limitations: "Whether an undeclared parameter is ignored or rejected is a server implementation detail."
  }),
  REQUIRED_PARAMETER_ADDED: rule({
    kind: "parameter",
    title: "Required parameter added",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Existing callers do not send this parameter, so their requests are now invalid."
  }),
  OPTIONAL_PARAMETER_ADDED: rule({
    kind: "parameter",
    title: "Optional parameter added",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Existing callers may continue to omit an optional parameter."
  }),
  PARAMETER_MADE_REQUIRED: rule({
    kind: "parameter",
    title: "Parameter made required",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Callers that legitimately omitted this parameter now send invalid requests."
  }),
  PARAMETER_MADE_OPTIONAL: rule({
    kind: "parameter",
    title: "Parameter made optional",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Callers that always sent the parameter remain valid; the constraint was relaxed."
  }),
  PARAMETER_LOCATION_CHANGED: rule({
    kind: "parameter",
    title: "Parameter location changed",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "A parameter moved between query, path, header or cookie, so existing requests place it incorrectly."
  }),
  PARAMETER_DEPRECATED: rule({
    kind: "parameter",
    title: "Parameter deprecated",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Deprecation is advisory; the parameter is still accepted."
  }),

  // -------------------------------------------------------------------------
  // Request bodies
  // -------------------------------------------------------------------------
  REQUIRED_REQUEST_BODY_ADDED: rule({
    kind: "requestBody",
    title: "Required request body added",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "The operation previously accepted no body and now requires one."
  }),
  OPTIONAL_REQUEST_BODY_ADDED: rule({
    kind: "requestBody",
    title: "Optional request body added",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Existing callers may continue to send no body."
  }),
  REQUEST_BODY_REMOVED: rule({
    kind: "requestBody",
    title: "Request body removed",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "The operation no longer declares a body. Servers typically ignore one that is still sent, but the data the caller was providing is now discarded.",
    limitations: "Whether an undeclared body is ignored or rejected is a server implementation detail."
  }),
  REQUEST_BODY_MADE_REQUIRED: rule({
    kind: "requestBody",
    title: "Request body made required",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Callers that omitted the optional body now send invalid requests."
  }),
  REQUEST_BODY_MADE_OPTIONAL: rule({
    kind: "requestBody",
    title: "Request body made optional",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Callers that always sent a body remain valid."
  }),
  REQUEST_MEDIA_TYPE_REMOVED: rule({
    kind: "requestBody",
    title: "Request media type removed",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Callers sending this Content-Type now receive 415 Unsupported Media Type."
  }),
  REQUEST_MEDIA_TYPE_ADDED: rule({
    kind: "requestBody",
    title: "Request media type added",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "An additional accepted Content-Type does not invalidate the existing one."
  }),

  // -------------------------------------------------------------------------
  // Responses
  // -------------------------------------------------------------------------
  SUCCESS_RESPONSE_REMOVED: rule({
    kind: "response",
    title: "Success response removed",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "A 2xx response the client depends on is no longer produced by this operation."
  }),
  RESPONSE_REMOVED: rule({
    kind: "response",
    title: "Non-success response removed",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Clients with a handler for this status code will never reach it. Nothing fails at runtime, but error handling becomes dead code.",
    limitations: "Undocumented status codes may still be returned by the server."
  }),
  RESPONSE_ADDED: rule({
    kind: "response",
    title: "Response status added",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Clients that switch exhaustively on status code, or that treat undocumented codes as errors, must handle the new one.",
    limitations: "Tolerant clients with a default branch are unaffected."
  }),
  RESPONSE_MEDIA_TYPE_REMOVED: rule({
    kind: "response",
    title: "Response media type removed",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Clients requesting or parsing this Content-Type no longer receive it."
  }),
  RESPONSE_MEDIA_TYPE_ADDED: rule({
    kind: "response",
    title: "Response media type added",
    severity: { default: "NON_BREAKING" },
    confidence: "MEDIUM",
    rationale: "Content negotiation keeps returning the previously supported type to existing clients."
  }),

  // -------------------------------------------------------------------------
  // Schema: presence
  // -------------------------------------------------------------------------
  PROPERTY_REMOVED: rule({
    kind: "schema",
    title: "Property removed",
    severity: { request: "CONDITIONAL", response: "BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "In a response, code that reads this property now reads undefined. In a request, the server no longer declares it, so a value that is still sent is normally ignored and silently loses effect.",
    limitations: "For requests, whether an undeclared property is ignored or rejected depends on the server."
  }),
  PROPERTY_REMOVED_FROM_CLOSED_OBJECT: rule({
    kind: "schema",
    title: "Property removed from an object that forbids extra properties",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "The object sets additionalProperties: false, so a request that still sends the removed property is rejected by validation."
  }),
  PROPERTY_ADDED: rule({
    kind: "schema",
    title: "Optional property added",
    severity: { request: "NON_BREAKING", response: "NON_BREAKING", default: "NON_BREAKING" },
    confidence: "MEDIUM",
    rationale:
      "Requests may continue to omit an optional property, and clients reading a response simply ignore fields they do not know about.",
    limitations:
      "A client generated with exhaustive object validation, or one that round-trips a response back as a request, may still need updating."
  }),
  REQUIRED_PROPERTY_ADDED: rule({
    kind: "schema",
    title: "Required property added",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "A request must now carry a property existing callers never sent. In a response the same change only adds a guarantee, which no reader can be broken by."
  }),
  PROPERTY_MADE_REQUIRED: rule({
    kind: "schema",
    title: "Property made required",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "Requests that omitted the property are now invalid. In a response, a property that is always present is strictly more useful than one that is sometimes present."
  }),
  PROPERTY_MADE_OPTIONAL: rule({
    kind: "schema",
    title: "Property made optional",
    severity: { request: "NON_BREAKING", response: "BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "Requests that always sent it remain valid. In a response, code that assumed the property was always present can now read undefined."
  }),

  // -------------------------------------------------------------------------
  // Schema: types
  // -------------------------------------------------------------------------
  TYPE_CHANGED: rule({
    kind: "schema",
    title: "Type changed incompatibly",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "The old and new type sets are disjoint, so no existing value or reader remains valid."
  }),
  TYPE_NARROWED: rule({
    kind: "schema",
    title: "Type narrowed",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "The accepted type set shrank. A request may now send a type the server rejects; a response simply returns fewer shapes than the client already handles."
  }),
  TYPE_WIDENED: rule({
    kind: "schema",
    title: "Type widened",
    severity: { request: "NON_BREAKING", response: "BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "The type set grew. A request that was valid stays valid; a response may now be a type the client has no code path for."
  }),
  FORMAT_ADDED: rule({
    kind: "schema",
    title: "Format constraint added",
    severity: { request: "CONDITIONAL", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Servers commonly validate formats, and code generators map them to distinct types (date-time to Date, int64 to bigint), so both sides may need changes.",
    limitations: "format is advisory in JSON Schema; enforcement depends on the server and the generator."
  }),
  FORMAT_REMOVED: rule({
    kind: "schema",
    title: "Format constraint removed",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Sending a value that still matches the old format stays valid, but a generated response type may lose its narrowed representation.",
    limitations: "format is advisory in JSON Schema."
  }),
  FORMAT_CHANGED: rule({
    kind: "schema",
    title: "Format changed",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale: "The value representation changed, which affects generated types and any parsing the client performs.",
    limitations: "format is advisory in JSON Schema; the practical impact depends on the generator."
  }),
  NULLABLE_ADDED: rule({
    kind: "schema",
    title: "Value may now be null",
    severity: { request: "NON_BREAKING", response: "BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "A request that never sent null remains valid. A response that can now be null breaks readers that do not check."
  }),
  NULLABLE_REMOVED: rule({
    kind: "schema",
    title: "Value may no longer be null",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Requests that sent null are now rejected. Responses that never return null cannot break a reader."
  }),

  // -------------------------------------------------------------------------
  // Schema: enums
  // -------------------------------------------------------------------------
  ENUM_VALUE_REMOVED: rule({
    kind: "schema",
    title: "Enum value removed",
    severity: { request: "BREAKING", response: "CONDITIONAL", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "A request sending the removed value is now rejected. On the response side nothing fails at runtime, but a regenerated union type no longer contains the value, so exhaustive handling of it stops compiling.",
    limitations: "The response-side impact only materialises when client types are regenerated from the specification."
  }),
  ENUM_VALUE_ADDED: rule({
    kind: "schema",
    title: "Enum value added",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Requests may keep sending the values they already send. A response may now carry a value that exhaustive client handling does not cover.",
    limitations: "Clients with a default branch are unaffected; Tern cannot see that from the specification."
  }),
  ENUM_CONSTRAINT_ADDED: rule({
    kind: "schema",
    title: "Enum constraint introduced",
    severity: { request: "BREAKING", response: "CONDITIONAL", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "The value was previously unconstrained. Requests carrying anything outside the new enum are now rejected; responses become a narrower union than the client's type."
  }),
  ENUM_CONSTRAINT_REMOVED: rule({
    kind: "schema",
    title: "Enum constraint removed",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Requests remain valid because the constraint was relaxed. Responses may now carry values outside the union the client was generated against."
  }),

  // -------------------------------------------------------------------------
  // Schema: constraints
  // -------------------------------------------------------------------------
  ADDITIONAL_PROPERTIES_RESTRICTED: rule({
    kind: "schema",
    title: "Additional properties forbidden",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale:
      "Requests carrying any property not declared in the schema are now rejected. Responses simply carry fewer fields."
  }),
  ADDITIONAL_PROPERTIES_RELAXED: rule({
    kind: "schema",
    title: "Additional properties allowed",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Requests gain freedom. Responses may now include undeclared fields, which strict client-side validation can reject."
  }),
  NUMERIC_RANGE_NARROWED: rule({
    kind: "schema",
    title: "Numeric range narrowed",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Values existing callers send may fall outside the new bounds. A narrower response range breaks nothing."
  }),
  NUMERIC_RANGE_WIDENED: rule({
    kind: "schema",
    title: "Numeric range widened",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "Requests remain valid. Responses may now carry values outside the range the client validates or stores.",
    limitations: "Whether a client enforces response ranges is not visible in the specification."
  }),
  LENGTH_RANGE_NARROWED: rule({
    kind: "schema",
    title: "String length range narrowed",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Strings existing callers send may now be too long or too short."
  }),
  LENGTH_RANGE_WIDENED: rule({
    kind: "schema",
    title: "String length range widened",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale: "Requests remain valid. Responses may now carry longer strings than a client allocated for."
  }),
  ITEMS_RANGE_NARROWED: rule({
    kind: "schema",
    title: "Array length range narrowed",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Arrays existing callers send may now contain too many or too few items."
  }),
  ITEMS_RANGE_WIDENED: rule({
    kind: "schema",
    title: "Array length range widened",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale: "Requests remain valid. Responses may now carry more items than the client expects."
  }),
  PATTERN_ADDED: rule({
    kind: "schema",
    title: "Pattern constraint added",
    severity: { request: "BREAKING", response: "CONDITIONAL", default: "BREAKING" },
    confidence: "MEDIUM",
    rationale: "Previously unconstrained request values may not match the new pattern.",
    limitations: "Tern does not evaluate whether real caller values satisfy the pattern."
  }),
  PATTERN_REMOVED: rule({
    kind: "schema",
    title: "Pattern constraint removed",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale: "Requests gain freedom; responses may now carry values the client's parsing assumed away."
  }),
  PATTERN_CHANGED: rule({
    kind: "schema",
    title: "Pattern changed",
    severity: { default: "CONDITIONAL" },
    confidence: "LOW",
    rationale: "The set of accepted strings changed in a way Tern does not attempt to compute.",
    limitations:
      "Deciding whether one regular language contains another is not attempted; the change is reported without a compatibility verdict."
  }),
  DEFAULT_CHANGED: rule({
    kind: "schema",
    title: "Default value changed",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale: "Callers that omit the value now get different behaviour from the server.",
    limitations: "Only affects callers that rely on the server-side default."
  }),
  READ_ONLY_ADDED: rule({
    kind: "schema",
    title: "Property became read-only",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "MEDIUM",
    rationale: "The property may no longer be sent in a request body.",
    limitations: "Enforcement of readOnly depends on the server."
  }),
  READ_ONLY_REMOVED: rule({
    kind: "schema",
    title: "Property no longer read-only",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "A property that may now also be written does not invalidate existing requests or responses."
  }),
  WRITE_ONLY_ADDED: rule({
    kind: "schema",
    title: "Property became write-only",
    severity: { request: "NON_BREAKING", response: "BREAKING", default: "BREAKING" },
    confidence: "MEDIUM",
    rationale: "The property is no longer returned in responses, so readers now see undefined.",
    limitations: "Enforcement of writeOnly depends on the server."
  }),
  WRITE_ONLY_REMOVED: rule({
    kind: "schema",
    title: "Property no longer write-only",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "A property that is now also readable does not invalidate existing code."
  }),

  // -------------------------------------------------------------------------
  // Schema: composition
  // -------------------------------------------------------------------------
  COMPOSITION_MEMBER_ADDED: rule({
    kind: "schema",
    title: "oneOf/anyOf member added",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "LOW",
    rationale:
      "The union grew. Requests may keep sending an existing variant; responses may now be a variant the client cannot handle.",
    limitations: "Members are matched by reference identity and position, not by structural equivalence."
  }),
  COMPOSITION_MEMBER_REMOVED: rule({
    kind: "schema",
    title: "oneOf/anyOf member removed",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "LOW",
    rationale: "The union shrank. A request sending the removed variant is now rejected.",
    limitations: "Members are matched by reference identity and position, not by structural equivalence."
  }),
  ALL_OF_MEMBER_ADDED: rule({
    kind: "schema",
    title: "allOf member added",
    severity: { request: "BREAKING", response: "NON_BREAKING", default: "BREAKING" },
    confidence: "LOW",
    rationale: "allOf is an intersection, so an extra member adds constraints a request must now also satisfy.",
    limitations: "Only reported when the allOf members cannot be merged into a single object view."
  }),
  ALL_OF_MEMBER_REMOVED: rule({
    kind: "schema",
    title: "allOf member removed",
    severity: { request: "NON_BREAKING", response: "CONDITIONAL", default: "CONDITIONAL" },
    confidence: "LOW",
    rationale: "Constraints were dropped, so requests gain freedom while responses lose guarantees.",
    limitations: "Only reported when the allOf members cannot be merged into a single object view."
  }),
  COMPOSITION_KEYWORD_CHANGED: rule({
    kind: "schema",
    title: "Composition keyword changed",
    severity: { default: "UNKNOWN" },
    confidence: "UNKNOWN",
    rationale: "The schema switched between oneOf, anyOf and allOf, which changes its meaning fundamentally.",
    limitations: "Tern does not attempt to prove compatibility across a change of composition keyword."
  }),

  // -------------------------------------------------------------------------
  // Unsupported
  // -------------------------------------------------------------------------
  UNSUPPORTED_CONSTRUCT_CHANGED: rule({
    kind: "schema",
    title: "Change inside an unsupported construct",
    severity: { default: "UNKNOWN" },
    confidence: "UNKNOWN",
    rationale:
      "The schema uses a keyword Tern does not analyse, so no compatibility claim is made for the change.",
    limitations: "Review this change manually."
  }),
  EXTERNAL_REFERENCE_CHANGED: rule({
    kind: "schema",
    title: "External reference changed",
    severity: { default: "UNKNOWN" },
    confidence: "UNKNOWN",
    rationale:
      "The schema points at a document outside the specification. Tern never fetches external references, so the target cannot be compared.",
    limitations: "Inline the referenced schema to have it analysed."
  }),

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------
  COMPONENT_SCHEMA_REMOVED: rule({
    kind: "component",
    title: "Component schema removed",
    severity: { default: "CONDITIONAL" },
    confidence: "MEDIUM",
    rationale:
      "A named model disappears from generated clients. Operations that used it report their own changes separately.",
    limitations: "Only matters for repositories that import the generated model type."
  }),
  COMPONENT_SCHEMA_ADDED: rule({
    kind: "component",
    title: "Component schema added",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "A new named model cannot invalidate existing code."
  }),

  // -------------------------------------------------------------------------
  // Document
  // -------------------------------------------------------------------------
  SERVER_URL_CHANGED: rule({
    kind: "document",
    title: "Server URL changed",
    severity: { default: "CONDITIONAL" },
    confidence: "HIGH",
    rationale:
      "Clients that take their base URL from the specification must be reconfigured; clients with an explicitly configured base URL are unaffected.",
    limitations: "Tern cannot tell from the specification how the base URL reaches the client."
  }),
  SERVER_ADDED: rule({
    kind: "document",
    title: "Server added",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "An additional server entry does not invalidate the existing one."
  }),
  SERVER_REMOVED: rule({
    kind: "document",
    title: "Server removed",
    severity: { default: "CONDITIONAL" },
    confidence: "HIGH",
    rationale: "Clients pointed at the removed server must be reconfigured."
  }),
  SECURITY_REQUIREMENT_ADDED: rule({
    kind: "document",
    title: "Security requirement added",
    severity: { default: "BREAKING" },
    confidence: "HIGH",
    rationale: "Requests without the new credentials are rejected."
  }),
  SECURITY_REQUIREMENT_REMOVED: rule({
    kind: "document",
    title: "Security requirement removed",
    severity: { default: "NON_BREAKING" },
    confidence: "HIGH",
    rationale: "Requests that still present credentials remain acceptable."
  }),
  SECURITY_REQUIREMENT_CHANGED: rule({
    kind: "document",
    title: "Security requirement changed",
    severity: { default: "BREAKING" },
    confidence: "MEDIUM",
    rationale: "The accepted credential set changed, so existing clients may no longer authenticate.",
    limitations: "Tern does not model whether the old and new schemes overlap."
  })
} as const satisfies Record<string, RuleDefinition>;

export type RuleId = keyof typeof RULE_CATALOG;

export const RULE_IDS = Object.keys(RULE_CATALOG).sort() as RuleId[];

export function getRule(id: RuleId): RuleDefinition {
  return RULE_CATALOG[id];
}

/** Resolve the severity a rule assigns for a given compatibility direction. */
export function severityFor(id: RuleId, direction: Direction): Severity {
  const definition = RULE_CATALOG[id];
  const table = definition.severity as Partial<Record<Direction, Severity>> & { default: Severity };
  return table[direction] ?? table.default;
}
