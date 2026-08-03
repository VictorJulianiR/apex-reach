# Offline quality gates for Apex: evidence and recommendations

## Executive conclusion

The literature can materially strengthen the analyzer, but not by producing one universal "quality score". The most defensible design is a portfolio of independently explainable indicators, each with source evidence, combined with repository-specific baselines and a ratchet on new or changed code.

The strongest offline additions are:

1. method-level cyclomatic and cognitive complexity;
2. NCSS/size and nesting as context for complexity;
3. class coupling, cohesion, fan-in/fan-out, and dependency cycles;
4. token-based duplication;
5. version-control churn and co-change hotspots;
6. test-quality evidence beyond coverage, such as assertion presence and mutation testing when an executable Apex environment is available;
7. Apex-specific security, correctness, and governor-limit rules.

Absolute thresholds should initially be labeled **tool defaults**, not universal scientific laws. The product should learn a baseline from the analyzed repository, expose percentiles and trends, and normally fail only regressions or high-confidence critical findings.

## Recommended gate model

### 1. Separate facts, indicators, and decisions

- **Facts:** exact AST counts, graph edges, duplicate token spans, Git revisions, and source locations.
- **Indicators:** complexity, coupling, churn, hotspot rank, duplicate density, and reachability confidence.
- **Decisions:** `pass`, `warn`, `review`, or `fail`, with the policy and threshold printed in the output.

This distinction is important because a metric can help rank code without proving that a particular class is defective. Coleman et al. explicitly described complexity metrics as useful for relative comparisons even when they do not measure a program's inherent complexity ([IEEE, 1994, DOI 10.1109/2.303623](https://doi.org/10.1109/2.303623)).

### 2. Use a ratchet rather than failing the legacy baseline

Suggested default behavior:

- first scan establishes the baseline and does not fail on existing maintainability findings;
- new or changed code must not introduce a critical Apex correctness/security finding, a new dependency cycle, or a material metric regression;
- existing findings fail only when explicitly promoted into the customer's policy;
- show both absolute tool defaults and repository percentiles;
- for metrics without high-confidence universal limits, warn at the repository's size-weighted P90 and require review at P95, then recalibrate after human triage.

