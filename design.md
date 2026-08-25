# dsh-assembly.resume Design

Status: corrected MVP design, aligned with DSH dsh-v0.1.1-rc.2

Date: 2026-08-24

## 1. Purpose

`dsh-assembly.resume` lets a user select an existing Codex or Claude Code
conversation and make it the starting history of a DSH Agent conversation.
After takeover, DSH owns the live conversation:

```text
native Codex/Claude session
        |
        | read + validate + normalize
        v
DSH seeded session
        |
        | ctx.agents.create / ctx.agents.resume
        v
DSH Agent answers all future prompts
```

This is a standalone plugin. It is not a UI-only projection and it does not
depend on `dsh-assembly.bridge`.

## 2. Explicit Semantic Boundary

The following is **not** what this plugin does:

```text
DSH prompt -> codex resume / claude --resume -> append response to DSH
```

That is native provider continuation and belongs to `dsh-assembly.bridge`.
The resume plugin must not expose a follow-up button or service method that
performs that operation under a misleading name.

## 2.1 Compatibility With Current DSH

The implementation targets the local DSH remote tip
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`). The relevant
compatibility conclusions are:

- `ctx.agents.create()` accepts a caller-selected `sessionId` and a validated
  `SessionEvent[]` seed. This is the takeover creation seam.
- `ctx.agents.resume({ resumeSessionId })` reloads a persisted DSH session
  through the host's `sessionPersistence` service. This is DSH-agent recovery,
  not native Codex/CC continuation.
- DSH validates sequence continuity, balanced turn/step boundaries, assistant
  provider/model provenance, and tool call/result pairing at the session
  boundary. The adapter therefore fails closed on ambiguous native history.
- DSH client runtime owns workspace creation/reuse and session attachment.
  The Host service stores the native project path, while the client performs
  workspace navigation after takeover.
- `subagent-codex` and `subagent-claude-code` remain one-shot providers. They
  are not widened or used as a hidden takeover transport.

This gives the component two separate continuation moments:

1. **Import-time takeover:** read the native transcript once and call
   `ctx.agents.create({ sessionId, seed, meta, agentOptions })`.
2. **DSH restart recovery:** call
   `ctx.agents.resume({ resumeSessionId, agentOptions })` for the DSH session
   already recorded by the binding.

There is no third step that sends a later prompt to `codex resume` or
`claude --resume`. That operation belongs exclusively to
`dsh-assembly.bridge`.

## 3. Users and Entrypoints

The plugin has three independent entry paths over one service:

| Entry | User | Behavior |
| --- | --- | --- |
| Cordis service | other plugins / final assembly | discover, inspect, take over, reopen, detach |
| DSH command or model tool | human / DSH Agent | invoke the same typed operations |
| remote + client UI | human in DSH UI | choose provider/session and trigger takeover |

The normal DSH composer handles messages after takeover. The resume UI does
not provide a second prompt box for forwarding messages to a native CLI.

## 4. Provider-neutral Contract

The public types are provider-neutral; `provider` is a discriminant only.
Provider-specific parser details stay behind adapters.

```ts
type ResumeProvider = 'codex' | 'claude-code' | 'claude-code-desktop'

interface NativeSessionSummary {
  provider: ResumeProvider
  nativeSessionId: string
  title?: string
  projectPath?: string
  cwd?: string
  updatedAt?: string
  canInspect: boolean
}

interface NativeTranscriptSnapshot {
  session: NativeSessionSummary
  fingerprint: string
  events: readonly NativeSemanticEvent[]
  sourceRevision: string
}

