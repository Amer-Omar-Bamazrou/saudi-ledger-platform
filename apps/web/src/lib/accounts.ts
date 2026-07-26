/**
 * accounts.ts — shared KSA chart-of-accounts expense list.
 * Used by both the scanner review page and the manual bill dialog so the
 * two paths always offer the same account choices and can never drift.
 */
export const EXPENSE_ACCOUNTS = [
  "Purchases and Cost of Sales",
  "Office Supplies",
  "Utilities and Electricity",
  "Rent Expense",
  "Marketing and Advertising",
  "Professional Services",
  "Insurance Expense",
  "Maintenance and Repairs",
  "Travel and Transportation",
  "Communication Expense",
  "Salaries and Wages",
  "Bank Charges",
  "Depreciation Expense",
  "Other Operating Expenses",
] as const;

export type ExpenseAccount = (typeof EXPENSE_ACCOUNTS)[number];
export const DEFAULT_EXPENSE_ACCOUNT: ExpenseAccount = "Purchases and Cost of Sales";
