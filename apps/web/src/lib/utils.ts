import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// SAR is hardcoded because the API REFUSES any other currency
// (writeGuards.assertSupportedCurrency + DB CHECK 0062). Before that boundary
// existed this formatter labelled a stored USD amount "SAR" — the number real,
// the unit a lie. It is now correct by construction rather than by luck.
export function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-SA', {
    style: 'currency',
    currency: 'SAR',
  }).format(amount)
}

export function formatDate(dateStr: string) {
  return new Date(dateStr).toISOString().split('T')[0];
}
