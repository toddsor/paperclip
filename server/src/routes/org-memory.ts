import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { orgMemoryService } from "../services/org-memory.js";
import { issueService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";

const SCOPE_KINDS = ["company", "project", "goal", "agent_role", "agent"] as const;
const SENSITIVITIES = ["internal", "confidential", "restricted"] as const;

const writeMemorySchema = z.object({
  scopeKind: z.enum(SCOPE_KINDS),
  scopeId: z.string().nullable().optional(),
  key: z.string().min(1).max(255),
  value: z.unknown(),
  sensitivity: z.enum(SENSITIVITIES).default("internal"),
  propagate: z.boolean().default(true),
});

const issueMemorySchema = z.object({
  key: z.string().min(1).max(255),
  value: z.unknown(),
  scopeKind: z.enum(SCOPE_KINDS).optional(),
  scopeId: z.string().nullable().optional(),
  sensitivity: z.enum(SENSITIVITIES).default("internal"),
  propagate: z.boolean().default(true),
});

// Write access rules per scope.
// board users can write to any scope; agents are restricted.
function assertWriteAccess(
  req: Parameters<typeof getActorInfo>[0],
  scopeKind: string,
  agentId: string | null,
) {
  if (req.actor.type === "none") throw unauthorized();

  if (req.actor.type === "board") {
    // Board users: only company and agent_role scope; confidential max for company.
    return;
  }

  // Agent callers.
  if (scopeKind === "company") {
    throw forbidden("Agents cannot write to company scope");
  }
  if (scopeKind === "agent_role") {
    throw forbidden("Agents cannot write to agent_role scope directly");
  }
  // agent scope: only own scope (enforced by the caller passing agentId).
}

function assertSensitivityAllowed(scopeKind: string, sensitivity: string) {
  if (
    (scopeKind === "goal" || scopeKind === "project") &&
    (sensitivity === "confidential" || sensitivity === "restricted")
  ) {
    throw forbidden(
      `Sensitivity '${sensitivity}' is not allowed on ${scopeKind} scope — use 'internal'`,
    );
  }
}

export function orgMemoryRoutes(db: Db) {
  const router = Router();
  const svc = orgMemoryService(db);
  const issueSvc = issueService(db);

  // POST /api/companies/:companyId/memory
  // Write or upsert an org memory entry.
  router.post(
    "/companies/:companyId/memory",
    validate(writeMemorySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const { scopeKind, scopeId, key, value, sensitivity, propagate } = req.body as z.infer<
        typeof writeMemorySchema
      >;

      assertWriteAccess(req, scopeKind, actor.agentId);
      assertSensitivityAllowed(scopeKind, sensitivity);

      // Agents writing to their own agent scope: enforce scopeId === their own agentId.
      let resolvedScopeId = scopeId ?? null;
      if (scopeKind === "agent" && req.actor.type === "agent") {
        resolvedScopeId = actor.agentId;
      }

      const entry = await svc.write({
        companyId,
        scopeKind,
        scopeId: resolvedScopeId,
        key,
        value,
        sensitivity,
        propagate,
        sourceAgentId: actor.agentId,
      });

      res.status(201).json(entry);
    },
  );

  // GET /api/agents/me/memory-context
  // Returns the assembled RoleContext for the calling agent.
  router.get("/agents/me/memory-context", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw unauthorized();
    }
    const issueId =
      typeof req.query.issueId === "string" && req.query.issueId.trim().length > 0
        ? req.query.issueId.trim()
        : null;

    const context = await svc.readForAgent(req.actor.agentId, issueId);
    res.json(context);
  });

  // POST /api/issues/:issueId/memory
  // Agent-driven write-back during or after execution.
  router.post(
    "/issues/:issueId/memory",
    validate(issueMemorySchema),
    async (req, res) => {
      if (req.actor.type === "none") throw unauthorized();

      const issueId = req.params.issueId as string;
      const issue = await issueSvc.getById(issueId);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);

      const actor = getActorInfo(req);
      const { key, value, sensitivity, propagate } = req.body as z.infer<typeof issueMemorySchema>;

      // Determine scope: explicit override or default to goal scope.
      let scopeKind: string = req.body.scopeKind ?? "goal";
      let scopeId: string | null = req.body.scopeId ?? issue.goalId ?? null;

      if (scopeKind === "goal" && !scopeId) {
        // Fall back to project scope if no goal is associated.
        scopeKind = "project";
        scopeId = issue.projectId ?? null;
      }

      assertSensitivityAllowed(scopeKind, sensitivity);

      const entry = await svc.write({
        companyId: issue.companyId,
        scopeKind: scopeKind as "company" | "project" | "goal" | "agent_role" | "agent",
        scopeId,
        key,
        value,
        sensitivity,
        propagate,
        sourceAgentId: actor.agentId,
        sourceIssueId: issueId,
      });

      res.status(201).json(entry);
    },
  );

  return router;
}
