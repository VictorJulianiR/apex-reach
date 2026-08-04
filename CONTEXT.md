# Apex Recovery Analysis

This context describes evidence-based analysis of deployable Apex and the Salesforce metadata that can make it executable.

## Language

**Symbol**:
A uniquely identified Apex class, trigger, method, constructor, or initializer declared in the analyzed source.

**Reference**:
Evidence in Apex or metadata that names or invokes a symbol; a reference can be exact, ambiguous, or dynamic.
_Avoid_: Usage, call

**Entry point**:
A symbol Salesforce or external code can invoke without a caller in the analyzed Apex graph, such as a trigger or an annotated method.
_Avoid_: Root, public method

**Reachable symbol**:
A symbol connected to an entry point by a chain of resolved references.
_Avoid_: Used symbol

**Recovery candidate**:
A non-test symbol for which the analysis found no path from a concrete production code or metadata entry point in the declared repository universe.
_Avoid_: Dead code, unused code

**Exposure**:
Evidence that a symbol can be invoked through an annotation, visibility modifier, webservice, or platform callback. Exposure is not a call and never changes repository reachability by itself.
_Avoid_: Entry point, probability

**Evidence trail**:
The source locations and resolution steps that justify a classification, including entry points and reference edges.
_Avoid_: Explanation

**Analysis blocker**:
A concrete repository construct that prevents the closed-world conclusion from being complete, such as a parse failure, computed type name, unresolved call, or duplicate symbol. It must include a source location when available.
_Avoid_: Confidence, uncertainty, probability

**Repository universe**:
All deployable Apex and calling metadata found under every package directory declared by `sfdx-project.json`. External callers not represented in that universe are explicitly out of scope.

**Apex footprint**:
The UTF-8 source bytes and source characters represented by deployable Apex files in the analyzed repository.
_Avoid_: Org usage

**Clone family**:
A deterministic set of source spans accepted by a versioned exact-token, parameterized, or verified near-miss profile. Similarity is a measurement, not confidence.
_Avoid_: Probably duplicated

**Clone coverage**:
The union of production source intervals participating in accepted clone families, counted once globally.
_Avoid_: Guaranteed savings

**Repeated occurrence coverage**:
The union of clone occurrences after retaining one deterministic representative per family. It measures refactoring opportunity, not final Apex reduction.

**SOQL family blocker**:
A dynamic query expression that cannot be constant-folded from repository-known string components and therefore prevents complete selector-family coverage.

**Flow-eligible path**:
A trigger call slice whose record mutation, order, bulk, transaction, recursion, security, error, and side-effect semantics all fit the supported record-triggered Flow profile.
_Avoid_: Easy Flow, likely convertible

**Flow-blocked path**:
A trigger slice for which parsing or call resolution is incomplete. This is a coverage state, not a probability.
