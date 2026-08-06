# 0001: Evidence-first static analysis

## Status

Accepted

## Context

The tool must analyze code that cannot be sent to a hosted model, may contain millions of Apex lines, and will support deletion decisions near the org Apex limit. A lexical search is fast but misclassifies overloaded methods, inheritance, metadata entry points, and dynamic dispatch. A fully semantic compiler is more precise but operationally heavy and still cannot observe references that exist only in an org or external integration.

## Decision

Build a deterministic local pipeline around an Apex parse tree and a repository-wide symbol/reference graph. The report declares a closed-world repository universe: all deployable Apex and calling metadata are assumed present in the SFDX package directories. Every non-test symbol receives exactly one binary reachability classification in that universe. The stable external interface is one analysis operation that accepts a project path and returns a versioned report model; CLI formats are adapters over that model. An LLM may summarize the report but is never part of classification.

Treat triggers and concrete Apex/metadata references as entry-point evidence. Annotations, visibility, webservices, and declared platform interfaces are exposure signals, not evidence that a call exists. Scan every text metadata file, using format-aware resolution for supported formats and conservative exact-name resolution for the rest. Keep unresolved and dynamic references as explicit analysis blockers with locations instead of turning them into candidate confidence.

A `Type.forName` value read from Custom Metadata is resolved only when the Apex variable is initialized by SOQL from a concrete `__mdt` type and the referenced field is materialized by versioned Custom Metadata records. Those record values already create exact metadata-to-type entry points. A typed parameter or an unversioned field is insufficient and remains blocked.

## Consequences

- Analysis is reproducible, reviewable, and safe to run entirely on a client machine.
- The report remains useful without an LLM and can feed later report-generation layers.
- Precision improves incrementally by adding resolvers without changing the public analysis interface.
- Candidate classification is reproducible and probability-free within the declared repository universe.
- If a construct prevents a complete conclusion, the whole analysis is visibly blocked until that construct is resolved; unrelated candidates are not downgraded.
- External callers are explicitly outside the repository result and remain visible as exposure signals.