interface SessionResumeService {
  discover(input: ResumeDiscoveryInput): Promise<readonly NativeSessionSummary[]>
  inspect(input: InspectNativeSessionInput): Promise<NativeTranscriptSnapshot>
  takeOver(agent: Agent, input: TakeOverSessionInput): Promise<TakeOverResult>
  open(agent: Agent, bindingId: ResumeBindingId): Promise<TakeOverResult>
  list(agent: Agent): Promise<readonly ResumeBinding[]>
  detach(agent: Agent, bindingId: ResumeBindingId): Promise<void>
}
```

There is deliberately no `continue(bindingId, prompt)` API. The returned
`dshSessionId` is opened in DSH, and normal DSH message delivery wakes the
DSH Agent.

At the host implementation boundary, `takeOver` and `open` receive the
current DSH `Agent` as an ownership/scoping capability. The Remote layer
transmits only the agent id and resolves that capability on the host. This
agent argument is not a native provider session handle and is never used to
send a prompt to Codex or Claude Code.

## 5. Takeover Semantics

### First takeover

1. Validate provider and native session id from the UI/command boundary.
2. Discover and inspect the native transcript through the selected adapter.
3. Parse the complete semantic transcript and validate all required events.
4. Calculate a stable import fingerprint from provider, native identity, and
   source revision/content digest.
5. If the same fingerprint is already bound, reuse the existing binding.
6. Otherwise create a DSH `SessionId`, build a valid `SessionEvent[]` seed,
   and create the DSH Agent with the seed and native `cwd` metadata.
7. Persist the binding only after the DSH session and Agent startup succeed.
8. Return the DSH session/workspace target so the client opens it.

Conceptually the DSH integration is:

```ts
const handle = await ctx.agents.create({
  sessionId: dshSessionId,
  seed,
  meta: cwd === undefined ? undefined : { cwd },
  agentOptions: dshAgentOptions,
})
```

The exact owner context and agent options follow the host plugin lifecycle.
The important contract is that the first live Agent is a DSH Agent around the
imported DSH session.

### Reopen after DSH restart

1. Load the binding by its DSH/native identity.
2. Verify that the DSH session still exists and the binding is not corrupt.
3. Call `ctx.agents.resume({ resumeSessionId: dshSessionId, ... })`.
4. Open the DSH session in the client.

No native CLI process is started by this path.

The current DSH `agents.resume()` implementation loads the persisted event
log through the session-persistence service. It is a DSH Agent restart
operation; it does not read the native transcript again and does not invoke a
native CLI.

### Native source changes

The source native session is read-only from `resume`'s perspective. If its
content changes after import, the plugin reports a new source revision. It
does not merge new native events into a live DSH session and does not replace
the DSH Agent's history.

## 6. Semantic Transcript Model

Provider adapters normalize native records into an internal model before
building DSH events:

```ts
type NativeSemanticEvent =
  | {
      kind: 'user'
      id: string
      content: readonly NativeContentBlock[]
      nativeTurn: number
    }
  | {
      kind: 'assistant'
      id: string
      content: readonly NativeContentBlock[]
      provider: string
      model: string
      toolCalls?: readonly NativeToolCall[]
      nativeTurn: number
    }
  | {
      kind: 'tool-result'
      callId: string
      content: readonly NativeContentBlock[]
      nativeTurn: number
    }
