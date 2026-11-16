import type { NumericConstraints, StringConstraints, ArrayConstraints } from "../model/canonical.js";

/**
 * Compatibility primitives.
 *
 * These functions answer one question: did the set of accepted values grow, shrink,
 * stay the same, or change into something incomparable? That answer is
 * direction-independent. Turning it into "breaking" or "not breaking" is the rule
 * catalog's job, and it depends on whether the value flows into a request or out of
 * a response:
 *
 *   narrowing the accepted set  -> breaks REQUESTS  (a caller's value may be rejected)
 *   widening  the accepted set  -> breaks RESPONSES (a reader may see a new shape)
 *
 * Keeping that single insight in one place is what stops the rule table from
 * degenerating into a pile of special cases.
 */

export type SetRelation = "same" | "narrowed" | "widened" | "changed";

/** JSON Schema type subtyping. The only true subtype relation is integer ⊂ number. */
function isSubtype(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  return candidate === "integer" && parent === "number";
}

/**
 * Compare two type sets.
 *
 * An empty set means "unspecified", which accepts everything, so it is the top type.
 */
export function compareTypeSets(oldTypes: readonly string[], newTypes: readonly string[]): SetRelation {
  const oldUnspecified = oldTypes.length === 0;
  const newUnspecified = newTypes.length === 0;

  if (oldUnspecified && newUnspecified) return "same";
  if (oldUnspecified) return "narrowed";
  if (newUnspecified) return "widened";

  const sameSet =
    oldTypes.length === newTypes.length && oldTypes.every((type, index) => type === newTypes[index]);
  if (sameSet) return "same";

  const newWithinOld = newTypes.every((type) => oldTypes.some((old) => isSubtype(type, old)));
  const oldWithinNew = oldTypes.every((type) => newTypes.some((next) => isSubtype(type, next)));

  if (newWithinOld && oldWithinNew) return "same";
  if (newWithinOld) return "narrowed";
  if (oldWithinNew) return "widened";
  return "changed";
}

/** A lower or upper bound, including whether it is exclusive. */
interface Bound {
  value: number;
  exclusive: boolean;
}

const NO_LOWER: Bound = { value: Number.NEGATIVE_INFINITY, exclusive: false };
const NO_UPPER: Bound = { value: Number.POSITIVE_INFINITY, exclusive: false };

function lowerBound(constraints: NumericConstraints): Bound {
  if (constraints.exclusiveMinimum !== undefined) return { value: constraints.exclusiveMinimum, exclusive: true };
  if (constraints.minimum !== undefined) return { value: constraints.minimum, exclusive: false };
  return NO_LOWER;
}

function upperBound(constraints: NumericConstraints): Bound {
  if (constraints.exclusiveMaximum !== undefined) return { value: constraints.exclusiveMaximum, exclusive: true };
  if (constraints.maximum !== undefined) return { value: constraints.maximum, exclusive: false };
  return NO_UPPER;
}

/** True when `next` admits strictly fewer values at the low end than `previous`. */
function lowerTightened(previous: Bound, next: Bound): boolean {
  if (next.value > previous.value) return true;
  return next.value === previous.value && next.exclusive && !previous.exclusive;
}

function lowerLoosened(previous: Bound, next: Bound): boolean {
  if (next.value < previous.value) return true;
  return next.value === previous.value && !next.exclusive && previous.exclusive;
}

function upperTightened(previous: Bound, next: Bound): boolean {
  if (next.value < previous.value) return true;
  return next.value === previous.value && next.exclusive && !previous.exclusive;
}

function upperLoosened(previous: Bound, next: Bound): boolean {
  if (next.value > previous.value) return true;
  return next.value === previous.value && !next.exclusive && previous.exclusive;
}

export interface RangeDelta {
  narrowed: boolean;
  widened: boolean;
}

/**
 * Compare numeric ranges.
 *
 * Both flags can be set at once: moving a minimum up while moving a maximum up is
 * genuinely both a narrowing and a widening, and reporting only one of them would
 * hide a real incompatibility from one of the two directions.
 */
export function compareNumericRange(previous: NumericConstraints, next: NumericConstraints): RangeDelta {
  const previousLower = lowerBound(previous);
  const previousUpper = upperBound(previous);
  const nextLower = lowerBound(next);
  const nextUpper = upperBound(next);

  const narrowed = lowerTightened(previousLower, nextLower) || upperTightened(previousUpper, nextUpper);
  const widened = lowerLoosened(previousLower, nextLower) || upperLoosened(previousUpper, nextUpper);

  // multipleOf: any change to the divisor restricts a different value set. Adding or
  // changing it narrows; removing it widens.
  if (previous.multipleOf !== next.multipleOf) {
    if (next.multipleOf === undefined) return { narrowed, widened: true };
    if (previous.multipleOf === undefined) return { narrowed: true, widened };
    // A new divisor that is a multiple of the old one narrows; anything else is both.
    const isRefinement = Number.isInteger(next.multipleOf / previous.multipleOf);
    return { narrowed: true, widened: widened || !isRefinement };
  }

  return { narrowed, widened };
}

function compareIntegerRange(
  previousMin: number | undefined,
  previousMax: number | undefined,
  nextMin: number | undefined,
  nextMax: number | undefined
): RangeDelta {
  const pMin = previousMin ?? Number.NEGATIVE_INFINITY;
  const pMax = previousMax ?? Number.POSITIVE_INFINITY;
  const nMin = nextMin ?? Number.NEGATIVE_INFINITY;
  const nMax = nextMax ?? Number.POSITIVE_INFINITY;
  return { narrowed: nMin > pMin || nMax < pMax, widened: nMin < pMin || nMax > pMax };
}

export function compareLengthRange(previous: StringConstraints, next: StringConstraints): RangeDelta {
  return compareIntegerRange(previous.minLength, previous.maxLength, next.minLength, next.maxLength);
}

export function compareItemsRange(previous: ArrayConstraints, next: ArrayConstraints): RangeDelta {
  const range = compareIntegerRange(previous.minItems, previous.maxItems, next.minItems, next.maxItems);
  if (previous.uniqueItems !== next.uniqueItems) {
    // uniqueItems: true restricts the accepted set; removing it relaxes.
    if (next.uniqueItems) return { narrowed: true, widened: range.widened };
    return { narrowed: range.narrowed, widened: true };
  }
  return range;
}

/** Set difference over canonically-ordered enum values. */
export function enumDelta(
  previous: readonly unknown[],
  next: readonly unknown[]
): { removed: unknown[]; added: unknown[] } {
  const encode = (value: unknown) => JSON.stringify(value ?? null);
  const previousKeys = new Set(previous.map(encode));
  const nextKeys = new Set(next.map(encode));
  return {
    removed: previous.filter((value) => !nextKeys.has(encode(value))),
    added: next.filter((value) => !previousKeys.has(encode(value)))
  };
}

/**
 * `additionalProperties` semantics.
 *
 * Absent means permissive in JSON Schema, so `undefined` and `true` are the same
 * value for compatibility purposes and switching between them is not a change.
 */
export type AdditionalPropertiesMode = "open" | "closed" | "schema";

export function additionalPropertiesMode(value: boolean | string | undefined): AdditionalPropertiesMode {
  if (value === false) return "closed";
  if (value === true || value === undefined) return "open";
  return "schema";
}
