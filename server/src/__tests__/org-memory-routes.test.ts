import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { orgMemoryRoutes } from "../routes/org-memory.js";

const mockOrgMemoryService = vi.hoisted(() => ({
  write: vi.fn(),
  readForAgent: vi.fn(),
  propagateUpward: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/org-memory.js", () => ({
  orgMemoryService: () => mockOrgMemoryService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
}));

function createApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorOverride ?? {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1"],
      runId: null,
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", orgMemoryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function createBoardApp() {
  return createApp({
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    runId: null,
    source: "session",
    isInstanceAdmin: false,
  });
}

describe("POST /api/companies/:companyId/memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a memory entry and returns 201", async () => {
    const written = { id: "mem-1", companyId: "company-1", scopeKind: "goal", scopeId: "goal-1", key: "k", valueJson: "v" };
    mockOrgMemoryService.write.mockResolvedValue(written);

    const res = await request(createBoardApp())
      .post("/api/companies/company-1/memory")
      .send({ scopeKind: "goal", scopeId: "goal-1", key: "k", value: "v", sensitivity: "internal", propagate: true });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "mem-1" });
    expect(mockOrgMemoryService.write).toHaveBeenCalledOnce();
  });

  it("rejects when agent tries to write to company scope", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/memory")
      .send({ scopeKind: "company", scopeId: null, key: "k", value: "v" });

    expect(res.status).toBe(403);
    expect(mockOrgMemoryService.write).not.toHaveBeenCalled();
  });

  it("rejects confidential sensitivity on goal scope", async () => {
    const res = await request(createBoardApp())
      .post("/api/companies/company-1/memory")
      .send({ scopeKind: "goal", scopeId: "goal-1", key: "k", value: "v", sensitivity: "confidential" });

    expect(res.status).toBe(403);
    expect(mockOrgMemoryService.write).not.toHaveBeenCalled();
  });

  it("rejects restricted sensitivity on project scope", async () => {
    const res = await request(createBoardApp())
      .post("/api/companies/company-1/memory")
      .send({ scopeKind: "project", scopeId: "proj-1", key: "k", value: "v", sensitivity: "restricted" });

    expect(res.status).toBe(403);
  });

  it("returns 422 on missing required fields", async () => {
    const res = await request(createBoardApp())
      .post("/api/companies/company-1/memory")
      .send({ scopeKind: "goal" }); // missing key and value

    expect(res.status).toBe(422);
  });
});

describe("GET /api/agents/me/memory-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns RoleContext for the calling agent", async () => {
    const context = { entries: [{ key: "k", value: "v", sensitivity: "internal", scopeKind: "goal", scopeId: "goal-1" }] };
    mockOrgMemoryService.readForAgent.mockResolvedValue(context);

    const res = await request(createApp())
      .get("/api/agents/me/memory-context");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(context);
    expect(mockOrgMemoryService.readForAgent).toHaveBeenCalledWith("agent-1", null);
  });

  it("passes issueId query param to readForAgent", async () => {
    mockOrgMemoryService.readForAgent.mockResolvedValue({ entries: [] });

    await request(createApp())
      .get("/api/agents/me/memory-context?issueId=issue-1");

    expect(mockOrgMemoryService.readForAgent).toHaveBeenCalledWith("agent-1", "issue-1");
  });

  it("returns 401 when called by board user (no agentId)", async () => {
    const res = await request(createBoardApp())
      .get("/api/agents/me/memory-context");

    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/:issueId/memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes to goal scope by default when issue has a goal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      goalId: "goal-1",
      projectId: "proj-1",
    });
    mockOrgMemoryService.write.mockResolvedValue({ id: "mem-1" });

    const res = await request(createApp())
      .post("/api/issues/issue-1/memory")
      .send({ key: "k", value: "v" });

    expect(res.status).toBe(201);
    expect(mockOrgMemoryService.write).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "goal", scopeId: "goal-1" }),
    );
  });

  it("falls back to project scope when issue has no goal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      goalId: null,
      projectId: "proj-1",
    });
    mockOrgMemoryService.write.mockResolvedValue({ id: "mem-1" });

    const res = await request(createApp())
      .post("/api/issues/issue-1/memory")
      .send({ key: "k", value: "v" });

    expect(res.status).toBe(201);
    expect(mockOrgMemoryService.write).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "project", scopeId: "proj-1" }),
    );
  });

  it("respects explicit scopeKind override", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      goalId: "goal-1",
      projectId: "proj-1",
    });
    mockOrgMemoryService.write.mockResolvedValue({ id: "mem-1" });

    await request(createApp())
      .post("/api/issues/issue-1/memory")
      .send({ key: "k", value: "v", scopeKind: "agent", scopeId: "agent-1" });

    expect(mockOrgMemoryService.write).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "agent", scopeId: "agent-1" }),
    );
  });

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post("/api/issues/nonexistent/memory")
      .send({ key: "k", value: "v" });

    expect(res.status).toBe(404);
  });

  it("rejects confidential sensitivity on goal scope", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      goalId: "goal-1",
      projectId: null,
    });

    const res = await request(createApp())
      .post("/api/issues/issue-1/memory")
      .send({ key: "k", value: "v", sensitivity: "confidential" });

    expect(res.status).toBe(403);
    expect(mockOrgMemoryService.write).not.toHaveBeenCalled();
  });
});
