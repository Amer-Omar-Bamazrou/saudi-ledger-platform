/**
 * 🔴 Phase 18 R-11c — AC-9's census (register §11.111): every API route that can POST a journal entry, DERIVED FROM
 * THE CODE rather than listed by hand.
 *
 * A route "can post" when its handler reaches, through the code's own calls, a unit that flips a journal entry from
 * draft to posted. Those units are found, not named: a function whose own body writes `status: "posted"` (today the
 * posting seam, the generic reverse's mirror, and the manual journal's approval). The call graph is built with the
 * TypeScript checker over `apps/api/src` (tests excluded):
 *  - a unit is any function-like node; a call inside it is an edge to the callee's declaration, and a function
 *    nested inside it is an edge too (a callback it passes may run) — the census over-approximates, never under —
 *    except an INTERFACE IMPLEMENTATION's members (an approval adapter's methods): the engine runs those, not the
 *    function that builds the object;
 *  - a call to the approval ENGINE's verb (`approvalService.approve|submit|sendBack|reject`) is an edge to the one
 *    member that verb runs (`onApprove|onSubmit|onSendBack|hardDelete`) of the adapter it is given — resolved from the
 *    argument (a factory's returned object, or a named object); an adapter it cannot resolve means every adapter;
 *  - any other call to an INTERFACE member is an edge to every implementation (each object literal whose contextual
 *    type is that interface);
 *  - a route is `router.<method>(path, …handlers)` in a routes file, mounted at the prefix `routes/index.ts` gives it.
 * The census is what the AC-9 test compares, both ways, with its table of posting routes.
 */
import ts from "typescript";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "../../..");
const norm = (p: string) => p.replace(/\\/g, "/");
const SRC = norm(join(API, "src"));

export type CensusRoute = {
  method: string;
  /** The full path under /api, as the route registers it (path parameters kept, e.g. `/bills/:id/pay`). */
  path: string;
  /** The path within its mount — what the permission layer reads for its activation-route rule. */
  subPath: string;
  /** Every resource a requirePermission on the mount or the route names. */
  resources: string[];
};

export type Census = { routes: CensusRoute[]; flipUnits: string[]; routesSeen: number };

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
  ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);

