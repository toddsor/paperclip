# feat(org-memory): layered organizational knowledge and context architecture

## Summary

Introduces a persistent organizational memory layer that allows agents to wake up with role-appropriate context assembled from their position in the org hierarchy, and to write structured knowledge back when they complete work.

Paperclip already models *how work is assigned*. This PR adds the infrastructure for *how organizations remember what they have learned*.

- New `org_memory` table with sensitivity-classified, hierarchy-scoped entries
- `orgMemoryService` with hierarchy-aware read (walks `reportsTo` chain) and controlled write-back
- Two new API routes for reading and writing org memory
- `enrichWakeContextSnapshot()` extended to flag `roleContextAvailable` at wake time — context is fetched on demand, not embedded in the run record
- `heartbeat-context` response extended with `roleContext` field
- Issue close-out extended to accept an optional `memoryArtifact` that propagates to goal and manager scope
- New `POST /api/issues/:issueId/memory` endpoint for agent-driven write-back during execution
- Scope-based write access control and audit logging for sensitive reads

## Motivation

Agents currently wake up with their task brief, goal ancestry, and comment thread — but nothing that captures what the organization has learned over time. Every agent starts from scratch.

In practice this means:
- prior decisions must be restated in every new ticket
- manager-level agents cannot see synthesized outcomes from their reports
- strategic intent dilutes as it delegates downward
- insights are trapped inside execution logs and never surface to the role that needs them

The `plugin_state` table provides generic scoped storage, and `para-memory-files` provides per-agent file-based memory (both of which this PR builds on). The missing layer is *organizational* memory: knowledge that is scoped above the individual agent, propagates through the `reportsTo` hierarchy, and is assembled into a role-appropriate context package at wake time.

## What this is not

This is not a replacement for tickets, goals, or the governance system. It is not an attempt to automate summarization in the server layer. Summarization remains an agent task — a manager-role routine that reads `GET /api/agents/me/memory-context`, synthesizes its reports' artifacts, and calls `POST /api/companies/:id/memory`. The infrastructure here only makes that possible; it does not do it automatically.

## Changes

### Database

**New table: `org_memory`**

```
id              UUID PK
company_id      UUID FK → companies
scope_kind      text  --  'company' | 'project' | 'goal' | 'agent_role' | 'agent'
scope_id        text  --  entity id for that scope; null = company-wide
key             text  --  logical key, e.g. 'architecture_decisions'
value_json      jsonb
sensitivity     text  --  'internal' | 'confidential' | 'restricted'  default: 'internal'
propagate       boolean  default: true
source_agent_id UUID FK → agents  (nullable)
source_issue_id UUID FK → issues  (nullable)
created_at      timestamp
updated_at      timestamp

unique on (company_id, scope_kind, scope_id, key)
```

One migration file. No changes to existing tables.

### Sensitivity model

Three sensitivity levels control read propagation:

- `internal` — visible to any agent who would normally reach this scope through hierarchy traversal or shared goal/project membership. Default for most knowledge.
- `confidential` — visible only to agents at or above the scope level where it was written. Does not spread laterally through goal or project scope. A CEO's budget entry written to company scope stays at company scope even if the goal it relates to has many agents assigned.
- `restricted` — visible only to the writing agent and their direct manager. Never propagates further up the chain or laterally. Used for personnel notes, evaluation records, negotiation positions.

### Propagation model

`propagateUpward()` writes a summary entry to the direct manager's agent scope. Two controls limit what propagates:

- `propagate: false` on an entry disables propagation entirely
- Entries with `sensitivity: restricted` are never propagated regardless of the `propagate` flag

### Lateral propagation through shared scope

Sideways knowledge sharing — between peers under the same manager — is handled through goal and project scope, not through explicit sibling relationships. When a developer discovers a constraint and writes it to goal scope, every agent working toward that goal (including sibling architects) reads it on their next wake via `readForAgent`. Agent scope entries do not spread laterally; goal and project scope entries do. This distinction is intentional and is the contract agents should use when deciding where to write:

- **goal scope** — visible to all agents on the goal, including peers
- **agent scope + propagateUpward** — goes to manager; peers see it only when they read the manager's scope

### Server — `orgMemoryService`

- `write(companyId, scopeKind, scopeId, key, value, sensitivity, propagate, sourceAgentId?, sourceIssueId?)` — upsert; enforces write access rules (see below)
- `readForAgent(agentId, issueId?)` — hierarchy-aware read: walks the `reportsTo` chain upward, collects entries scoped to the calling agent, each ancestor's agent scope, the current goal, the current project, and the company. Filters by sensitivity against the calling agent's position. Returns a merged `RoleContext` object, innermost scope wins on key collision.
- `propagateUpward(agentId, key, value, sourceIssueId?)` — writes a summary entry to the direct manager's agent scope; skips `restricted` entries and entries with `propagate: false`

### Server — write access control

Agents can only write to scopes they are authorized for:

| Scope | Allowed writers | Max sensitivity |
|---|---|---|
| `agent` (own) | That agent only | `restricted` |
| `agent` (other) | Direct manager only | `confidential` |
| `goal` | Any agent assigned to that goal | `internal` |
| `project` | Any agent in that project | `internal` |
| `company` | Board users and CEO agent only | `confidential` |

