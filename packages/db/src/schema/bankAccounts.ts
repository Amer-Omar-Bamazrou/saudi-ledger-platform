import { pgTable, serial, text, boolean, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const bankAccountsTable = pgTable("bank_accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  bankName: text("bank_name").notNull(),
  accountNumber: text("account_number"),
  iban: text("iban"),
  currency: text("currency").default("SAR"),
  balance: numeric("balance", { precision: 15, scale: 2 }).notNull().default("0"),
  openingBalance: numeric("opening_balance", { precision: 15, scale: 2 }).default("0"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBankAccountSchema = createInsertSchema(bankAccountsTable)
  .omit({ id: true, createdAt: true })
  .extend({
    balance: z.string().or(z.number()).optional(),
    openingBalance: z.string().or(z.number()).optional(),
  });

export type InsertBankAccount = z.infer<typeof insertBankAccountSchema>;
export type BankAccount = typeof bankAccountsTable.$inferSelect;
