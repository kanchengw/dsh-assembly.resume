# dsh-assembly.resume Implementation Milestones

Language: TypeScript

These milestones track the standalone Host and Client plugin. `dsh-assembly.bridge` is a sibling component and is deliberately not a prerequisite for this package.

Each milestone leaves the package type-checkable. A later milestone may start only after its focused tests pass and the full earlier suite is green again.

## Milestone 0: Package and Host Contract [completed]

Scope:

- Create the standalone TypeScript package.
- Register `ctx.sessionResume` as a Cordis service.
- Depend on DSH's `storage-domain` and session-persistence capabilities through their public APIs.
- Define branded ids, public records, stable errors, and the durable domain schema.

Verification completed:

- strict TypeScript compilation;
- valid and malformed durable-record schema tests;
- Cordis composition over an independent in-memory storage backend;
- no provider dependency or process startup path.

## Milestone 1: Register and Query [completed]

Scope:

- Implement `register`, `get`, and `find`.
- Validate provider ids, native session ids, DSH session ids, absolute workspaces, timestamps, and provider metadata.
- Reject duplicate provider/native-session pairs.
- Return detached immutable record snapshots.

Verification completed:

- registration and filtering tests;
- duplicate detection;
- persistence regression using two service instances over one fake durable backend;
- snapshot freezing checks.

## Milestone 2: Ownership Leases [completed]

Scope:

- Implement `acquire` and `release`.
- Add lease tokens, owner conflict errors, stale-release behavior, and idempotent release.
- Serialize compound operations within one service instance.

Verification completed:

- single-owner and second-owner conflict tests;
- stale token and stale release tests;
- concurrent acquisition regression;
- durable owner state is changed only by the matching lease generation.

## Milestone 3: State Updates and Crash Recovery [completed]

Scope:

- Implement explicit lifecycle transitions.
- Implement `update` and `markClosed` under a matching lease.
- Recover abandoned leases at startup without launching a provider.

Verification completed:

- legal and illegal transition tests;
- `closed` terminal-state and acquisition rejection tests;
- restart recovery from a stranded owner to `unknown`;
- explicit release preserves the last known non-terminal status;
- optional metadata can be updated and cleared.

Important lifecycle decision:

- A bridge must call `release()` before normal attachment teardown. Cordis sibling disposers can run in parallel, so plugin disposal does not attempt a durable release. A residual lease is recovered on the next startup and is never interpreted as provider completion.

## Milestone 4: Registry Artifact Surface [completed]

Scope:

- Add the registry README and `cordis.patch.yml`.
- Align the package manifest with the latest DSH `0.1.1-rc.2` publication layout.
- Build root and invariant runtime entries that match package exports.
- Add a package-artifact smoke check.

Acceptance:

- `lib/index.js` and `lib/invariant.js` exist after build;
- package-root and invariant subpath imports succeed through package exports;
- the patch mounts the resume runtime and expects the host to provide storage, storage-domain, session-persistence, and the DSH Agent factory;
- no native provider process is launched by package boot or takeover.

Verification:

- `pnpm test`;
- `pnpm typecheck`;
- `pnpm build`;
- `pnpm test:artifact`;
- review of manifest, patch, and README against current DSH conventions.

## Milestone 5: Standalone Resume Surface [in progress]

This milestone is required. It makes `dsh-assembly.resume` independently
installable and usable inside DSH without `dsh-assembly.bridge` or a future
assembly package. Its only continuation path is native-history import followed
by DSH Agent creation or resume; it must not expose native Agent control,
native prompt forwarding, or native resume.

Scope:

- Keep `dsh-assembly.bridge` optional and independent.
- Add provider-neutral discovery, transcript inspection, DSH takeover, DSH reopen, and project-aware navigation.
- Add the Host Remote contract and the browser card in Plugin configuration.
- Import the complete supported semantic transcript into the DSH seed before the DSH Agent starts.

Acceptance:

- a user can install this bundle alone, discover a Codex, Claude Code CLI, or Claude Code Desktop session, take it over into DSH, and reopen the DSH-owned conversation;
- provider adapters are private to this component, so the component does not require `dsh-assembly.bridge`;
- the public feature never forwards a post-takeover prompt to a native CLI.

Verification required after the semantic correction:

- bounded Codex, Claude Code CLI, and Claude Code Desktop discovery tests over independently-authored fixtures;
- complete semantic transcript parser and DSH seed tests;
- DSH Agent create/reopen tests with native process absence asserted;
- Host and Client strict TypeScript compilation;
- standalone Node and browser bundle build;
- artifact smoke test.

The user's final end-to-end tests will cover real Claude Code and Codex installations.

## Regression Policy

After every implementation change, run the smallest focused test for the changed behavior. At each milestone checkpoint, rerun the complete package test suite, typecheck, and build. Artifact checks run after build because they exercise the published output layout. Reference projects supply design evidence only; their code, fixtures, harnesses, and test strategy are not reused.