This follows empirical threshold research: Alves, Ypma, and Visser found that commonly proposed limits were often based on expert opinion and few observations; their alternative pools representative systems, respects skewed metric distributions, weights by code volume, and is resilient to outliers ([ICSM 2010, DOI 10.1109/ICSM.2010.5609747](https://doi.org/10.1109/ICSM.2010.5609747)). The paper also notes that McCabe's value of 10 came from a particular context and was not intended as universally applicable.

## Metric families and actionable baselines

### Cyclomatic complexity

McCabe defines cyclomatic complexity from a control-flow graph as `V(G) = E - N + 2P`; for a single connected routine it corresponds to the number of linearly independent paths ([McCabe, IEEE TSE 1976, DOI 10.1109/TSE.1976.233837](https://doi.org/10.1109/TSE.1976.233837), [open paper copy](https://www.cs.du.edu/~snarayan/sada/teaching/COMP3705/lecture/p1/mccabe.pdf)). It is therefore useful for branch/test planning and for locating decision-heavy methods. It does not capture nesting or domain difficulty. McCabe described 10 as a reasonable, non-magical limit and allowed judgment for constructs such as a large but structurally simple `case`; this is another reason to preserve contributors and context rather than emit only a number.

PMD's official Apex rule counts decision points plus method entry, reports methods at `>= 10` by default and classes at aggregate complexity `>= 40`; it describes 1–4 as low, 5–7 moderate, 8–10 high, and 11+ very high ([PMD Apex CyclomaticComplexity](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#cyclomaticcomplexity)).

**Recommended initial policy:**

- measure every method and constructor;
- `CC >= 10`: review/warn on existing code and changed code;
- `CC >= 15`: fail only new or materially changed methods until repository calibration exists;
- display class sum and maximum method value, but do not let many simple methods look equivalent to one pathological method;
- record the exact branch constructs contributing to the score.

### Cognitive complexity

SonarSource's specification was designed around understandability: ignore readable shorthand, increment for breaks in linear flow, and increment again for nested flow-breaking structures ([G. Ann Campbell, Cognitive Complexity specification](https://assets-eu-01.kc-usercontent.com/5a869490-919a-0159-3da4-b8c3c397c0bc/39475230-c3ff-4e73-8ab3-fe0c9f21e9dd/Cognitive_Complexity_Sonar_Guide_2023.pdf)). PMD implements it for Apex and defaults to method `>= 15` and class total `>= 50` ([PMD Apex CognitiveComplexity](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#cognitivecomplexity)).

**Recommended initial policy:** method `>= 15` warns; changed code above 15 requires review; fail only regressions or a customer-configured hard ceiling. Cognitive complexity complements rather than replaces cyclomatic complexity: the former emphasizes human nesting burden, while the latter retains a direct control-flow/testing interpretation.

### Size, nesting, parameters, and public surface

PMD's current Apex defaults provide pragmatic bootstrap values:

- NCSS: method `>= 40`, class `>= 500` ([PMD NcssCount](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#ncsscount));
- nested `if` depth: 3 ([PMD AvoidDeeplyNestedIfStmts](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#avoiddeeplynestedifstmts));
- parameters: 4 or more ([PMD ExcessiveParameterList](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#excessiveparameterlist));
- public members: 20 or more ([PMD ExcessivePublicCount](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#excessivepubliccount));
- fields: more than 15 ([PMD TooManyFields](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#toomanyfields)).

Treat these as review triggers, not proof of poor quality. Combine them: a long, high-churn method with high cognitive complexity is much more actionable than length alone.

### Object-oriented and dependency metrics

Chidamber and Kemerer introduced six class metrics: Weighted Methods per Class (WMC), Depth of Inheritance Tree (DIT), Number of Children (NOC), Coupling Between Object classes (CBO), Response For a Class (RFC), and Lack of Cohesion of Methods (LCOM) ([IEEE TSE 1994, DOI 10.1109/32.295895](https://doi.org/10.1109/32.295895)). The original work supplies definitions and theoretical motivation, not universally valid defect cutoffs.

For Apex, prioritize:

- WMC as method count and optionally sum of method complexity;
- CBO/fan-out: distinct classes referenced;
- fan-in: distinct production dependents, already available from the reachability graph;
- RFC: methods locally reachable from a class's public behavior;
- LCOM/cohesion only if the chosen LCOM variant is named and its exact formula is emitted;
- inheritance depth and child count as descriptive indicators, usually less central in Apex than coupling.

Use repository P90/P95 rather than imported fixed limits. Rank combinations such as high CBO + low cohesion + high churn above any single metric.

### Dependency cycles and architectural risk

Compute strongly connected components on the class graph. An empirical study reported cyclically dependent components as more defect-prone and connected cycles with understandability, testability, reusability, buildability, and maintainability problems ([Journal of Systems and Software 2013, DOI 10.1016/j.jss.2013.07.039](https://doi.org/10.1016/j.jss.2013.07.039)). Later research emphasizes that refactoring advice must consider the surrounding design context, not only the internal cycle ([Feng et al., empirical study](https://arxiv.org/abs/2306.10599)).

**Recommended policy:** fail a newly introduced production dependency cycle; report legacy SCC size, members, edge evidence, entry-point reachability, and trend. Do not automatically prescribe deletion or a generic refactoring.

### Duplication

PMD CPD supports Apex and reports token-level clone spans. The token threshold is configurable; PMD's examples use 100 tokens, and CPD returns a distinct violation status suitable for CI ([PMD CPD documentation](https://pmd.github.io/pmd/pmd_userdocs_cpd.html)).

Empirical evidence is nuanced. Juergens et al. found frequent inconsistent clone changes and faults induced by some of them ([ICSE study, open paper](https://citeseerx.ist.psu.edu/document?doi=101ea84e4325384fa6275dbb4bbd5cdebf0ebda2&repid=rep1&type=pdf)). Conversely, Kapser and Godfrey documented intentional, principled cloning patterns and warned that not every clone should be refactored ([DOI 10.1007/s10664-008-9076-6](https://doi.org/10.1007/s10664-008-9076-6), [open paper](https://citeseerx.ist.psu.edu/document?doi=969eaa3f125b0c76abac65bf0ba3fa3a020ce108&repid=rep1&type=pdf)).

**Recommended policy:** start CPD at 100 tokens; report duplicate production NCSS/percentage, clone families, and whether clones co-change. Warn on new cross-class clones and prioritize inconsistently changed clones. Do not impose zero duplication or automatically recommend abstraction.

### Git churn, co-change, and hotspots

Nagappan and Ball define churn from lines added, deleted, and changed in version control. In their Windows Server 2003 case study, relative churn measures normalized by factors such as size outperformed absolute churn and discriminated fault-prone from non-fault-prone binaries with 89% accuracy in that specific context ([ICSE 2005, DOI 10.1145/1062455.1062514](https://doi.org/10.1145/1062455.1062514), [Microsoft Research paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/icse05churn.pdf)). Hassan and Holt showed that historical co-change can help predict change propagation across entities in five large open-source systems ([ICSM 2004 paper](https://research.cs.queensu.ca/home/ahmed/home/pubs/icsm2004.pdf)).

**Recommended policy:** calculate commits touching each file/class, authors, recent added/deleted lines, relative churn (`churn / current NCSS` with zero-size handling), age, and pairwise co-change. Rank a hotspot from normalized change frequency × structural risk, but expose the components rather than only the composite. Review the top 5–10% or P90/P95; do not reuse the paper's 89% as a product accuracy claim.

### Coverage, assertions, and mutation testing

Salesforce requires 75% coverage for relevant Apex deployment modes, but Salesforce itself states that high coverage does not necessarily imply good tests because tests may use weak values or no useful assertions; coverage measures quantity and is best used to locate untested code ([Salesforce: Drive Your Testing Strategy with Code Coverage](https://developer.salesforce.com/blogs/2020/11/drive-your-testing-strategy-with-code-coverage), [Salesforce CLI test-level rules](https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_apex_run_test.html)). A large empirical study of 31,000 Java test suites found only low-to-moderate correlation between coverage and fault-detection effectiveness after controlling for suite size, and recommends not using coverage as the sole quality target ([Inozemtseva and Holmes, ICSE 2014](https://cs.uwaterloo.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf)).

Mutation testing injects small faults and measures whether tests detect them; the survey by Jia and Harman describes the mutation adequacy score and evidence of maturing applicability ([IEEE TSE 2011, DOI 10.1109/TSE.2010.62](https://doi.org/10.1109/TSE.2010.62), [open copy](https://citeseerx.ist.psu.edu/document?doi=d7c38286734419b52de4262c9802ebdfcf4b9447&repid=rep1&type=pdf)). Just et al. further found a significant relationship between mutants detected and real faults detected, independent of statement coverage, across 357 real faults in five open-source systems ([FSE 2014 study](https://homes.cs.washington.edu/~mernst/pubs/mutation-effectiveness-fse2014-abstract.html), [open paper](https://www.cs.ubc.ca/~rtholmes/papers/fse_2014_just.pdf)). Mutation score cannot be truthfully inferred from static analysis; it requires executing tests against mutants and still has costs such as equivalent mutants.

**Recommended offline policy:** detect test classes/methods, assertion calls, tests without assertions, `SeeAllData`, and which production symbols are referenced by tests. Label this **test evidence**, not coverage. PMD's Apex rule also requires at least one assertion and supports custom assertion method patterns ([PMD ApexUnitTestClassShouldHaveAsserts](https://docs.pmd-code.org/latest/pmd_rules_apex_bestpractices.html#apexunittestclassshouldhaveasserts)). If an authenticated org is later available, ingest actual per-class coverage and optionally implement sampled mutation testing as a separate dynamic mode.

### Maintainability Index

Oman and Hagemeister introduced the Maintainability Index from fitted combinations of Halstead volume, cyclomatic complexity, LOC, and in some variants comments ([ICSM 1992, DOI 10.1109/ICSM.1992.242525](https://doi.org/10.1109/ICSM.1992.242525); expanded construction study [DOI 10.1016/0164-1212(94)90067-1](https://doi.org/10.1016/0164-1212(94)90067-1)). Microsoft's current rebased variant is:

`MAX(0, (171 - 5.2 ln(Halstead Volume) - 0.23 CC - 16.2 ln(LOC)) * 100 / 171)`

Microsoft uses 0–9 red, 10–19 yellow, and 20–100 green, explicitly chosen conservatively to reduce noise ([Microsoft formula and thresholds](https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning?view=visualstudio)).

**Recommendation:** do not make MI a primary gate for Apex. The original fitted model and Microsoft's rebasing are different variants, aggregation can hide local hotspots, and the formula double-counts size/complexity already exposed elsewhere. If included, identify the exact variant, show its inputs, and use it only for within-repository trend—not cross-language/client comparison.

## Standards framing

ISO/IEC 25010:2023 defines a product-quality model, but it is a taxonomy rather than a ready-made set of source-code thresholds ([official ISO page](https://www.iso.org/standard/78176.html)). ISO/IEC 5055:2021 defines automated source-code measures for four structural characteristics: reliability, security, performance efficiency, and maintainability. CISQ explains that these measures are composed from enumerated weaknesses and are intended for static analysis, benchmarking, targets, and improvement tracking ([CISQ overview of ISO 5055](https://www.it-cisq.org/standards/code-quality-standards/)).

Use these standards to organize report sections and trace rules to quality characteristics. Do not claim ISO 5055 conformance unless every required weakness, aggregation rule, and measurement condition in the paid/full standard is actually implemented and verified.

## Apex/Salesforce-specific offline layer

Salesforce Code Analyzer is the official first-party umbrella and currently bundles PMD, CPD, ESLint, Flow Scanner, RetireJS, and Salesforce Graph Engine. It supports customized severity/tags and CI output ([Salesforce Code Analyzer overview](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/code-analyzer.html), [engine list](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/engines.html)). This makes PMD/CPD compatibility a credible baseline, while the app's differentiator should be unified reachability, capacity recovery, evidence/confidence, Git risk, and report generation.

High-value offline Apex gates include:

- DML/SOQL in loops and other governor-limit hazards;
- sharing, CRUD/FLS, injection, and authorization rules, with path/data-flow confidence separated from syntax-only findings;
- logic in triggers ([PMD AvoidLogicInTrigger](https://docs.pmd-code.org/latest/pmd_rules_apex_bestpractices.html#avoidlogicintrigger));
- unnecessary `global`, which can permanently constrain managed-package APIs ([PMD AvoidGlobalModifier](https://docs.pmd-code.org/latest/pmd_rules_apex_bestpractices.html#avoidglobalmodifier));
- unused methods using the complete SFDX metadata context. PMD's own Apex `UnusedMethod` documentation warns that accuracy depends on a complete metadata root and declared external namespaces ([PMD UnusedMethod](https://docs.pmd-code.org/latest/pmd_rules_apex_design.html#unusedmethod)).

Salesforce Graph Engine's rule model is also useful for defining entry points, sinks, and sanitizers for path-sensitive Apex findings ([official SFGE rules reference](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/rules-sfge.html)).

## Suggested implementation priority

1. **Complexity bundle:** cyclomatic, cognitive, NCSS, nesting, method/class percentiles, exact contributors.
2. **Architecture bundle:** fan-in/out, WMC/CBO/RFC, SCC cycles, entry-point reachability, test-only/unreachable overlays.
3. **Git bundle:** churn, ownership dispersion, age, co-change, hotspot rank.
4. **Duplication bundle:** token clones, production duplicate density, clone change consistency.
5. **Test-evidence bundle:** assertions, test-to-production graph, risky test constructs; org coverage remains optional dynamic enrichment.
6. **Apex rule bundle:** adopt or interoperate with official Code Analyzer/PMD rules instead of silently reimplementing hundreds of mature rules.

Every finding should include metric definition/version, entity and source span, measured value, policy threshold and origin, contributing evidence, confidence/limitations, and remediation category. That makes the deterministic output strong enough for an LLM to narrate later without asking the LLM to invent the diagnosis.

A practical report can expose three independent lanes: **hard deterministic risks** (parse failures, high-confidence security/governor violations, newly introduced cycles or clones), **maintainability review** (complexity, CK, size, churn, duplication, optional MI), and **capacity recovery** (unreachable symbols × source size × reachability confidence). Maintainability metrics can prioritize review of a reclamation candidate, but cannot prove that it is safe to delete.
