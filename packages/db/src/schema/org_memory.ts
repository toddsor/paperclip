import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const orgMemory = pgTable(
  "org_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id"),
    key: text("key").notNull(),
    valueJson: jsonb("value_json").notNull(),
    sensitivity: text("sensitivity").notNull().default("internal"),
    propagate: boolean("propagate").notNull().default(true),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("org_memory_company_idx").on(table.companyId),
    scopeIdx: index("org_memory_scope_idx").on(table.companyId, table.scopeKind, table.scopeId),
    uniqueKey: unique("org_memory_unique_key")
      .on(table.companyId, table.scopeKind, table.scopeId, table.key)
      .nullsNotDistinct(),
  }),
);