Writing `confidential` or `restricted` entries to goal or project scope is rejected — those sensitivity levels are only valid for agent-scoped entries, where the audience is controlled by hierarchy rather than assignment.

### Server — new routes

`POST /api/companies/:companyId/memory`
Write or upsert an org memory entry. Enforces scope-based write access rules above.

`GET /api/agents/me/memory-context`
Returns the assembled `RoleContext` for the calling agent — the same structure made available at wake time, queryable on demand during execution.

`POST /api/issues/:issueId/memory`
Agent-driven write-back during or after execution. Accepts `{ key, value, scopeKind?, scopeId?, sensitivity?, propagate? }`. Defaults to the issue's goal scope with `sensitivity: internal`. Agents that prefer to write incrementally use this rather than waiting for close-out.

### Server — wake context

`enrichWakeContextSnapshot()` (`server/src/services/heartbeat.ts`) is extended to set `contextSnapshot.roleContextAvailable = true`. It does **not** embed the full `RoleContext` in the snapshot.

`contextSnapshot` is stored in `heartbeat_runs` and surfaces in run logs and exports. Embedding org memory entries — including potentially sensitive ones — directly into the run record would create an uncontrolled persistence path for confidential data. Agents fetch context on demand via `GET /api/agents/me/memory-context` during their heartbeat; nothing sensitive lands in the run record.

### Server — heartbeat-context endpoint

`GET /api/issues/:issueId/heartbeat-context` response gains a `roleContext` field alongside the existing `ancestors`, `project`, `goal`, and `commentCursor` fields. This is the primary way agents access org context during a heartbeat — a single call that returns task state and organizational knowledge together.

### Server — issue close-out

`PATCH /api/issues/:issueId` accepts an optional `memoryArtifact: { key, value, sensitivity?, propagate? }` field when `status === 'done'`. When present:
1. Writes to `org_memory` at the issue's goal scope
2. Calls `orgMemoryService.propagateUpward()` to write a summary entry to the assigning agent's direct manager scope

Agents that prefer to write incrementally can use `POST /api/issues/:issueId/memory` instead and omit `memoryArtifact` at close.

### Audit logging

All writes to `org_memory` are recorded in `activity_log`. Reads of entries with `sensitivity: confidential` or `restricted` are also recorded, answering "who accessed this" for compliance purposes. Read logging is skipped for `internal` entries to avoid log noise.

## Known limitations

**Prompt injection via memory.** An agent writing a malicious entry to goal scope can affect peers who read it as trusted organizational context. This is the same risk as agent-authored comments and should be treated with the same skepticism by consuming agents.

**Sensitivity relies on correct classification at write time.** Infrastructure enforces the rules; it cannot detect a sensitive value written with `internal` sensitivity. Making the right choice easy (goal scope + internal as default) and the wrong choice visible (audit log) is the practical mitigation.

**Company export must exclude sensitive entries.** The existing export API does not yet know about `org_memory`. A follow-up is required to either exclude `confidential` and `restricted` entries from exports or require explicit board confirmation before including them.

## Test plan

- [ ] `org_memory` upsert behaves correctly for all five scope kinds
- [ ] `readForAgent` returns entries from each level of the `reportsTo` chain, innermost scope wins on key collision
- [ ] `readForAgent` filters `confidential` entries to agents at or above the writing scope; does not return them to lower agents via goal/project traversal
- [ ] `readForAgent` filters `restricted` entries to writing agent and direct manager only
- [ ] `readForAgent` with no org memory entries returns an empty `RoleContext` without error
- [ ] `enrichWakeContextSnapshot()` sets `roleContextAvailable: true` and does not embed `RoleContext` content in the snapshot
- [ ] `heartbeat-context` response includes populated `roleContext` field
- [ ] `PATCH /api/issues/:id` with `memoryArtifact` writes to goal scope and propagates to manager scope
- [ ] `PATCH /api/issues/:id` without `memoryArtifact` is unchanged from current behavior
- [ ] `POST /api/issues/:id/memory` writes to goal scope by default; respects explicit `scopeKind`/`scopeId` override
- [ ] Agent cannot write `confidential` or `restricted` entries to goal or project scope
- [ ] Agent cannot write to a scope outside their authorization level
- [ ] `propagateUpward` skips entries with `propagate: false`
- [ ] `propagateUpward` skips entries with `sensitivity: restricted` regardless of `propagate` flag
- [ ] Writes to `activity_log` on all `org_memory` mutations
- [ ] Reads of `confidential` and `restricted` entries recorded in `activity_log`; `internal` reads are not
- [ ] Agents with no `reportsTo` (e.g. CEO) receive company-scoped entries only; no traversal errors
- [ ] `confidential` entries written to company scope by CEO are not visible in developer `roleContext` assembled from goal scope traversal

## Builds on

- PR #2311 — wake context now reliably carries the issue brief; `roleContextAvailable` extends the same snapshot
- PR #1779 — bootstraps the agent home PARA skeleton; agent-level org memory complements file-based memory
- `para-memory-files` skill — file-based per-agent memory remains the right tool for agent-private notes; `org_memory` handles what needs to be visible across the hierarchy
