import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  role: text("role", { enum: ["instance_admin", "member"] })
    .notNull()
    .default("member"),
  invitedBy: text("invited_by").references(() => user.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const boardClaimTokens = pgTable("board_claim_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  code: text("code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedByUserId: text("consumed_by_user_id").references(() => user.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
