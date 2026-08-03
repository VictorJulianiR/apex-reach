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
A symbol for which the analysis found no path from a known entry point, accompanied by confidence, evidence, and uncertainty.
_Avoid_: Dead code, unused code

**Confidence**:
The strength of a recovery candidate based on what the analyzer resolved and which sources of uncertainty remain.
_Avoid_: Certainty, probability

**Evidence trail**:
The source locations and resolution steps that justify a classification, including entry points and reference edges.
_Avoid_: Explanation

**Uncertainty**:
A construct that can hide a reference from static analysis, such as a computed type name, managed-package integration, or metadata outside the repository.
_Avoid_: Error

**Apex footprint**:
The UTF-8 source bytes and source characters represented by deployable Apex files in the analyzed repository.
_Avoid_: Org usage
