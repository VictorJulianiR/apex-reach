# 0001: Evidence-first static analysis

## Status

Accepted

## Context

The tool must analyze code that cannot be sent to a hosted model, may contain millions of Apex lines, and will support deletion decisions near the org Apex limit. A lexical search is fast but misclassifies overloaded methods, inheritance, metadata entry points, and dynamic dispatch. A fully semantic compiler is more precise but operationally heavy and still cannot observe references that exist only in an org or external integration.

## Decision

Build a deterministic local pipeline around an Apex parse tree and a repository-wide symbol/reference graph. Every recovery candidate carries confidence, evidence, and explicit uncertainty. The stable external interface is one analysis operation that accepts a project path and returns a versioned report model; CLI formats are adapters over that model. An LLM may summarize the report but is never part of classification.

Treat annotations, triggers, declared platform interfaces, and supported Salesforce metadata as entry-point evidence. Keep unresolved and dynamic references in the report instead of silently treating them as absent.

## Consequences

- Analysis is reproducible, reviewable, and safe to run entirely on a client machine.
- The report remains useful without an LLM and can feed later report-generation layers.
- Precision improves incrementally by adding resolvers without changing the public analysis interface.
- A static result is a recovery candidate, not proof that deletion is safe; org-only metadata and external callers require additional evidence.
