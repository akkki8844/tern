<!-- GENERATED FILE — do not edit by hand.
     Source: packages/openapi/src/diff/rules.ts
     Regenerate: npm run docs:rules -w @tern/openapi -->

# Breaking-change rule catalog

Every classification Tern makes comes from exactly one rule below. Severity depends on
**direction**: narrowing what a server accepts breaks *requests*, while widening what a
server returns breaks *responses*, so the same structural edit has two answers.

## Severity

| Value | Meaning |
| --- | --- |
| `BREAKING` | Existing clients stop working. |
| `CONDITIONAL` | Breaks *some* clients. Whether it breaks this repository is what the scanner determines. |
| `NON_BREAKING` | No existing client can be broken by this change. |
| `UNKNOWN` | An unsupported construct is involved; Tern makes no claim. |

## Confidence

Confidence describes the **evidence**, not a probability.

| Value | Meaning |
| --- | --- |
| `HIGH` | An unambiguous local rule over fully analysed data. |
| `MEDIUM` | The rule is sound, but the effect depends on client behaviour Tern cannot observe. |
| `LOW` | Detected structurally; the semantic effect depends on composition Tern models partially. |
| `UNKNOWN` | An unsupported construct is involved. |

## Rules (76)

### Components

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `COMPONENT_SCHEMA_ADDED` | safe | safe | HIGH | A new named model cannot invalidate existing code. |
| `COMPONENT_SCHEMA_REMOVED` | conditional | conditional | MEDIUM | A named model disappears from generated clients. Operations that used it report their own changes separately. |

Known limitations:

- `COMPONENT_SCHEMA_REMOVED` — Only matters for repositories that import the generated model type.

### Document

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `SECURITY_REQUIREMENT_ADDED` | **breaking** | **breaking** | HIGH | Requests without the new credentials are rejected. |
| `SECURITY_REQUIREMENT_CHANGED` | **breaking** | **breaking** | MEDIUM | The accepted credential set changed, so existing clients may no longer authenticate. |
| `SECURITY_REQUIREMENT_REMOVED` | safe | safe | HIGH | Requests that still present credentials remain acceptable. |
| `SERVER_ADDED` | safe | safe | HIGH | An additional server entry does not invalidate the existing one. |
| `SERVER_REMOVED` | conditional | conditional | HIGH | Clients pointed at the removed server must be reconfigured. |
| `SERVER_URL_CHANGED` | conditional | conditional | HIGH | Clients that take their base URL from the specification must be reconfigured; clients with an explicitly configured base URL are unaffected. |

Known limitations:

- `SECURITY_REQUIREMENT_CHANGED` — Tern does not model whether the old and new schemes overlap.
- `SERVER_URL_CHANGED` — Tern cannot tell from the specification how the base URL reaches the client.

### Operations

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `OPERATION_ADDED` | safe | safe | HIGH | A new operation cannot affect calls that were already being made. |
| `OPERATION_DEPRECATED` | safe | safe | HIGH | Deprecation is advisory; the operation still functions. |
| `OPERATION_ID_ADDED` | conditional | conditional | MEDIUM | The operation previously had a generator-derived method name and will now be named after the new operationId. |
| `OPERATION_ID_CHANGED` | conditional | conditional | HIGH | The HTTP contract is unchanged, but generated clients name their methods after operationId, so any repository using a generated SDK must be updated. |
| `OPERATION_ID_REMOVED` | conditional | conditional | MEDIUM | Generators fall back to a name derived from the method and path, so a generated client method is likely to be renamed. |
| `OPERATION_REMOVED` | **breaking** | **breaking** | HIGH | Clients calling this method on this path now receive 404 or 405. |

Known limitations:

- `OPERATION_ID_ADDED` — Only affects repositories using a generated client.
- `OPERATION_ID_CHANGED` — Whether this matters depends on whether the consuming repository uses a generated client.
- `OPERATION_ID_REMOVED` — The replacement name depends on the generator.

