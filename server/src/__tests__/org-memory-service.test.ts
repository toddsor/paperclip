import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  issues,
  orgMemory,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { orgMemoryService } from "../services/org-memory.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres org-memory service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("orgMemoryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-org-memory-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(orgMemory);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, reportsTo?: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo: reportsTo ?? null,
    });
    return agentId;
  }

  async function seedGoal(companyId: string) {
    const goalId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Test goal",
      status: "active",
    });
    return goalId;
  }

  async function seedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test project",
      status: "in_progress",
    });
    return projectId;
  }

  async function seedIssue(
    companyId: string,
    opts: { goalId?: string; projectId?: string } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "todo",
      goalId: opts.goalId ?? null,
      projectId: opts.projectId ?? null,
    });
    return issueId;
  }

  // ── upsert ────────────────────────────────────────────────────────────────

  it("upserts correctly for all five scope kinds", async () => {
    const companyId = await seedCompany();
    const svc = orgMemoryService(db);

    for (const scopeKind of ["company", "project", "goal", "agent_role", "agent"] as const) {
      const scopeId = scopeKind === "company" ? null : randomUUID();
      await svc.write({
        companyId,
        scopeKind,
        scopeId,
        key: "test_key",
        value: { x: 1 },
        sensitivity: "internal",
        propagate: true,
      });

      // Second write to same key should update value, not insert a new row.
      await svc.write({
        companyId,
        scopeKind,
        scopeId,
        key: "test_key",
        value: { x: 2 },
        sensitivity: "internal",
        propagate: true,
      });

      const rows = await db
        .select()
        .from(orgMemory)
        .where(
          and(
            eq(orgMemory.companyId, companyId),
            eq(orgMemory.scopeKind, scopeKind),
            eq(orgMemory.key, "test_key"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect((rows[0].valueJson as { x: number }).x).toBe(2);
    }
  });

  // ── readForAgent — hierarchy traversal ────────────────────────────────────

  it("readForAgent returns entries from each level of the reportsTo chain", async () => {
    const companyId = await seedCompany();
    const ceoId = await seedAgent(companyId);
    const managerId = await seedAgent(companyId, ceoId);
    const workerId = await seedAgent(companyId, managerId);
    const svc = orgMemoryService(db);

    await svc.write({ companyId, scopeKind: "agent", scopeId: ceoId, key: "ceo_note", value: "ceo", sensitivity: "internal", propagate: false });
    await svc.write({ companyId, scopeKind: "agent", scopeId: managerId, key: "mgr_note", value: "mgr", sensitivity: "internal", propagate: false });
    await svc.write({ companyId, scopeKind: "agent", scopeId: workerId, key: "worker_note", value: "worker", sensitivity: "internal", propagate: false });

    const { entries } = await svc.readForAgent(workerId);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain("worker_note");
    expect(keys).toContain("mgr_note");
    expect(keys).toContain("ceo_note");
  });

  it("innermost scope wins on key collision", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId);
    const workerId = await seedAgent(companyId, managerId);
    const svc = orgMemoryService(db);

    await svc.write({ companyId, scopeKind: "agent", scopeId: managerId, key: "shared_key", value: "from_manager", sensitivity: "internal", propagate: false });
    await svc.write({ companyId, scopeKind: "agent", scopeId: workerId, key: "shared_key", value: "from_worker", sensitivity: "internal", propagate: false });

    const { entries } = await svc.readForAgent(workerId);
    const entry = entries.find((e) => e.key === "shared_key");
    expect(entry?.value).toBe("from_worker");
  });

  it("readForAgent with no org memory entries returns empty RoleContext without error", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const svc = orgMemoryService(db);

    const { entries } = await svc.readForAgent(agentId);
    expect(entries).toEqual([]);
  });

  it("readForAgent includes goal-scope entries when issue has a goal", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const goalId = await seedGoal(companyId);
    const projectId = await seedProject(companyId);
    const issueId = await seedIssue(companyId, { goalId, projectId });
    const svc = orgMemoryService(db);

    await svc.write({ companyId, scopeKind: "goal", scopeId: goalId, key: "goal_note", value: "goal_val", sensitivity: "internal", propagate: false });

    const { entries } = await svc.readForAgent(agentId, issueId);
    expect(entries.some((e) => e.key === "goal_note")).toBe(true);
  });

  // ── sensitivity is metadata only — scope controls visibility ─────────────

  it("confidential entries are visible via goal/project scope (sensitivity does not filter)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const goalId = await seedGoal(companyId);
    const projectId = await seedProject(companyId);
    const issueId = await seedIssue(companyId, { goalId, projectId });
    const svc = orgMemoryService(db);

    await db.insert(orgMemory).values({
      companyId,
      scopeKind: "goal",
      scopeId: goalId,
      key: "confidential_goal_key",
      valueJson: "sensitive_val",
      sensitivity: "confidential",
      propagate: false,
      sourceAgentId: null,
    });

    const { entries } = await svc.readForAgent(agentId, issueId);
    expect(entries.some((e) => e.key === "confidential_goal_key")).toBe(true);
  });

  it("restricted entry is visible to agents in scope (sensitivity does not filter)", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId);
    const workerId = await seedAgent(companyId, managerId);
    const svc = orgMemoryService(db);

    await db.insert(orgMemory).values({
      companyId,
      scopeKind: "agent",
      scopeId: workerId,
      key: "restricted_key",
      valueJson: "private",
      sensitivity: "restricted",
      propagate: false,
      sourceAgentId: workerId,
    });

    // Writing agent can read its own agent-scoped entry.
    const { entries: workerEntries } = await svc.readForAgent(workerId);
    expect(workerEntries.some((e) => e.key === "restricted_key")).toBe(true);

    // Manager can read it via reportsTo chain traversal.
    const { entries: managerEntries } = await svc.readForAgent(managerId);
    expect(managerEntries.some((e) => e.key === "restricted_key")).toBe(true);
  });

  it("agents with no reportsTo receive company-scoped entries and no traversal errors", async () => {
    const companyId = await seedCompany();
    const ceoId = await seedAgent(companyId); // no reportsTo
    const svc = orgMemoryService(db);

    await svc.write({ companyId, scopeKind: "company", scopeId: null, key: "company_note", value: "hello", sensitivity: "internal", propagate: false });

    const { entries } = await svc.readForAgent(ceoId);
    expect(entries.some((e) => e.key === "company_note")).toBe(true);
  });

  // ── propagateUpward ───────────────────────────────────────────────────────

  it("propagateUpward writes a summary entry to the direct manager agent scope", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId);
    const workerId = await seedAgent(companyId, managerId);
    const svc = orgMemoryService(db);

    await svc.propagateUpward({
      agentId: workerId,
      companyId,
      key: "outcome",
      value: "task done",
    });

    const rows = await db
      .select()
      .from(orgMemory)
      .where(
        and(
          eq(orgMemory.companyId, companyId),
          eq(orgMemory.scopeKind, "agent"),
          eq(orgMemory.key, "outcome"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeId).toBe(managerId);
    expect(rows[0].valueJson).toBe("task done");
  });

  it("propagateUpward skips entries with propagate: false", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId);
    const workerId = await seedAgent(companyId, managerId);
    const svc = orgMemoryService(db);

    await svc.propagateUpward({
      agentId: workerId,
      companyId,
      key: "no_propagate",
      value: "should not appear",
      propagate: false,
    });

    const rows = await db
      .select()
      .from(orgMemory)
      .where(and(eq(orgMemory.companyId, companyId), eq(orgMemory.key, "no_propagate")));
    expect(rows).toHaveLength(0);
  });

  it("propagateUpward skips entries with sensitivity: restricted regardless of propagate flag", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId);
    const workerId = await seedAgent(companyId, managerId);
    const svc = orgMemoryService(db);

    await svc.propagateUpward({
      agentId: workerId,
      companyId,
      key: "restricted_propagate",
      value: "should not appear",
      propagate: true,
      sensitivity: "restricted",
    });

    const rows = await db
      .select()
      .from(orgMemory)
      .where(and(eq(orgMemory.companyId, companyId), eq(orgMemory.key, "restricted_propagate")));
    expect(rows).toHaveLength(0);
  });

  it("propagateUpward is a no-op for agents with no reportsTo", async () => {
    const companyId = await seedCompany();
    const ceoId = await seedAgent(companyId); // no reportsTo
    const svc = orgMemoryService(db);

    const result = await svc.propagateUpward({
      agentId: ceoId,
      companyId,
      key: "ceo_artifact",
      value: "nothing",
    });

    expect(result).toBeNull();
    const rows = await db
      .select()
      .from(orgMemory)
      .where(and(eq(orgMemory.companyId, companyId), eq(orgMemory.key, "ceo_artifact")));
    expect(rows).toHaveLength(0);
  });
});
