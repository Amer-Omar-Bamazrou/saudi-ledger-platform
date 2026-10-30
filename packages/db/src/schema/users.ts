import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("viewer"), // admin | accountant | viewer
  isActive: boolean("is_active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  /**
   * 🔴 Phase 18 H-15 (DR-06 part 1, DR-27; register §11.66): true while the account's password is one someone
   * ELSE set (an admin's create or reset, an operator's break-glass). A signed-in session then reaches only the
   * way to change it; the holder's own change clears it.
   */
  passwordChangeRequired: boolean("password_change_required").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, lastLoginAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type UserRole = "admin" | "accountant" | "viewer";
