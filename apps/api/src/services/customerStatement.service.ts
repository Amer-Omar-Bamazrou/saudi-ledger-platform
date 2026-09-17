/**
 * Phase E — the customer statement: every event that moved the customer's
 * position, in chronology, with three running balances and a derived net.
 *
 * The statement is REBUILT from the events — invoices, credit notes,
 * receipts, allocations, credit applications, unallocations, refunds — never
 * read off the caches, so it is the independent check of them: its `current`
 * position (all events) is compared with the subledger position
 * (`customerStatementRepository.positions`, which reads the caches and the
 * active-allocation sets) and the statement SAYS whether the two agree.
 */
import { NotFoundError, BadRequestError } from "../lib/errors";
import { round2 } from "../lib/money";
import { customersRepository } from "../repositories/customers.repository";
import { customerStatementRepository, type StatementEventRow } from "../repositories/customerStatement.repository";

export type Position = { receivable: number; creditBalance: number; depositBalance: number; netPosition: number };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function position(receivable: number, creditBalance: number, depositBalance: number): Position {
  const r = round2(receivable), c = round2(creditBalance), d = round2(depositBalance);
  return { receivable: r, creditBalance: c, depositBalance: d, netPosition: round2(r - c - d) };
}

function advance(p: Position, e: StatementEventRow): Position {
  return position(p.receivable + e.receivableDelta, p.creditBalance + e.creditDelta, p.depositBalance + e.depositDelta);
}

const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

export const customerStatementService = {
  async statement(customerId: number, range: { from?: string; to?: string }) {
    for (const [k, v] of Object.entries(range)) {
      if (v != null && !ISO_DATE.test(v)) throw new BadRequestError(`${k === "from" ? "date_from" : "date_to"} must be YYYY-MM-DD`);
    }
    if (range.from && range.to && range.from > range.to) throw new BadRequestError("date_from must not be after date_to");
    const [customer] = await customersRepository.findById(customerId);
    if (!customer) throw new NotFoundError("Customer not found");

    const events = await customerStatementRepository.events(customerId);

    // Opening = everything before the window; lines = the window; current = everything.
    let running = position(0, 0, 0);
    let opening = running;
    const lines: Array<StatementEventRow & Position> = [];
    let seq = 0;
    for (const e of events) {
      const before = range.from != null && e.date < range.from;
      const after = range.to != null && e.date > range.to;
      running = advance(running, e);
      if (before) { opening = running; continue; }
      if (after) continue;
      seq += 1;
      lines.push({ ...e, ...running });
    }
    const closing = lines.length > 0 ? position(lines[lines.length - 1]!.receivable, lines[lines.length - 1]!.creditBalance, lines[lines.length - 1]!.depositBalance) : opening;
    const current = running;

    const [sub] = await customerStatementRepository.positions({ customerId });
    const subledger = position(sub?.receivable ?? 0, sub?.creditBalance ?? 0, sub?.depositBalance ?? 0);
    const reconciled =
      same(current.receivable, subledger.receivable) && same(current.creditBalance, subledger.creditBalance) && same(current.depositBalance, subledger.depositBalance);

    return {
      customerId,
      customerName: customer.name,
      customerNameAr: customer.nameAr ?? null,
      period: { from: range.from ?? null, to: range.to ?? null },
      opening,
      lines: lines.map((l, i) => ({
        seq: i + 1,
        date: l.date,
        kind: l.kind,
        documentNumber: l.documentNumber,
        reference: l.reference,
        description: l.description,
        amount: round2(l.amount),
        receivableDelta: round2(l.receivableDelta),
        creditDelta: round2(l.creditDelta),
        depositDelta: round2(l.depositDelta),
        receivable: l.receivable,
        creditBalance: l.creditBalance,
        depositBalance: l.depositBalance,
        netPosition: l.netPosition,
        invoiceId: l.invoiceId,
        paymentId: l.paymentId,
        creditNoteId: l.creditNoteId,
        allocationId: l.allocationId,
        refundId: l.refundId,
        journalEntryId: l.journalEntryId,
      })),
      closing,
      // The position after EVERY event (not only the window's), against the subledger.
      current,
      subledger,
      reconciled,
      eventCount: seq,
    };
  },
};