### Parameters

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `OPTIONAL_PARAMETER_ADDED` | safe | safe | HIGH | Existing callers may continue to omit an optional parameter. |
| `PARAMETER_DEPRECATED` | safe | safe | HIGH | Deprecation is advisory; the parameter is still accepted. |
| `PARAMETER_LOCATION_CHANGED` | **breaking** | **breaking** | HIGH | A parameter moved between query, path, header or cookie, so existing requests place it incorrectly. |
| `PARAMETER_MADE_OPTIONAL` | safe | safe | HIGH | Callers that always sent the parameter remain valid; the constraint was relaxed. |
| `PARAMETER_MADE_REQUIRED` | **breaking** | **breaking** | HIGH | Callers that legitimately omitted this parameter now send invalid requests. |
| `PARAMETER_REMOVED` | conditional | conditional | MEDIUM | The server no longer declares this parameter. Requests that still send it are usually ignored rather than rejected, but any behaviour the caller relied on silently disappears. |
| `REQUIRED_PARAMETER_ADDED` | **breaking** | **breaking** | HIGH | Existing callers do not send this parameter, so their requests are now invalid. |

Known limitations:

- `PARAMETER_REMOVED` — Whether an undeclared parameter is ignored or rejected is a server implementation detail.

### Paths

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `PATH_ADDED` | safe | safe | HIGH | Existing clients do not call a path that did not previously exist. |
| `PATH_REMOVED` | **breaking** | **breaking** | HIGH | Every existing call to this path now fails; there is no operation left to serve it. |

### Request bodies

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `OPTIONAL_REQUEST_BODY_ADDED` | safe | safe | HIGH | Existing callers may continue to send no body. |
| `REQUEST_BODY_MADE_OPTIONAL` | safe | safe | HIGH | Callers that always sent a body remain valid. |
| `REQUEST_BODY_MADE_REQUIRED` | **breaking** | **breaking** | HIGH | Callers that omitted the optional body now send invalid requests. |
| `REQUEST_BODY_REMOVED` | conditional | conditional | MEDIUM | The operation no longer declares a body. Servers typically ignore one that is still sent, but the data the caller was providing is now discarded. |
| `REQUEST_MEDIA_TYPE_ADDED` | safe | safe | HIGH | An additional accepted Content-Type does not invalidate the existing one. |
| `REQUEST_MEDIA_TYPE_REMOVED` | **breaking** | **breaking** | HIGH | Callers sending this Content-Type now receive 415 Unsupported Media Type. |
| `REQUIRED_REQUEST_BODY_ADDED` | **breaking** | **breaking** | HIGH | The operation previously accepted no body and now requires one. |

Known limitations:

- `REQUEST_BODY_REMOVED` — Whether an undeclared body is ignored or rejected is a server implementation detail.

### Responses

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `RESPONSE_ADDED` | conditional | conditional | MEDIUM | Clients that switch exhaustively on status code, or that treat undocumented codes as errors, must handle the new one. |
| `RESPONSE_MEDIA_TYPE_ADDED` | safe | safe | MEDIUM | Content negotiation keeps returning the previously supported type to existing clients. |
| `RESPONSE_MEDIA_TYPE_REMOVED` | **breaking** | **breaking** | HIGH | Clients requesting or parsing this Content-Type no longer receive it. |
| `RESPONSE_REMOVED` | conditional | conditional | MEDIUM | Clients with a handler for this status code will never reach it. Nothing fails at runtime, but error handling becomes dead code. |
| `SUCCESS_RESPONSE_REMOVED` | **breaking** | **breaking** | HIGH | A 2xx response the client depends on is no longer produced by this operation. |

Known limitations:

- `RESPONSE_ADDED` — Tolerant clients with a default branch are unaffected.
- `RESPONSE_REMOVED` — Undocumented status codes may still be returned by the server.

### Schemas

