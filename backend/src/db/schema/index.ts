import { relations } from "drizzle-orm";
import { apiKeys, projects, sessions } from "./account";
import { creditLots, deposits, ledgerEntries } from "./billing";
import { conversations, messages } from "./conversations";
import { holderCostLedger } from "./holder";
import { recipes, runs, runSteps } from "./runs";
import { leaderboardOptOuts } from "./settings";
import { runShares } from "./shares";

export * from "./enums";
export * from "./account";
export * from "./billing";
export * from "./system";
export * from "./runs";
export * from "./conversations";
export * from "./settings";
export * from "./shares";
export * from "./holder";

// ── Relasi (untuk kueri relasional Drizzle) ──────────────────────────────────

export const projectsRelations = relations(projects, ({ one, many }) => ({
  apiKeys: many(apiKeys),
  sessions: many(sessions),
  creditLots: many(creditLots),
  ledgerEntries: many(ledgerEntries),
  runs: many(runs),
  conversations: many(conversations),
  runShares: many(runShares),
  leaderboardOptOut: one(leaderboardOptOuts),
  holderCosts: many(holderCostLedger),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  project: one(projects, { fields: [sessions.projectId], references: [projects.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  project: one(projects, { fields: [apiKeys.projectId], references: [projects.id] }),
}));

export const creditLotsRelations = relations(creditLots, ({ one }) => ({
  project: one(projects, { fields: [creditLots.projectId], references: [projects.id] }),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  project: one(projects, { fields: [ledgerEntries.projectId], references: [projects.id] }),
  lot: one(creditLots, { fields: [ledgerEntries.lotId], references: [creditLots.id] }),
}));

export const depositsRelations = relations(deposits, ({ one }) => ({
  project: one(projects, { fields: [deposits.projectId], references: [projects.id] }),
}));

export const recipesRelations = relations(recipes, ({ many }) => ({
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  project: one(projects, { fields: [runs.projectId], references: [projects.id] }),
  runSteps: many(runSteps),
  share: one(runShares, { fields: [runs.id], references: [runShares.runId] }),
  holderCost: one(holderCostLedger, { fields: [runs.id], references: [holderCostLedger.runId] }),
}));

export const runStepsRelations = relations(runSteps, ({ one }) => ({
  run: one(runs, { fields: [runSteps.runId], references: [runs.id] }),
}));

export const runSharesRelations = relations(runShares, ({ one }) => ({
  run: one(runs, { fields: [runShares.runId], references: [runs.id] }),
  project: one(projects, { fields: [runShares.projectId], references: [projects.id] }),
}));

export const leaderboardOptOutsRelations = relations(leaderboardOptOuts, ({ one }) => ({
  project: one(projects, { fields: [leaderboardOptOuts.projectId], references: [projects.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  project: one(projects, { fields: [conversations.projectId], references: [projects.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const holderCostLedgerRelations = relations(holderCostLedger, ({ one }) => ({
  run: one(runs, { fields: [holderCostLedger.runId], references: [runs.id] }),
  project: one(projects, { fields: [holderCostLedger.projectId], references: [projects.id] }),
}));