export function postingRouteCensus(): Census {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(API, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
  });
  if (!parsed) throw new Error("apps/api/tsconfig.json could not be read");
  const files = parsed.fileNames.map(norm).filter((f) => f.startsWith(SRC) && !f.includes("/tests/"));
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((s) => norm(s.fileName).startsWith(SRC) && !norm(s.fileName).includes("/tests/"));

  // ── units, their calls, and the interface implementations ─────────────────
  const edges = new Map<ts.Node, Set<ts.Node>>();
  const flipUnits = new Set<ts.Node>();
  const implementations = new Map<ts.Symbol, Map<string, ts.Node[]>>();
  const add = (from: ts.Node, to: ts.Node) => { if (!edges.has(from)) edges.set(from, new Set()); edges.get(from)!.add(to); };
  const unitOf = (decl: ts.Declaration): ts.Node | null => {
    if (isFunctionLike(decl)) return decl;
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer && isFunctionLike(decl.initializer)) return decl.initializer;
    return null;
  };
  const symbolOf = (n: ts.Node): ts.Symbol | undefined => {
    let s = checker.getSymbolAtLocation(n);
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const calleeNode = (e: ts.Expression): ts.Node => (ts.isPropertyAccessExpression(e) ? e.name : e);

  /** The object literal `n` is a member of, when that literal implements an interface (an adapter). */
  const implementingLiteral = (n: ts.Node): ts.ObjectLiteralExpression | null => {
    const lit = ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent) ? n.parent
      : n.parent && ts.isPropertyAssignment(n.parent) && ts.isObjectLiteralExpression(n.parent.parent) ? n.parent.parent : null;
    if (!lit) return null;
    const iface = checker.getContextualType(lit)?.getSymbol();
    return iface?.declarations?.some((d) => ts.isInterfaceDeclaration(d)) ? lit : null;
  };
  const ENGINE_VERB: Record<string, string> = { approve: "onApprove", submit: "onSubmit", sendBack: "onSendBack", reject: "hardDelete" };
  const engineFile = `${SRC}/services/approval/approval.service.ts`;
  /** The adapter object literal(s) an engine call's first argument denotes; null when it cannot be resolved. */
  const adapterLiterals = (arg: ts.Expression): ts.ObjectLiteralExpression[] | null => {
    const fromDecl = (d: ts.Declaration | undefined): ts.ObjectLiteralExpression[] | null => {
      if (!d) return null;
      if (ts.isVariableDeclaration(d) && d.initializer && ts.isObjectLiteralExpression(d.initializer)) return [d.initializer];
      if (ts.isFunctionDeclaration(d) && d.body) {
        const out: ts.ObjectLiteralExpression[] = [];
        const walk = (x: ts.Node) => {
          if (ts.isReturnStatement(x) && x.expression && ts.isObjectLiteralExpression(x.expression)) out.push(x.expression);
          if (!isFunctionLike(x) || x === d) ts.forEachChild(x, walk);
        };
        walk(d);
        return out.length ? out : null;
      }
      return null;
    };
    if (ts.isCallExpression(arg)) return fromDecl(symbolOf(calleeNode(arg.expression))?.declarations?.[0]);
    if (ts.isIdentifier(arg)) return fromDecl(symbolOf(arg)?.declarations?.[0]);
    return null;
  };
  const memberOf = (lit: ts.ObjectLiteralExpression, name: string): ts.Node | null => {
    for (const p of lit.properties) {
      if (!p.name || !ts.isIdentifier(p.name) || p.name.text !== name) continue;
      if (ts.isMethodDeclaration(p)) return p;
      if (ts.isPropertyAssignment(p) && isFunctionLike(p.initializer)) return p.initializer;
    }
    return null;
  };
  const engineCalls: Array<{ from: ts.Node; verb: string; arg: ts.Expression | undefined }> = [];

  for (const sf of sources) {
    const visit = (n: ts.Node, unit: ts.Node | null) => {
      let current = unit;
      if (isFunctionLike(n)) {
        // a nested function may run when its container runs — but an adapter's members are run by the engine
        if (unit && !implementingLiteral(n)) add(unit, n);
        current = n;
      }
      if (ts.isObjectLiteralExpression(n)) {
        const ctx = checker.getContextualType(n);
        const iface = ctx?.getSymbol();
        if (iface && iface.declarations?.some((d) => ts.isInterfaceDeclaration(d))) {
          if (!implementations.has(iface)) implementations.set(iface, new Map());
          const byName = implementations.get(iface)!;
          for (const p of n.properties) {
            const name = p.name && ts.isIdentifier(p.name) ? p.name.text : null;
            const fn = ts.isMethodDeclaration(p) ? p : ts.isPropertyAssignment(p) && isFunctionLike(p.initializer) ? p.initializer : null;
            if (name && fn) byName.set(name, [...(byName.get(name) ?? []), fn]);
          }
        }
      }
      if (current && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "status" && ts.isStringLiteral(n.initializer) && n.initializer.text === "posted") {
        flipUnits.add(current);
      }
      if (current && (ts.isCallExpression(n) || ts.isNewExpression(n)) && n.expression) {
        const s = symbolOf(calleeNode(n.expression));
        // the approval engine's verb: the one adapter member it runs, of the adapter it is given (resolved below)
        const engineDecl = s?.declarations?.find((d) => norm(d.getSourceFile().fileName) === engineFile && ts.isMethodDeclaration(d));
        const verb = engineDecl && ts.isMethodDeclaration(engineDecl) && ts.isIdentifier(engineDecl.name) ? engineDecl.name.text : null;
        if (verb && ENGINE_VERB[verb] && ts.isCallExpression(n)) {
          engineCalls.push({ from: current, verb, arg: n.arguments[0] });
          ts.forEachChild(n, (c) => visit(c, current));
          return;
        }
        for (const d of s?.declarations ?? []) {
          const u = unitOf(d);
          if (u) add(current, u);
          else if ((ts.isMethodSignature(d) || ts.isPropertySignature(d)) && ts.isInterfaceDeclaration(d.parent)) {
            add(current, d); // resolved to the implementations below
          }
        }
      }
      ts.forEachChild(n, (c) => visit(c, current));
    };
    visit(sf, null);
  }
  // the engine's verbs → the adapter member each runs (every adapter's, when the adapter cannot be resolved)
  const allAdapters = [...implementations.values()].flatMap((byName) => [...byName.values()].flat())
    .map((fn) => (ts.isObjectLiteralExpression(fn.parent) ? fn.parent : fn.parent.parent))
    .filter((x, i, a): x is ts.ObjectLiteralExpression => !!x && ts.isObjectLiteralExpression(x) && a.indexOf(x) === i);
  for (const { from, verb, arg } of engineCalls) {
    const literals = (arg && adapterLiterals(arg)) ?? allAdapters;
    for (const lit of literals) {
      const m = memberOf(lit, ENGINE_VERB[verb]!);
      if (m) add(from, m);
    }
  }
  // interface members → every implementation
  for (const [from, tos] of edges) {
    for (const to of [...tos]) {
      if ((ts.isMethodSignature(to) || ts.isPropertySignature(to)) && ts.isInterfaceDeclaration(to.parent)) {
        const iface = symbolOf(to.parent.name);
        const name = ts.isIdentifier(to.name) ? to.name.text : "";
        for (const impl of (iface && implementations.get(iface)?.get(name)) ?? []) tos.add(impl);
      }
    }
    void from;
  }
  const reaches = (start: ts.Node): boolean => {
    const seen = new Set<ts.Node>();
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      if (flipUnits.has(n)) return true;
      for (const m of edges.get(n) ?? []) stack.push(m);
    }
    return false;
  };

  // ── mounts (routes/index.ts) ───────────────────────────────────────────────
  const permissionArgs = (args: readonly ts.Expression[]): string[] =>
    args.flatMap((a) => (ts.isCallExpression(a) && ts.isIdentifier(a.expression) && a.expression.text === "requirePermission" && a.arguments[0] && ts.isStringLiteral(a.arguments[0]) ? [a.arguments[0].text] : []));
  const mounts = new Map<string, Array<{ prefix: string; resources: string[] }>>();
  const index = sources.find((s) => norm(s.fileName) === `${SRC}/routes/index.ts`);
  if (!index) throw new Error("routes/index.ts not found");
  const visitIndex = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "use" && n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0]!)) {
      const last = n.arguments[n.arguments.length - 1]!;
      const s = ts.isIdentifier(last) ? checker.getSymbolAtLocation(last) : undefined;
      const imp = s?.declarations?.find((d) => ts.isImportClause(d) || ts.isImportSpecifier(d));
      const decl = imp ? (ts.isImportClause(imp) ? imp.parent : imp.parent.parent.parent) : undefined;
      if (decl && ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier)) {
        const file = norm(resolve(dirname(index.fileName), decl.moduleSpecifier.text.replace(/\.js$/, ".ts")));
        mounts.set(file, [...(mounts.get(file) ?? []), { prefix: (n.arguments[0] as ts.StringLiteral).text, resources: permissionArgs(n.arguments) }]);
      }
    }
    ts.forEachChild(n, visitIndex);
  };
  visitIndex(index);

  // ── routes ─────────────────────────────────────────────────────────────────
  const routes: CensusRoute[] = [];
  let routesSeen = 0;
  for (const sf of sources.filter((s) => norm(s.fileName).startsWith(`${SRC}/routes/`))) {
    const file = norm(sf.fileName);
    const at = file === `${SRC}/routes/index.ts` ? [{ prefix: "", resources: [] as string[] }] : mounts.get(file) ?? [];
    const visitRoutes = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(get|post|put|patch|delete)$/.test(n.expression.name.text)
        && n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0]!)) {
        routesSeen += at.length;
        const method = n.expression.name.text.toUpperCase();
        const sub = (n.arguments[0] as ts.StringLiteral).text;
        const handlers = n.arguments.slice(1);
        const units = handlers.flatMap((h) => {
          if (isFunctionLike(h)) return [h];
          const s = symbolOf(calleeNode(h));
          return (s?.declarations ?? []).map(unitOf).filter((u): u is ts.Node => !!u);
        });
        if (units.some(reaches)) {
          for (const m of at) {
            routes.push({ method, path: `${m.prefix}${sub === "/" ? "" : sub}` || "/", subPath: sub, resources: [...m.resources, ...permissionArgs(handlers)] });
          }
        }
      }
      ts.forEachChild(n, visitRoutes);
    };
    visitRoutes(sf);
  }
  const describe = (n: ts.Node) => {
    const sf = n.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    return `${norm(sf.fileName).slice(SRC.length + 1)}:${line + 1}`;
  };
  routes.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  return { routes, flipUnits: [...flipUnits].map(describe).sort(), routesSeen };
}
