# Eval Harness

Meldwork's Eval Harness is a local, provider-neutral evidence loop for comparing single Agents and orchestration workflows without exposing runtime secrets or raw execution output.

## Record model

- Eval Cases are versioned, content-addressed records containing an input, constraints, expected Artifacts, Evidence requirements, and a weighted deterministic rubric.
- Eval Results record target Agents, Connector versions, observable provider/model identifiers, workflow identity, context and prompt versions, duration, usage, bounded failures, reviewer evidence, and scores.
- Agent Fit Matrices are content-addressed snapshots derived from immutable result IDs. They report score, confidence, sample size, and qualification for each Agent/domain and workflow/domain pair.
- Model and human reviews require an explicit reviewer identifier and record whether review was blinded. Deterministic checks remain visible and cannot be replaced by a high reviewer score.

All records use strict schemas. Executable paths, credentials, raw commands, chain-of-thought, raw tool output, and detected secret values are rejected.

## Suites

Run the provider-free contract suite:

```sh
npm --prefix desktop run eval:deterministic
```

The bundled corpus covers research synthesis, document production, code review, tool use, interrupted-run recovery, and adversarial permission boundaries. It runs each case against two individual Agent targets and a Primary/Reviewer workflow.

This deterministic suite verifies the Harness and scoring contract. Its fixture scores are not evidence that one real Agent outperforms another. The committed frozen matrix therefore marks every entry as `insufficient-evidence` and none are eligible to influence routing.

Provider-dependent runs are deliberately opt-in and require a local adapter:

```sh
MELDWORK_EVAL_PROVIDER=1 npm --prefix desktop run eval:provider -- \
  --adapter /absolute/path/to/eval-adapter.cjs \
  --corpus /absolute/path/to/provider-corpus.json
```

The adapter must export an async `execute(context)` function that returns a strict Eval Observation. Provider suites are not run in CI.

## Routing threshold

Routing accepts only frozen matrix entries with at least three results and confidence of at least `0.6`. A matrix version is recorded only when qualified evidence actually affects a selected candidate. Low-sample entries remain available for audit but cannot change automatic routing.