```

The internal model is not exported as a provider file format. It exists to
make validation and seed construction independent from either provider.

### What complete means

The imported history must include every model-visible semantic item:

- user messages;
- visible assistant content;
- tool calls and paired tool results;
- provider/model attribution for assistant messages;
- native project/cwd/session provenance.

Raw token chunks, transport notifications, hidden reasoning, permission
dialogs, and diagnostics are not turned into ordinary user or assistant
messages. They are either retained in provider-owned provenance or reject the
import when omitting them would make the semantic history ambiguous.

### Seed event invariants

The seed builder emits contiguous, lossless DSH events with completed
turn/step boundaries. It must satisfy the current DSH session rules:

- every event has a contiguous sequence number;
- every message has a stable id and correct role;
- assistant messages have model source provenance;
- every tool call has a matching tool result;
- every imported turn and step is closed;
- message-producing events carry surface append metadata;
- no provider-private object is placed into the DSH event log unless it is
  lossless JSON and explicitly part of a supported event contract.

If the adapter cannot establish these facts, takeover fails before publishing
an Agent or binding.

## 7. Durable Binding

The binding is an index/provenance record, not a duplicate conversation log:

```ts
interface ResumeBinding {
  bindingId: string
  provider: ResumeProvider
  nativeSessionId: string
  nativeTitle?: string
  nativeProjectPath?: string
  nativeUpdatedAt?: string
  importFingerprint: string
  dshSessionId: string
  cwd?: string
  state: 'ready' | 'running' | 'detached' | 'stale' | 'failed'
  createdAt: string
  updatedAt: string
}
```

The native id and DSH id are never interchangeable. DSH persistence is the
source of truth for every turn after takeover.

The binding write is transactional from the plugin's perspective: do not
persist a `ready` binding before the seeded session is accepted and the DSH
Agent handle is published. A failed startup leaves no usable binding.

## 8. Project and Workspace Rules

The UI groups discovery results into two top-level kinds:

```text
project: <native project name>
new chat: sessions without a project association
```

Project sessions show their title and activity metadata. The unscoped group
is a sibling of project groups; its entries do not display a meaningless save
path.

On takeover:

- if the selected native session has a project path, create/reuse the DSH
  workspace for that path and open the imported DSH session there;
- if the native session has no project path, create no workspace and keep the
  DSH session unscoped;
- the native title becomes the initial DSH title only through the DSH title
  API/projection, not by writing client-only state;
- native source path and identity remain provenance metadata, not the DSH
  session id.

## 9. Provider Adapter Responsibilities

Each adapter independently implements:

1. availability detection;
2. bounded native session discovery;
3. title/project/cwd extraction;
4. complete semantic transcript reading;
5. defensive parsing and unsupported-event reporting;
6. stable source fingerprinting;
7. conversion into the provider-neutral transcript model.

Codex and Claude Code adapters may have different source layouts and event
vocabularies. No generic line-based parser may assume that their formats are
interchangeable.

The current one-shot DSH packages are not adapters for this contract. They
remain untouched and continue to serve one disposable external task.

## 10. Errors and Recovery

Public errors are explicit and actionable:

```text
RESUME_PROVIDER_UNAVAILABLE
RESUME_NATIVE_SESSION_NOT_FOUND
RESUME_TRANSCRIPT_INVALID
RESUME_TRANSCRIPT_UNSUPPORTED
RESUME_IMPORT_CONFLICT
RESUME_DSH_SESSION_CREATE_FAILED
RESUME_DSH_AGENT_START_FAILED
RESUME_BINDING_NOT_FOUND
RESUME_BINDING_CORRUPT
RESUME_DSH_SESSION_MISSING
```

Recovery rules:

- a parser failure does not create a DSH session;
- a seed validation failure does not publish an Agent;
- a DSH Agent startup failure does not leave a `ready` binding;
- a missing DSH session returns `RESUME_DSH_SESSION_MISSING`; the native source
  remains untouched and the caller can choose a new import;
- a DSH restart reopens the DSH session through `agents.resume`, never through
  native provider resume.

## 11. UI Contract

The settings/remote surface must expose:

- provider selector: Codex, Claude Code CLI, or Claude Code Desktop;
- grouped native session list by project and new-chat scope;
- native title, updated time, and project path only where meaningful;
- selection details and an explicit "take over in DSH" action;
- loading, parse failure, unsupported transcript, and already-imported states;
- navigation to the resulting DSH workspace/session.

The client contribution is registered as a DSH `settings.plugin.item` card
with key `session-resume`, placing it in Settings > Plugins > Plugin
configuration after the built-in configuration cards. The Host registers the
same zero-field settings namespace because that screen dispatches only cards
whose namespaces the Host serves. It does not register `settings.section` or
`settings.plugins.tab`: those slots respectively create a root Settings
navigation entry and a Plugins top tab.

After the action succeeds, the plugin does not render a native-provider
prompt box. The user is in a normal DSH conversation whose history starts
with the imported native transcript.

## 12. Milestones and Tests

### Milestone A: contracts and pure normalization

- define provider-neutral types and error codes;
- implement independent Codex/Claude metadata parsing;
- implement semantic transcript validation;
- test titles, project grouping, missing fields, malformed records, and
  unsupported events.

### Milestone B: DSH seed builder

- convert valid semantic transcripts to DSH seed events;
- reject incomplete turns and unpaired tools;
- test message provenance, sequence continuity, and idempotent fingerprints.

### Milestone C: DSH Agent takeover

- create a seeded DSH session and DSH Agent;
- reopen through `ctx.agents.resume`;
- prove no native runner is invoked by post-takeover message handling.

### Milestone D: binding/workspace and remote surface

- persist binding only after successful Agent creation;
- deduplicate same source fingerprint;
- create/reuse project workspace and preserve unscoped sessions;
- update UI to use takeover semantics.

Every milestone requires focused unit tests, package typecheck, build, and
artifact smoke. The user performs final real Codex/Claude E2E and owns the
native session cleanup.

## 13. Non-goals

- native Codex/Claude follow-up after takeover;
- controlling the external native Agent;
- live bidirectional synchronization with the native session;
- raw wire-log replay as DSH history;
- generic provider support beyond Codex and Claude Code in the MVP;
- task decomposition, four-stage scheduling, board, group chat, or manual
  assignment, which belong to future independent components.
