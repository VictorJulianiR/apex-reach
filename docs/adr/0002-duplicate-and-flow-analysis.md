# ADR 0002: Separate duplicate evidence from Flow capacity recovery

## Status

Accepted for apex-reach 0.3.0.

## Decision

The report exposes three independent lanes:

1. repository-unreachable Apex that can enter deprecation review;
2. clone, SOQL-selector, and DML/domain families that justify refactoring;
3. trigger paths mechanically eligible for record-triggered Flow.

Clone analysis uses versioned deterministic profiles: exact tokens, identifier/literal-parameterized bodies and fragments, and near-miss candidates verified by ordered token alignment. Source intervals are globally unioned so nested and overlapping families do not inflate leadership percentages. Test Apex is excluded from capacity headlines.

SOQL grouping preserves object, access mode, sharing context, aggregate state, and locking. Static queries and dynamic strings that can be fully constant-folded are analyzed. An unresolved dynamic string blocks selector-family coverage and is printed with its location.

Flow results have only `eligible`, `ineligible`, and `blocked` states. Eligibility requires a fully resolved trigger slice and supported record mutations, DML, order, bulk, transaction, recursion, security, and error behavior. Existing Flow/workflow automation and sibling Apex triggers on the same object prevent automatic order-equivalence claims. Flow metadata is outside the Apex code-size allowance, but capacity is attributed only to Apex artifacts proven removable or shrinkable.

The report records Git branch, commit, and dirty state so two runs can be tied to the exact repository snapshot.

## Consequences

- Percentages from the three lanes are never summed without a global source-interval simulation.
- Clone coverage is explicitly not guaranteed post-refactor savings.
- Similarity is a reproducible measurement, never confidence.
- Unsupported or incomplete evidence produces an exact blocker instead of a probability.
- JSON contains every finding; Markdown prioritizes the first 200 families for readability.
