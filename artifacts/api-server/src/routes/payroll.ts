import { Router } from "express";
import { db } from "@workspace/db";
import { payrollRunsTable, payrollItemsTable, employeesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

const runToOut = (r: typeof payrollRunsTable.$inferSelect) => ({
  ...r,
  totalBasicSalary: toNum(r.totalBasicSalary),
  totalAllowances: toNum(r.totalAllowances),
  totalGosiEmployee: toNum(r.totalGosiEmployee),
  totalGosiEmployer: toNum(r.totalGosiEmployer),
  totalDeductions: toNum(r.totalDeductions),
  totalNetPay: toNum(r.totalNetPay),
});

const itemToOut = (i: typeof payrollItemsTable.$inferSelect) => ({
  ...i,
  basicSalary: toNum(i.basicSalary), housingAllowance: toNum(i.housingAllowance),
  transportAllowance: toNum(i.transportAllowance), otherAllowances: toNum(i.otherAllowances),
  grossSalary: toNum(i.grossSalary), gosiEmployee: toNum(i.gosiEmployee),
  gosiEmployer: toNum(i.gosiEmployer), additions: toNum(i.additions),
  deductions: toNum(i.deductions), netPay: toNum(i.netPay),
});

router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(payrollRunsTable).orderBy(desc(payrollRunsTable.period));
    res.json(rows.map(runToOut));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [run] = await db.select().from(payrollRunsTable).where(eq(payrollRunsTable.id, id)).limit(1);
    if (!run) { res.status(404).json({ error: "Not found" }); return; }
    const items = await db.select({ item: payrollItemsTable, emp: employeesTable })
      .from(payrollItemsTable)
      .leftJoin(employeesTable, eq(payrollItemsTable.employeeId, employeesTable.id))
      .where(eq(payrollItemsTable.payrollRunId, id));
    res.json({ ...runToOut(run), items: items.map(r => ({ ...itemToOut(r.item), employeeName: r.emp?.name ?? null, employeeNumber: r.emp?.employeeNumber ?? null })) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /payroll — generate a new payroll run for a period
router.post("/", async (req, res) => {
  try {
    const { period, notes } = req.body;
    // Fetch all active employees
    const employees = await db.select().from(employeesTable).where(eq(employeesTable.status, "active"));
    if (employees.length === 0) {
      res.status(400).json({ error: "No active employees found" }); return;
    }

    let totalBasic = 0, totalAllowances = 0, totalGosiEmp = 0, totalGosiEr = 0, totalNet = 0;
    const items = employees.map(emp => {
      const basic = toNum(emp.basicSalary);
      const housing = toNum(emp.housingAllowance);
      const transport = toNum(emp.transportAllowance);
      const other = toNum(emp.otherAllowances);
      const gross = basic + housing + transport + other;
      const isSaudi = emp.nationality === "SA";
      const gosiEmp = isSaudi ? basic * 0.0975 : 0;
      const gosiEr = isSaudi ? basic * 0.1175 : basic * 0.02;
      const net = gross - gosiEmp;
      totalBasic += basic; totalAllowances += housing + transport + other;
      totalGosiEmp += gosiEmp; totalGosiEr += gosiEr; totalNet += net;
      return { employeeId: emp.id, basicSalary: String(basic.toFixed(2)), housingAllowance: String(housing.toFixed(2)), transportAllowance: String(transport.toFixed(2)), otherAllowances: String(other.toFixed(2)), grossSalary: String(gross.toFixed(2)), gosiEmployee: String(gosiEmp.toFixed(2)), gosiEmployer: String(gosiEr.toFixed(2)), additions: "0", deductions: "0", netPay: String(net.toFixed(2)) };
    });

    const [run] = await db.insert(payrollRunsTable).values({
      period, status: "draft", notes,
      totalBasicSalary: String(totalBasic.toFixed(2)), totalAllowances: String(totalAllowances.toFixed(2)),
      totalGosiEmployee: String(totalGosiEmp.toFixed(2)), totalGosiEmployer: String(totalGosiEr.toFixed(2)),
      totalDeductions: "0", totalNetPay: String(totalNet.toFixed(2)),
    }).returning();
    await db.insert(payrollItemsTable).values(items.map(i => ({ ...i, payrollRunId: run.id })));
    res.status(201).json(runToOut(run));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /payroll/:id/approve
router.post("/:id/approve", async (req, res) => {
  try {
    const [run] = await db.update(payrollRunsTable).set({ status: "approved", processedAt: new Date() }).where(eq(payrollRunsTable.id, Number(req.params.id))).returning();
    if (!run) { res.status(404).json({ error: "Not found" }); return; }
    res.json(runToOut(run));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
