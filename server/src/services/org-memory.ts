import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, orgMemory } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export type ScopeKind = "company" | "project" | "goal" | "agent_role" | "agent";
export type Sensitivity = "internal" | "confidential" | "restricted";

export interface OrgMemoryEntry {
  key: string;
  value: unknown;
  sensitivity: Sensitivity;
  scopeKind: ScopeKind;
  scopeId: string | null;
}

export interface RoleContext {
  entries: OrgMemoryEntry[];
}

const SCOPE_KINDS: ScopeKind[] = ["company", "project", "goal", "agent_role", "agent"];

// Scopes through which internal entries spread laterally (peer agents on same goal/project).
const LATERAL_SCOPES = new Set<ScopeKind>(["goal", "project", "company"]);

export function orgMemoryService(db: Db) {
  async function write(input: {
    companyId: string;
    scopeKind: ScopeKind;
    scopeId: string | null;
    key: string;
    value: unknown;
    sensitivity: Sensitivity;
    propagate: boolean;
    sourceAgentId?: string | null;
    sourceIssueId?: string | null;
  }) {
    const now = new Date();
    const [row] = await db
      .insert(orgMemory)
      .values({
        companyId: input.companyId,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId ?? null,
        key: input.key,
        valueJson: input.value,
        sensitivity: input.sensitivity,
        propagate: input.propagate,
        sourceAgentId: input.sourceAgentId ?? null,
        sourceIssueId: input.sourceIssueId ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          orgMemory.companyId,
          orgMemory.scopeKind,
          orgMemory.scopeId,
          orgMemory.key,
        ],
        set: {
          valueJson: input.value,
          sensitivity: input.sensitivity,
          propagate: input.propagate,
          sourceAgentId: input.sourceAgentId ?? null,
          sourceIssueId: input.sourceIssueId ?? null,
          updatedAt: now,
        },
      })
      .returning();

    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.sourceAgentId ? "agent" : "system",
      actorId: input.sourceAgentId ?? "system",
      agentId: input.sourceAgentId ?? null,
      action: "org_memory.written",
      entityType: "org_memory",
      entityId: row.id,
      details: {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        key: input.key,
        sensitivity: input.sensitivity,
      },
    });

    return row;
  }

  async function readForAgent(agentId: string, issueId?: string | null): Promise<RoleContext> {
    // Resolve the calling agent and its issue context.
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return { entries: [] };

    const companyId = agent.companyId;

    // Resolve goal and project from the issue if provided.
    let goalId: string | null = null;
    let projectId: string | null = null;
    if (issueId) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (issue) {
        goalId = issue.goalId ?? null;
        projectId = issue.projectId ?? null;
      }
    }

    // Walk the reportsTo chain to collect ancestor agent IDs (including self).
    const agentChain: string[] = [agentId];
    let current = agent;
    while (current.reportsTo) {
      const [parent] = await db.select().from(agents).where(eq(agents.id, current.reportsTo));
      if (!parent || agentChain.includes(parent.id)) break; // guard against cycles
      agentChain.push(parent.id);
      current = parent;
    }

    // Collect all candidate rows.
    const scopeConditions = [
      // Company-wide entries.
      and(eq(orgMemory.scopeKind, "company"), isNull(orgMemory.scopeId)),
      // Agent-scoped entries for every agent in the chain.
      and(
        eq(orgMemory.scopeKind, "agent"),
        inArray(orgMemory.scopeId, agentChain),
      ),
    ];
    if (goalId) {
      scopeConditions.push(
        and(eq(orgMemory.scopeKind, "goal"), eq(orgMemory.scopeId, goalId)),
      );
    }
    if (projectId) {
      scopeConditions.push(
        and(eq(orgMemory.scopeKind, "project"), eq(orgMemory.scopeId, projectId)),
      );
    }

    const rows = await db
      .select()
      .from(orgMemory)
      .where(and(eq(orgMemory.companyId, companyId), or(...scopeConditions)));

    // Apply sensitivity filtering and build the merged context.
    // Innermost scope wins on key collision: agent > ancestor agents > goal > project > company.
    // Scope ordering: agent (self) > agent (ancestors, closer first) > goal > project > company.
    const scopePriority = (row: typeof orgMemory.$inferSelect): number => {
      if (row.scopeKind === "agent") {
        const depth = agentChain.indexOf(row.scopeId ?? "");
        // Self is depth 0 (highest priority), manager is 1, etc.
        return depth >= 0 ? depth : 999;
      }
      if (row.scopeKind === "goal") return agentChain.length;
      if (row.scopeKind === "project") return agentChain.length + 1;
      return agentChain.length + 2; // company
    };

    // Sort so innermost scope comes first; dedup by key keeping first (highest priority).
    const sorted = rows.sort((a, b) => scopePriority(a) - scopePriority(b));
    const seen = new Set<string>();
    const entries: OrgMemoryEntry[] = [];

    for (const row of sorted) {
      let visibleToCallingAgent = true;
      if (row.sensitivity === "restricted") {
        // Visible only to the writing agent itself or to an agent whose id is
        // the source agent's direct manager.
        if (row.sourceAgentId && row.sourceAgentId !== agentId) {
          // Check if the calling agent is the direct manager of the source agent.
          const [sourceAgent] = await db
            .select({ reportsTo: agents.reportsTo })
            .from(agents)
            .where(eq(agents.id, row.sourceAgentId));
          visibleToCallingAgent = sourceAgent?.reportsTo === agentId;
        } else if (!row.sourceAgentId) {
          visibleToCallingAgent = false;
        }
      } else if (row.sensitivity === "confidential") {
        // Confidential entries do not spread laterally through goal/project scope.
        if (LATERAL_SCOPES.has(row.scopeKind as ScopeKind) && row.scopeKind !== "company") {
          visibleToCallingAgent = false;
        }
      }

      if (!visibleToCallingAgent) continue;

      if (!seen.has(row.key)) {
        seen.add(row.key);
        entries.push({
          key: row.key,
          value: row.valueJson,
          sensitivity: row.sensitivity as Sensitivity,
          scopeKind: row.scopeKind as ScopeKind,
          scopeId: row.scopeId,
        });
      }
    }

    // Audit-log reads of confidential/restricted entries.
    const sensitiveRead = entries.filter(
      (e) => e.sensitivity === "confidential" || e.sensitivity === "restricted",
    );
    if (sensitiveRead.length > 0) {
      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "org_memory.read_sensitive",
        entityType: "org_memory",
        entityId: agentId,
        details: {
          keys: sensitiveRead.map((e) => e.key),
          issueId: issueId ?? null,
        },
      });
    }

    return { entries };
  }

  async function propagateUpward(input: {
    agentId: string;
    companyId: string;
    key: string;
    value: unknown;
    sourceIssueId?: string | null;
    propagate?: boolean;
    sensitivity?: Sensitivity;
  }) {
    // Never propagate restricted entries.
    if (input.sensitivity === "restricted") return null;
    // Respect the propagate flag.
    if (input.propagate === false) return null;

    const [agent] = await db
      .select({ reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, input.agentId));
    if (!agent?.reportsTo) return null;

    return write({
      companyId: input.companyId,
      scopeKind: "agent",
      scopeId: agent.reportsTo,
      key: input.key,
      value: input.value,
      sensitivity: "internal",
      propagate: false,
      sourceAgentId: input.agentId,
      sourceIssueId: input.sourceIssueId ?? null,
    });
  }

  return { write, readForAgent, propagateUpward };
}
