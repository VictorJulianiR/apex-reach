# Validation results

Validation was run on 3 August 2026 with `apex-reach` 0.1.0. Repository clones and generated reports live under the ignored `validation/` directory so they do not become product dependencies.

## Automated fixtures

Five integration tests exercise:

- trigger-to-handler and internal method reachability;
- production, test-only, and unreachable classifications;
- exact LWC Apex imports;
- class references stored in Custom Metadata;
- computed `Type.forName` risk and confidence reduction;
- exclusion of `@isTest` source from the production footprint;
- Markdown report generation.

Result: 5/5 passed.

## trailheadapps/apex-recipes

- 142 Apex files;
- 628,433 raw source characters;
- 905 symbols;
- 0 parse diagnostics;
- completed in approximately 1.5 seconds;
- 1 top-level recovery candidate and 21 member candidates.

The sole top-level candidate was `SchemaRecipes`, which has no code or supported metadata reference in that repository beyond its declaration and generated documentation. This is a plausible review candidate, not ground truth.

## SalesforceFoundation/NPSP

- 1,061 Apex files;
- 14,669,238 raw source characters / 14,669,471 UTF-8 bytes;
- 14,098 symbols;
- 141,573 resolved reference edges before report compaction;
- 0 parse diagnostics;
- completed in approximately 19.4 seconds;
- 5 top-level recovery candidates representing 21,699 raw characters;
- 445 member candidates.

The first run exposed two false-positive sources: static field access and Apex implementation names stored in Custom Metadata. Adding those resolvers reduced top-level candidates from 14 to 5. The remaining five are all low-confidence because the repository contains computed dynamic type loading and the types are externally callable. They require manual/org validation.

The standard evidence report stored 20,908 relevant edges and was about 43.9 MB as pretty JSON. `--no-pretty` reduces serialization overhead; `--full-graph` is intentionally opt-in.

## What this validates

- The parser accepts large, varied, production-grade Apex without syntax loss in the selected corpora.
- The graph fits comfortably in a local Node process for a ~14.7 MB raw Apex repository.
- Cross-language and configuration resolvers materially reduce false positives.
- Confidence and uncertainty are necessary: public repositories do not supply ground truth for dead code, and dynamic/configured entry points remain real.

## What it does not validate

- Precision or recall against a labeled enterprise dataset.
- Exact Salesforce org code allocation.
- Org-only metadata, active scheduled jobs, queued work, or external consumers.
- Eight million lines at once. NPSP is a useful scale signal, not a substitute for a benchmark on the client's hardware and repository shape.

A controlled mutation suite and optional Tooling API enrichment are the next steps for quantitative precision/recall and deployed-org reconciliation.