| Rule | Request | Response | Confidence | Why |
| --- | --- | --- | --- | --- |
| `ADDITIONAL_PROPERTIES_RELAXED` | safe | conditional | MEDIUM | Requests gain freedom. Responses may now include undeclared fields, which strict client-side validation can reject. |
| `ADDITIONAL_PROPERTIES_RESTRICTED` | **breaking** | safe | HIGH | Requests carrying any property not declared in the schema are now rejected. Responses simply carry fewer fields. |
| `ALL_OF_MEMBER_ADDED` | **breaking** | safe | LOW | allOf is an intersection, so an extra member adds constraints a request must now also satisfy. |
| `ALL_OF_MEMBER_REMOVED` | safe | conditional | LOW | Constraints were dropped, so requests gain freedom while responses lose guarantees. |
| `COMPOSITION_KEYWORD_CHANGED` | unknown | unknown | UNKNOWN | The schema switched between oneOf, anyOf and allOf, which changes its meaning fundamentally. |
| `COMPOSITION_MEMBER_ADDED` | safe | conditional | LOW | The union grew. Requests may keep sending an existing variant; responses may now be a variant the client cannot handle. |
| `COMPOSITION_MEMBER_REMOVED` | **breaking** | safe | LOW | The union shrank. A request sending the removed variant is now rejected. |
| `DEFAULT_CHANGED` | conditional | conditional | MEDIUM | Callers that omit the value now get different behaviour from the server. |
| `ENUM_CONSTRAINT_ADDED` | **breaking** | conditional | HIGH | The value was previously unconstrained. Requests carrying anything outside the new enum are now rejected; responses become a narrower union than the client's type. |
| `ENUM_CONSTRAINT_REMOVED` | safe | conditional | MEDIUM | Requests remain valid because the constraint was relaxed. Responses may now carry values outside the union the client was generated against. |
| `ENUM_VALUE_ADDED` | safe | conditional | MEDIUM | Requests may keep sending the values they already send. A response may now carry a value that exhaustive client handling does not cover. |
| `ENUM_VALUE_REMOVED` | **breaking** | conditional | HIGH | A request sending the removed value is now rejected. On the response side nothing fails at runtime, but a regenerated union type no longer contains the value, so exhaustive handling of it stops compiling. |
| `EXTERNAL_REFERENCE_CHANGED` | unknown | unknown | UNKNOWN | The schema points at a document outside the specification. Tern never fetches external references, so the target cannot be compared. |
| `FORMAT_ADDED` | conditional | conditional | MEDIUM | Servers commonly validate formats, and code generators map them to distinct types (date-time to Date, int64 to bigint), so both sides may need changes. |
| `FORMAT_CHANGED` | conditional | conditional | MEDIUM | The value representation changed, which affects generated types and any parsing the client performs. |
| `FORMAT_REMOVED` | safe | conditional | MEDIUM | Sending a value that still matches the old format stays valid, but a generated response type may lose its narrowed representation. |
| `ITEMS_RANGE_NARROWED` | **breaking** | safe | HIGH | Arrays existing callers send may now contain too many or too few items. |
| `ITEMS_RANGE_WIDENED` | safe | conditional | MEDIUM | Requests remain valid. Responses may now carry more items than the client expects. |
| `LENGTH_RANGE_NARROWED` | **breaking** | safe | HIGH | Strings existing callers send may now be too long or too short. |
| `LENGTH_RANGE_WIDENED` | safe | conditional | MEDIUM | Requests remain valid. Responses may now carry longer strings than a client allocated for. |
| `NULLABLE_ADDED` | safe | **breaking** | HIGH | A request that never sent null remains valid. A response that can now be null breaks readers that do not check. |
| `NULLABLE_REMOVED` | **breaking** | safe | HIGH | Requests that sent null are now rejected. Responses that never return null cannot break a reader. |
| `NUMERIC_RANGE_NARROWED` | **breaking** | safe | HIGH | Values existing callers send may fall outside the new bounds. A narrower response range breaks nothing. |
| `NUMERIC_RANGE_WIDENED` | safe | conditional | MEDIUM | Requests remain valid. Responses may now carry values outside the range the client validates or stores. |
| `PATTERN_ADDED` | **breaking** | conditional | MEDIUM | Previously unconstrained request values may not match the new pattern. |
| `PATTERN_CHANGED` | conditional | conditional | LOW | The set of accepted strings changed in a way Tern does not attempt to compute. |
| `PATTERN_REMOVED` | safe | conditional | MEDIUM | Requests gain freedom; responses may now carry values the client's parsing assumed away. |
| `PROPERTY_ADDED` | safe | safe | MEDIUM | Requests may continue to omit an optional property, and clients reading a response simply ignore fields they do not know about. |
| `PROPERTY_MADE_OPTIONAL` | safe | **breaking** | HIGH | Requests that always sent it remain valid. In a response, code that assumed the property was always present can now read undefined. |
| `PROPERTY_MADE_REQUIRED` | **breaking** | safe | HIGH | Requests that omitted the property are now invalid. In a response, a property that is always present is strictly more useful than one that is sometimes present. |
| `PROPERTY_REMOVED` | conditional | **breaking** | HIGH | In a response, code that reads this property now reads undefined. In a request, the server no longer declares it, so a value that is still sent is normally ignored and silently loses effect. |
| `PROPERTY_REMOVED_FROM_CLOSED_OBJECT` | **breaking** | **breaking** | HIGH | The object sets additionalProperties: false, so a request that still sends the removed property is rejected by validation. |
| `READ_ONLY_ADDED` | **breaking** | safe | MEDIUM | The property may no longer be sent in a request body. |
| `READ_ONLY_REMOVED` | safe | safe | HIGH | A property that may now also be written does not invalidate existing requests or responses. |
| `REQUIRED_PROPERTY_ADDED` | **breaking** | safe | HIGH | A request must now carry a property existing callers never sent. In a response the same change only adds a guarantee, which no reader can be broken by. |
| `TYPE_CHANGED` | **breaking** | **breaking** | HIGH | The old and new type sets are disjoint, so no existing value or reader remains valid. |
| `TYPE_NARROWED` | **breaking** | safe | HIGH | The accepted type set shrank. A request may now send a type the server rejects; a response simply returns fewer shapes than the client already handles. |
| `TYPE_WIDENED` | safe | **breaking** | HIGH | The type set grew. A request that was valid stays valid; a response may now be a type the client has no code path for. |
| `UNSUPPORTED_CONSTRUCT_CHANGED` | unknown | unknown | UNKNOWN | The schema uses a keyword Tern does not analyse, so no compatibility claim is made for the change. |
| `WRITE_ONLY_ADDED` | safe | **breaking** | MEDIUM | The property is no longer returned in responses, so readers now see undefined. |
| `WRITE_ONLY_REMOVED` | safe | safe | HIGH | A property that is now also readable does not invalidate existing code. |

