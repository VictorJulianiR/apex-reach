# Deterministic Apex duplication and Flow-conversion analysis

## Executive conclusions

1. **Record-triggered Flow does not consume the org's 6 MB Apex-code allowance.** Salesforce defines that allowance as the "Maximum amount of code used by all Apex code in an org" and defines its units in terms of Apex classes and triggers; `@isTest` Apex and namespaced managed-package Apex are explicit exceptions. Flow is a separate Metadata API type with separate quotas. Salesforce does not publish the literal sentence "Flow is excluded from the Apex limit", so this is a direct scope inference from the definitions—not a probabilistic claim. Replacing class/trigger source with Flow metadata reduces the Apex-code utilization shown by the org. ([Salesforce Developer Limits, “Size-Specific Apex Limits”](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf), [Salesforce support: Apex code character limit](https://help.salesforce.com/s/articleView?id=000382172&language=en_US&type=1), [Metadata Coverage: Flow](https://developer.salesforce.com/docs/metadata-coverage/64))
2. **Duplication must not be one fuzzy score.** The tool should emit deterministic evidence classes: exact token clone, parameterized AST clone, bounded near-miss clone, SOQL query family, and DML/domain-pattern family. The same repository and configuration must always produce the same families, spans, fingerprints, and measured similarity. The clone taxonomy is established in the primary literature; different detection techniques cover different clone types. ([Roy, Cordy, and Koschke, 2009](https://research.cs.queensu.ca/home/cordy/Papers/RCK_SCP_Clones.pdf))
3. **“Duplicate coverage” is measurable; “bytes that a future refactoring will save” is not the same fact.** The exact union of duplicate source spans can be counted without double counting. An extraction can add parameters, methods, classes, and branching, so the report must not present duplicate span size as guaranteed Apex reduction.
4. **A Flow migration candidate can be binary.** Emit `eligible` only when the entire reachable trigger path maps to supported Flow semantics and every order, transaction, bulk, recursion, error, and security gate passes. Otherwise emit `ineligible` with exact blockers. No probability is needed.
5. **Capacity reclamation is artifact-based.** A convertible method path reclaims Apex characters only when the reverse-reference graph proves that a class or trigger can be removed, or when a specific source rewrite proves that the artifact shrinks. Salesforce measures Apex source artifacts, not the amount of business logic conceptually moved.

## 1. Measurement contract

The analyzer should keep four numbers separate:

- `unreachable_apex_characters`: production Apex source with no repository entry path, under the existing closed-world contract;
- `duplicate_coverage_characters`: the global union of production source intervals participating in one or more accepted clone families;
- `redundant_occurrence_characters`: deterministic non-overlapping attribution of all accepted occurrences except one retained representative per family;
- `flow_reclaimable_apex_characters`: characters in Apex artifacts proven removable after all eligible paths are converted and reverse references are recomputed.

Only the first and fourth numbers directly describe reclaiming the 6 MB limit. The second and third describe refactoring opportunity. They must not be added together unless their source intervals are globally unioned and the report states exactly which hypothetical changes are assumed.

Every finding should contain:

- a stable family ID derived from the normalized representation and tool schema version;
- evidence class (`exact-token`, `parameterized-ast`, `near-miss-ast`, `soql-family`, `dml-pattern`, or `flow-eligible`);
- every file/span and its raw and normalized sizes;
- the normalization profile and all preserved/differing semantics;
- measured similarity where applicable (a measurement, not confidence);
- exclusions applied;
- deterministic blockers;
- overlap attribution and the representative occurrence retained;
- remediation target, without claiming that the remediation has already saved Apex characters.

## 2. Full duplicate-detection design

### 2.1 Corpus and exclusions

Analyze all parseable `.cls` and `.trigger` files in SFDX package directories, then classify results into production, test, generated, and explicitly excluded scopes.

- Exclude `@isTest` classes from the **capacity/redundancy headline**, because Salesforce explicitly excludes them from the org Apex-code allowance. Analyze their duplication in a separate test-maintainability section. ([Salesforce Developer Limits](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf))
- Do not silently exclude a file merely because a comment says “generated.” Salesforce explicitly exempts **Dynamic Apex Classes**, but ordinary generated Apex source can still be an Apex artifact. Generated-source patterns should therefore be configuration-backed, separately inventoried, and visible in the report. ([Salesforce: Manage Apex Classes](https://help.salesforce.com/s/articleView?id=platform.code_manage_packages.htm&language=en_US&type=5))
- Exclude fixtures, vendored source, and copied package sources only through explicit path/package rules printed in the report. Salesforce Code Analyzer similarly supports explicit workspace targeting and ignore configuration. ([Salesforce Code Analyzer CLI](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/analyze.html), [suppression/ignore configuration](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/suppress-violations.html))
- A parse or tokenization failure reduces analyzed coverage. PMD warns that a lexing failure means no duplications are reported for the entire affected file and therefore creates false negatives. The report should be `blocked` for a complete duplication conclusion until every production file is parsed or explicitly excluded. ([PMD CPD documentation](https://docs.pmd-code.org/latest/pmd_userdocs_cpd.html#exit-status))

### 2.2 Lane A: exact token clones (Type 1 baseline)

Tokenize Apex while discarding whitespace and comments but preserving keywords, identifiers, literals, operators, SObject names, and field names. Find maximal repeated token sequences with a suffix array/suffix automaton or indexed token shingles followed by exact extension. Emit clone families, not an uncontrolled Cartesian list of pairs.

Use multiple deterministic minimums rather than one large threshold:

- statement/block clone: at least 40 tokens and at least 4 executable statements;
- method clone: entire normalized method body, at least 25 tokens;
- large clone: at least 100 tokens, compatible with the Salesforce/PMD default baseline.

The 40/25 values are product defaults to catch short, valuable Apex duplication; they are not academic universal thresholds. Salesforce Code Analyzer's CPD engine supports Apex and defaults to 100 minimum tokens. It reports files and locations for each duplicate block. ([Salesforce Code Analyzer CPD](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/engine-cpd.html))

PMD CPD is a strong **validation oracle for this lane**, not the whole solution. PMD's identifier/literal normalization flags apply only to the languages listed in its option table, not Apex; its default behavior is identical-token detection. ([PMD CPD options](https://docs.pmd-code.org/latest/pmd_userdocs_cpd.html#cli-options-reference))

### 2.3 Lane B: parameterized AST clones (Type 2)

Create a canonical AST for each method, constructor, trigger block, and sufficiently large statement subtree. Produce two explicit profiles:

1. `binding-normalized`: rename local variables and parameters by declaration order and scope (`p1`, `v1`, `v2`), normalize harmless parentheses and formatting, and preserve literal values;
2. `shape-normalized`: apply the same binding normalization and replace literals with typed placeholders (`STRING`, `INTEGER`, `DATE`, and so on).

Preserve names whose differences can change platform behavior:

- invoked external method/type names;
- SObject and field API names;
- annotations, modifiers, sharing declaration, trigger events, and interface implementations;
- DML operation/mode and `Database.*` options;
- SOQL object, field, operator, security/access-mode, aggregate, ordering, locking, and cardinality semantics;
- exception types and catch/finally structure.

Local names can be normalized only after symbol binding; a text replacement can conflate shadowed variables or rename API symbols. Type-2 clones are precisely the class of syntactically identical fragments that allow systematic differences in identifiers/literals/types, while Type-3 permits further statement edits. ([Roy, Cordy, and Koschke, clone taxonomy and transformation scenarios](https://research.cs.queensu.ca/home/cordy/Papers/RCK_SCP_Clones.pdf))

Hash canonical subtrees bottom-up. Equal hashes under a named profile form a deterministic parameterized family. The report must show the parameter map and literal differences, not just a score.

### 2.4 Lane C: bounded near-miss AST clones (Type 3)

Near-miss detection should be broad but bounded:

1. Generate candidates from statement-kind shingles, normalized subtree hashes, and method-level features (control-flow shape, call multiset, query/DML signature). Use MinHash/LSH or an inverted index only as an acceleration mechanism.
2. Verify every candidate with an exact deterministic alignment of normalized statement sequences and AST subtrees.
3. Report the exact edit script: inserted, deleted, replaced, or moved statements.

Recommended initial acceptance profiles:

- `near-strong`: at least 8 statements or 80 tokens, at least 85% weighted AST similarity, no changed DML target/mode, trigger event, security mode, or exception boundary;
- `near-broad`: at least 12 statements or 120 tokens, at least 70% weighted AST similarity, emitted as a refactoring candidate with a complete semantic difference vector.

These thresholds are versioned tool policy, not confidence. A finding is deterministically inside or outside the profile. Roy, Cordy, and Koschke show why token, AST, and other techniques have distinct coverage across Type-1 through Type-4 scenarios; the tool should not label general semantic equivalence as proven merely because two methods look similar. ([primary comparison study](https://research.cs.queensu.ca/home/cordy/Papers/RCK_SCP_Clones.pdf))

### 2.5 Lane D: SOQL query-family and selector opportunities

Parse every static SOQL expression and constant-fold dynamic SOQL only when all string components are repository-known. An unresolved dynamic query is a **coverage blocker for the query-family metric**, with its file and line; it must not silently lower the count.

Build two canonical signatures:

**Strict query signature**

- query kind and root SObject;
- recursively normalized select expressions/subqueries;
- exact field and relationship paths;
- canonical Boolean predicate tree, with `AND`/`OR` children sorted only where the language semantics are side-effect free;
- exact operators, literal values, bind types/cardinality, aggregate/group/having, order/null ordering, limit/offset, locking/tracking clauses;
- access/security mode (`USER_MODE`, `SYSTEM_MODE`, `WITH SECURITY_ENFORCED`, or absent);
- enclosing Apex sharing declaration and return cardinality (single SObject, list, aggregate result, count).

**Selector-family signature**

- preserve root SObject, query/access mode, sharing context, aggregate/cardinality, subquery structure, predicates and operational clauses;
- normalize bind variable names and values to typed slots;
- keep the selected field set as a comparable dimension instead of requiring equality.

Then emit deterministic classifications:

- `exact-query`: strict signatures equal;
- `same-shape-query`: selector signatures equal but bind/literal slots differ;
- `selector-consolidation`: same root object and compatible security/cardinality/predicate structure, with exact field-set intersection/union and Jaccard value printed;
- `not-compatible`: same object but a blocking semantic difference (security mode, sharing context, locking, aggregate/cardinality, or incompatible predicate).

Salesforce documents that SOQL access mode changes enforcement—`WITH USER_MODE` enforces object and field permissions, while `WITH SYSTEM_MODE` bypasses them—so these clauses cannot be normalized away. ([Salesforce: Secure Apex Classes](https://developer.salesforce.com/docs/platform/lwc/guide/apex-security))

The selector lane should rank opportunities with facts, for example: number of production call sites, duplicate selected fields, union field count, repeated query executions on the same reachable path, and source characters covered. It should not call two queries “duplicate” merely because they query `Account`.

### 2.6 Lane E: DML and domain-pattern families

For each reachable path, construct a domain fingerprint from:

- trigger object/event/timing and entry conditions;
- ordered call-chain symbols;
- control-flow decisions and loop relationship to input records;
- queried SObjects and query-family IDs;
- DML verb, target SObject, collection/single cardinality, user/system mode, `allOrNone`, partial-result handling, and error path;
- same-record versus related-record mutation;
- enqueue/callout/event/email side effects;
- sharing/security context and recursion guard.

Equal fingerprints are exact domain-pattern duplicates. Compatible fingerprints with a printed difference vector are consolidation opportunities, not semantic duplicates. This lane detects repeated handler/selector/service scaffolding that ordinary CPD misses while preserving Salesforce-specific differences that matter.

### 2.7 Clone families, nesting, and overlap accounting

Clone detectors often return overlapping or nested spans; summing pair sizes inflates the result. Use these rules:

1. Merge equal normalized fingerprints into a family of occurrences.
2. Retain maximal occurrences when two families have the same occurrence set and one is wholly contained in the other.
3. Compute `duplicate_coverage_characters` as the set union of all accepted raw source intervals; each character is counted once globally.
4. Choose one retained representative per family deterministically: production-reachable before unreachable, lower cyclomatic complexity, fewer blockers, then lexical file/span order.
5. Attribute overlapping redundant intervals with a stable precedence: exact-token, parameterized-AST, near-miss-AST, SOQL-family, DML-pattern; within a class, prefer the candidate with greater non-overlapping covered characters and then stable family ID.
6. Publish raw totals, union totals, nested-family count, and overlap discarded. Never add pairwise clone sizes.

`redundant_occurrence_characters` is still an opportunity measure. Do not label it guaranteed Apex savings: a real abstraction has implementation overhead and can preserve multiple variants intentionally.

## 3. Reusing and validating PMD/Salesforce Code Analyzer

Salesforce's first-party Code Analyzer exposes CPD for Apex and emits duplicate locations. Its current defaults are 100 tokens and `.cls`/`.trigger` file extensions. ([Salesforce Code Analyzer CPD](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/engine-cpd.html))

Recommended integration:

- keep the Node analyzer self-contained and offline by default;
- optionally import Code Analyzer/CPD JSON as an independent validation artifact;
- pin and print the Code Analyzer and PMD versions;
- compare Lane A after normalizing file paths and maximal-span boundaries;
- classify differences as threshold, tokenization, lexical error, exclusion, or defect;
- never claim CPD validates the AST/query/domain lanes.

Code Analyzer's CPD/PMD engines require JDK 11 or later, so making them mandatory would violate the current low-friction Node-only installation goal. ([Salesforce Code Analyzer prerequisites](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/analyze.html))

Validation should include:

- committed Apex fixtures for Type-1 whitespace/comment changes, Type-2 renames/literal changes, and Type-3 statement insert/delete/replace scenarios;
- negative fixtures where SObject, field, access mode, `allOrNone`, exception behavior, sharing, or trigger timing differs;
- a mutation/injection suite that transforms valid Apex fragments and checks recall by transformation class, following the primary mutation-based clone-evaluation method rather than relying only on hand-picked positives; ([Roy and Cordy mutation/injection framework](https://research.cs.queensu.ca/home/cordy/Papers/RC_Framework_CSER08.pdf))
- precision review samples stratified by evidence class and size;
- at least one large public Salesforce repository, plus a frozen CPD comparison artifact;
- deterministic rerun tests and memory/runtime benchmarks over millions of lines.

The research literature's benchmark work shows that clone-tool evaluation needs both recall and precision evidence and that a reference corpus can be biased by the tools used to create it. That argues for combining injected known clones, curated negatives, and an independent CPD baseline. ([Bellon et al., 2007](https://doi.org/10.1109/TSE.2007.70725), [Roy and Cordy benchmark retrospective](https://research.cs.queensu.ca/home/cordy/Papers/RC_SANER18_MIP_Retro.pdf))

## 4. Does moving logic to Flow reclaim Apex capacity?

Yes, with one crucial accounting rule.

Salesforce's current org limit is 6 MB for "all Apex code" and excludes `@isTest` Apex plus 1GP/2GP managed-package code in a separate namespace. Flow has its own Metadata API component and its own quotas. Therefore Flow metadata does not occupy that Apex allowance. ([Salesforce Developer Limits](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf), [Flow metadata coverage](https://developer.salesforce.com/docs/metadata-coverage/64))

However:

- converting one method to Flow saves **zero guaranteed Apex characters** if the method remains in a class still needed by other callers;
- deleting a fully unreferenced helper class saves that class's counted source characters;
- deleting or shrinking a trigger saves only the source characters actually removed;
- the tool must recompute reverse production and metadata references after marking paths converted;
- generated Flow XML is not subtracted from the Apex limit, but it should be reported under Flow inventory/limits.

## 5. Separate Flow limits and shared governors

Flow has separate organization and runtime limits. Current general limits include 50 versions per flow; for Enterprise, Unlimited, Performance, and Developer editions, 2,000 active and 4,000 total flows per flow type; a persisted interview limit of about 1 MB; and a 215 MB heap limit per interview. The old 2,000 executed-elements limit was removed beginning with API 57.0. Edition/API differences must be printed rather than assumed. ([Salesforce General Flow Limits](https://help.salesforce.com/s/articleView?id=sf.flow_considerations_limit.htm&language=en_US&type=5))

Synchronous Flow still shares Apex-enforced transaction governors: currently 100 SOQL queries, 50,000 queried rows, 150 DML statements, 10,000 DML rows, and 10 seconds of CPU in the documented transaction. A governor breach rolls back the transaction even when the element has a fault connector. ([Salesforce Per-Transaction Flow Limits](https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit_transaction.htm&language=en_US&type=5))

This means Flow avoids the **static Apex code-size** limit, not the platform's runtime resource model.

## 6. Deterministic trigger-to-Flow eligibility

Analyze each production trigger root as a call/CFG slice ending in assignments, queries, DML, errors, async work, or external side effects. Each slice gets one result:

- `eligible`: every reachable operation maps to a Flow primitive and all gates below pass;
- `ineligible`: at least one exact blocker is present;
- `blocked`: repository parsing/resolution is incomplete, so no conclusion is emitted for that slice.

`blocked` is a coverage state, not low probability.

### 6.1 Conversion targets

| Proven Apex behavior | Flow target | Deterministic condition |
|---|---|---|
| Assign fields on the triggering record in before insert/update | `before-save` / Fast Field Updates | No explicit DML, related-record mutation, unsupported action, or order dependency |
| Create/update/delete related or other records after save | `after-save` / Actions and Related Records | Simple low-density cross-object DML; compatible transaction, error, bulk, recursion, and security semantics |
| Before-delete validation or related action | delete-triggered Flow where supported | Exact delete timing and available record data are sufficient |
| After undelete | none | Record-triggered Flow does not support after-undelete; Apex remains required |
| Fire-and-forget work/callout after successful commit | asynchronous after-save path | A separate-transaction semantic change is acceptable and volume limits are satisfied |

Salesforce says before-save Flow is the correct high-performance option when automation only changes the triggering record; it updates the in-memory record without a second DML/save cycle. The architects' guide describes after-save Flow as suitable for simple, low-complexity cross-object DML, states that invocable Apex isn't available in before-save, and retains Apex for after-undelete and transaction-heavy/complex cases. ([Before-Save Record-Triggered Flows](https://help.salesforce.com/s/articleView?id=platform.flow_concepts_trigger_record.htm&language=en_US), [Salesforce Architects: Record-Triggered Automation](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered))

### 6.2 Order-of-execution gate

Before-save flows execute in a different stage from before Apex triggers, and after-save flows execute after after-trigger processing. Moving one handler can change which values neighboring automations observe or overwrite. Flow ordering values control relative order only among flows in their corresponding before/after group. ([Salesforce Apex order of execution](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm), [Flow trigger order](https://help.salesforce.com/s/articleView?id=platform.flow_task_trigger_run_order.htm&language=en_US&type=5))

An `eligible` result therefore requires one of:

- no other automation reads/writes an intersecting field or object across the moved boundary;
- the whole object's entry mechanism is converted and an equivalent Flow order is generated;
- a dependency proof shows all affected operations commute.

Otherwise emit the exact intersecting fields/objects and stages as an order blocker. Salesforce recommends one entry mechanism per object and warns against mixing Flow and Apex trigger entry points as density grows. ([Salesforce Architects: Record-Triggered Automation](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered))

### 6.3 Bulk and transaction gate

Salesforce creates one Flow interview per input record and automatically bulkifies operations only when interviews reach the **same bulkifiable element**. DML or queries placed inside a single Flow loop aren't automatically consolidated. If one interview hits a governor limit, all interviews in the transaction fail and roll back. ([Flow Bulkification in Transactions](https://help.salesforce.com/s/articleView?id=flow_concepts_bulkification.htm&language=en_US))

Reject automatic conversion when Apex depends on:

- `Database.setSavepoint`, `Database.rollback`, partial commits, or `allOrNone=false` result handling;
- precise per-record `SaveResult`/error recovery not representable by the generated Flow;
- shared static/transaction cache state across entry points;
- Map/Set-heavy joins, advanced algorithms, or high-volume processing where the Flow graph would issue operations per loop iteration;
- transaction boundaries that would change by moving work to an async/scheduled path.

Salesforce's capability matrix explicitly says Flow lacks savepoint/rollback/partial-success transaction control and native Map/Set structures, while Apex offers them. It also recommends Apex for high-density, high-volume, complex, and recursive automation. ([Salesforce Architects: Record-Triggered Automation](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered))

### 6.4 Async and callout gate

An asynchronous Flow path runs after the original transaction commits and is suitable only where that decoupling preserves the business contract. It cannot reproduce synchronous `addError`, rollback, or return-value semantics. Async Flow work also consumes org-wide async allocations and should not be treated as unlimited. ([Salesforce Architects: Record-Triggered Automation](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered), [Salesforce asynchronous fundamentals](https://architect.salesforce.com/docs/architect/fundamentals/guide/async-fundamentals.html))

Reject one-to-one conversion of Batchable, Queueable, Schedulable, `@future`, platform-event/CDC orchestration, chained jobs, or synchronous trigger callouts unless a separately modeled Flow/event design proves equivalent delivery, retry, ordering, and failure behavior.

### 6.5 Recursion gate

After-save DML can re-enter record automation. Flow does not share Apex static state between different triggers or repeated invocations. A static Boolean or processed-ID set is not automatically portable.

An eligible conversion must prove a finite field transition using entry conditions such as “updated to meet conditions” or an exact `$Record` versus `$RecordPrior` predicate. Otherwise report the mutated object/fields and cycle path. Salesforce's architecture guidance recommends field-transition gates for both Apex and Flow to prevent uncontrolled recursion. ([Salesforce Architects: recursion guidance](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered), [record-triggered entry conditions](https://help.salesforce.com/s/articleView?id=platform.automate_flow_build_working_with_conditions_record_triggered_flows.htm&language=en_US&type=5))

### 6.6 Error gate

Flow's Custom Error element can block a save, but Apex `addError()` supports more flexible field-level and conditional messaging. Flow also cannot reproduce savepoint/rollback or partial DML semantics. A governor-limit failure rolls back the whole transaction even if a fault connector exists. ([Salesforce Architects: error and transaction capability matrix](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered), [Per-Transaction Flow Limits](https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit_transaction.htm&language=en_US&type=5))

For eligibility, compare:

- error condition and timing;
- record-level versus field-level target;
- message content dependencies;
- whether partial success is allowed;
- whether caught exceptions continue, compensate, or rethrow;
- every DML/action/subflow fault path.

### 6.7 Security and sharing gate

Record-triggered Flow defaults to **system context without sharing**. User-context Flow enforces profile/permission-set object and field access; system contexts differ in whether sharing is enforced. Apex can also specify sharing declarations and use `USER_MODE`, `SYSTEM_MODE`, `stripInaccessible`, or explicit CRUD/FLS checks. ([Salesforce Flow Run Context](https://help.salesforce.com/s/articleView?id=sf.flow_distribute_context.htm&language=en_US&type=5), [Salesforce: Secure Apex Classes](https://developer.salesforce.com/docs/platform/lwc/guide/apex-security))

Therefore an eligible migration must preserve or deliberately strengthen:

- record sharing behavior;
- object CRUD and field-level security behavior;
- user/system query and DML mode;
- guest/external-user implications;
- any deliberate privileged operation.

If the Apex path is `with sharing`, `inherited sharing`, uses user-mode database operations, or strips inaccessible fields, a default record-triggered Flow is not automatically equivalent. Emit the exact mismatch as a blocker.

### 6.8 Unsupported/complex Apex constructs

Reject automatic conversion when the slice requires semantics without an exact native mapping, including:

- reflection/dynamic type construction or unresolved dynamic dispatch;
- dynamic SOQL that cannot be constant-folded;
- polymorphic Map/Set or graph algorithms;
- savepoints, rollback, partial DML, or custom transaction state;
- Crypto, BusinessHours, or other Apex-only APIs without a proven Flow action equivalent;
- custom serialization, complex exception recovery, or stateful asynchronous jobs;
- locking (`FOR UPDATE`) or concurrency protocol that the generated Flow cannot preserve;
- trigger events unsupported by record-triggered Flow, especially after undelete.

The official architects' matrix identifies Apex as the fit for advanced data structures, standard-library functions, granular transaction control, high automation density, and sophisticated processing. ([Salesforce Architects: Record-Triggered Automation](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered))

## 7. Reporting for leadership without theoretical noise

The executive page can remain small:

1. **Safe deprecation:** Apex characters in repository-unreachable removable artifacts.
2. **Duplicate coverage:** exact union percentage of production Apex, split into exact, parameterized, near-miss, query/selector, and DML/domain families; overlaps counted once.
3. **Flow conversion:** count of `eligible` trigger paths, conversion target, and Apex characters in artifacts proven removable after conversion.
4. **Blocked coverage:** exact files/constructs preventing a complete conclusion.

The detailed appendix supplies evidence per candidate. Avoid “high/medium/low probability.” Use exact states, versioned profiles, measured similarity, and explicit blockers.

## 8. Recommended delivery order for the implementation

This is a full feature, but the implementation can be internally staged without shipping partial claims:

1. shared source interval/normalization/family model and global overlap accounting;
2. exact token lane plus frozen Salesforce Code Analyzer/CPD cross-validation;
3. binding-aware AST canonicalization and parameterized families;
4. verified near-miss alignment and mutation/injection tests;
5. parsed SOQL strict/family signatures and dynamic-query coverage blockers;
6. DML/domain path fingerprints;
7. Flow eligibility gates over the existing reachability graph;
8. artifact-removal simulation and leadership/report schemas;
9. large-repository benchmarks, deterministic reruns, negative-corpus precision review, and documentation.

Do not publish the new executive percentages until all lanes have scope coverage, overlap accounting, deterministic fixtures, and explicit blocked states. That is how the tool remains conclusive even when the answer is smaller than expected.