Known limitations:

- `ALL_OF_MEMBER_ADDED` — Only reported when the allOf members cannot be merged into a single object view.
- `ALL_OF_MEMBER_REMOVED` — Only reported when the allOf members cannot be merged into a single object view.
- `COMPOSITION_KEYWORD_CHANGED` — Tern does not attempt to prove compatibility across a change of composition keyword.
- `COMPOSITION_MEMBER_ADDED` — Members are matched by reference identity and position, not by structural equivalence.
- `COMPOSITION_MEMBER_REMOVED` — Members are matched by reference identity and position, not by structural equivalence.
- `DEFAULT_CHANGED` — Only affects callers that rely on the server-side default.
- `ENUM_VALUE_ADDED` — Clients with a default branch are unaffected; Tern cannot see that from the specification.
- `ENUM_VALUE_REMOVED` — The response-side impact only materialises when client types are regenerated from the specification.
- `EXTERNAL_REFERENCE_CHANGED` — Inline the referenced schema to have it analysed.
- `FORMAT_ADDED` — format is advisory in JSON Schema; enforcement depends on the server and the generator.
- `FORMAT_CHANGED` — format is advisory in JSON Schema; the practical impact depends on the generator.
- `FORMAT_REMOVED` — format is advisory in JSON Schema.
- `NUMERIC_RANGE_WIDENED` — Whether a client enforces response ranges is not visible in the specification.
- `PATTERN_ADDED` — Tern does not evaluate whether real caller values satisfy the pattern.
- `PATTERN_CHANGED` — Deciding whether one regular language contains another is not attempted; the change is reported without a compatibility verdict.
- `PROPERTY_ADDED` — A client generated with exhaustive object validation, or one that round-trips a response back as a request, may still need updating.
- `PROPERTY_REMOVED` — For requests, whether an undeclared property is ignored or rejected depends on the server.
- `READ_ONLY_ADDED` — Enforcement of readOnly depends on the server.
- `UNSUPPORTED_CONSTRUCT_CHANGED` — Review this change manually.
- `WRITE_ONLY_ADDED` — Enforcement of writeOnly depends on the server.

## Directions

Valid values: `request`, `response`, `both`, `unknown`.

- `request` — the value travels from the client to the server.
- `response` — the value travels from the server to the client.
- `both` — the change is not specific to one direction (an operation was removed).
- `unknown` — the direction could not be determined.

