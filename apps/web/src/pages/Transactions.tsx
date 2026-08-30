import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useListTransactions, 
  useListCategories, 
  useUpdateTransaction,
  getListTransactionsQueryKey,
  getListCategoriesQueryKey,
  Transaction,
  Category,
  ListTransactionsType
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Filter, Edit2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";

export default function Transactions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<ListTransactionsType | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const [editTx, setEditTx] = useState<Transaction | null>(null);

  // Simple debounce
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(handler);
  }, [search]);

/**
 * 🔴 B6 — this list is CAPPED, and a cap the user cannot see is a wrong answer.
 *
 * The page previously asked for exactly `limit: 50` and rendered whatever came
 * back, so a tenant with 300 matching transactions saw 50 and was told nothing.
 * At dev-org size (45 rows) that is invisible, which is precisely why it
 * survived — see the timing property in CLAUDE.md §3.
 *
 * Fetch ONE MORE than we show. If the extra row arrives, truncation is a FACT
 * rather than an inference from "we got exactly the limit", and the notice
 * below states it plainly instead of the page pretending it is complete.
 */
const PAGE_SIZE = 50;

  const { data: txList, isLoading: loadingTx } = useListTransactions({
    search: debouncedSearch || undefined,
    type: typeFilter !== "all" ? typeFilter : undefined,
    category_id: categoryFilter !== "all" ? Number(categoryFilter) : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  /**
   * 🔴 The server already returned a SQL `total`; this page was inferring
   * truncation from a fetched extra row and then telling the reader to narrow
   * their filter. Disclosure was honest, but the only exit was to search
   * differently. It now reads the real count and offers the rest — "showing 50
   * of N" with a way to page, which is what the disclosure was standing in for.
   */
  const visibleRows = txList?.transactions ?? [];
  const txTotal = txList?.total ?? 0;

  const { data: categories } = useListCategories();

  const updateMutation = useUpdateTransaction({
    mutation: {
      onSuccess: () => {
        toast({ title: t("Transaction updated", "تم تحديث المعاملة"), description: t("The manual override was saved.", "تم حفظ التعديل اليدوي.") });
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        setEditTx(null);
      },
      onError: () => {
        toast({ title: t("Error", "خطأ"), description: t("Failed to update transaction", "فشل تحديث المعاملة"), variant: "destructive" });
      }
    }
  });

  const handleUpdate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editTx) return;
    const formData = new FormData(e.currentTarget);
    const categoryId = formData.get("category_id") as string;

    updateMutation.mutate({
      id: editTx.id,
      data: {
        categoryId: categoryId ? Number(categoryId) : null,
      }
    });
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{t("Ledger Entries", "قيود دفتر الأستاذ")}</h1>
        <div className="flex gap-2">
          {/* Action buttons could go here */}
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-4 items-center bg-card p-4 rounded-lg border shadow-sm">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder={t("Search descriptions...", "بحث في الأوصاف...")}
            className="ps-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        
        <Select value={typeFilter ?? undefined} onValueChange={(v: any) => setTypeFilter(v)}>
          <SelectTrigger className="w-[140px]">
            <Filter className="w-4 h-4 me-2 text-muted-foreground" />
            <SelectValue placeholder={t("Type", "النوع")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All Types", "جميع الأنواع")}</SelectItem>
            <SelectItem value="debit">{t("Debit (-)", "مدين (-)")}</SelectItem>
            <SelectItem value="credit">{t("Credit (+)", "دائن (+)")}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t("Category", "الفئة")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All Categories", "جميع الفئات")}</SelectItem>
            {categories?.map(c => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

      </div>

      <div className="border rounded-lg bg-card overflow-hidden shadow-sm">
        {loadingTx ? (
          <div className="p-8 space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-start">
              <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                <tr>
                  <th className="px-6 py-4 font-semibold">{t("Date", "التاريخ")}</th>
                  <th className="px-6 py-4 font-semibold">{t("Description", "الوصف")}</th>
                  <th className="px-6 py-4 font-semibold text-end">{t("Amount (SAR)", "المبلغ (ر.س)")}</th>
                  <th className="px-6 py-4 font-semibold">{t("Category", "الفئة")}</th>
                  <th className="px-6 py-4 font-semibold">{t("Tags", "التصنيفات")}</th>
                  <th className="px-6 py-4 text-end">{t("Actions", "إجراءات")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleRows.map(tx => (
                  <tr key={tx.id} className="hover:bg-secondary/30 transition-colors group">
                    <td className="px-6 py-4 font-mono text-muted-foreground whitespace-nowrap"><DualDate date={tx.date} /></td>
                    <td className="px-6 py-4 text-foreground max-w-[300px]">
                      <div className="truncate font-medium">{tx.description}</div>
                      {tx.descriptionAr && <div className="text-xs text-muted-foreground mt-1" dir="rtl">{tx.descriptionAr}</div>}
                    </td>
                    <td className="px-6 py-4 text-end font-mono whitespace-nowrap">
                      <span className={tx.type === 'debit' ? 'text-destructive' : 'text-primary'}>
                        {tx.type === 'debit' ? '-' : '+'}{formatCurrency(tx.amount).replace('SAR', '').trim()}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {/* Audit Tier 3: a transfer/settlement carries NO category BY
                          DESIGN — the kind IS its classification. Rendering the red
                          "Uncategorized" error badge for them read as unfinished
                          work and invited the user to "fix" a correct row. */}
                      {tx.kind === "transfer" ? (
                        <div className="flex flex-col gap-1 items-start">
                          <Badge variant="outline" className="border-blue-500/30 text-blue-400 bg-blue-500/5">
                            {t("Transfer", "تحويل")}
                          </Badge>
                          {/*
                            🔴 B5 — WHERE the money went, asked at the only time
                            anyone knows. A transfer between the business's own
                            accounts leaves total cash unchanged (so the ledger
                            is right to stay silent); money leaving the business
                            reduces cash (so the ledger is understating it).
                            Nothing on the row distinguishes them, and the fact
                            is not recoverable later — which is why this is a
                            control on the list rather than a setting somewhere.

                            "Not declared" is a real option and the default. It
                            must never quietly resolve to either answer.
                          */}
                          <select
                            aria-label={t("Where did this money go?", "إلى أين ذهب هذا المبلغ؟")}
                            className="text-[11px] bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground max-w-[190px]"
                            value={tx.transferDirection ?? ""}
                            onChange={(e) =>
                              updateMutation.mutate({
                                id: tx.id,
                                data: { transferDirection: (e.target.value || null) as never },
                              })
                            }
                          >
                            <option value="">{t("Where did it go?", "إلى أين ذهب؟")}</option>
                            <option value="own_account">
                              {t("My own account", "حساب آخر لي")}
                            </option>
                            <option value="external">
                              {t("Left the business", "خرج من المنشأة")}
                            </option>
                          </select>
                        </div>
                      ) : tx.kind === "settlement" ? (
                        <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 bg-emerald-500/5">
                          {t("Settlement", "تسوية")}
                        </Badge>
                      ) : tx.categoryName ? (
                        <div className="flex flex-col gap-1 items-start">
                          <Badge variant="outline" className="border-primary/30 text-primary/90 bg-primary/5">
                            {tx.categoryName}
                          </Badge>
                          {tx.confidenceScore != null && !tx.isManuallyOverridden && (
                            <span className="text-[10px] text-muted-foreground font-mono">
                              AI: {Math.round(tx.confidenceScore * 100)}%
                            </span>
                          )}
                        </div>
                      ) : (
                        <Badge variant="destructive" className="bg-destructive/20 text-destructive border-transparent">
                          {t("Uncategorized", "غير مصنّف")}
                        </Badge>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2">
                        {tx.reviewStatus === "pending_review" && (
                          <Badge variant="outline" className="border-amber-500/30 text-amber-500 bg-amber-500/5 text-[10px] uppercase">
                            {t("Pending review", "بانتظار المراجعة")}
                          </Badge>
                        )}
                        {tx.isManuallyOverridden && (
                          <Badge variant="secondary" className="text-[10px] uppercase">{t("Manual", "يدوي")}</Badge>
                        )}
                        {(tx.vatAmount || 0) > 0 && (
                          <Badge variant="outline" className="border-emerald-500/30 text-emerald-500 bg-emerald-500/5 text-[10px] uppercase">{t("VAT", "ضريبة القيمة المضافة")}</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-end">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => setEditTx(tx)}
                      >
                        <Edit2 className="w-4 h-4 text-muted-foreground" />
                      </Button>
                    </td>
                  </tr>
                ))}
                {visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center">
                      <div className="flex flex-col items-center justify-center text-muted-foreground">
                        <Filter className="w-8 h-8 mb-2 opacity-20" />
                        <p>{t("No transactions match your criteria.", "لا توجد معاملات تطابق معايير البحث.")}</p>
                      </div>
                    </td>
                  </tr>
                )}
                {txTotal > 0 && (
                  /* 🔴 The list is a PAGE, and the page says which one, of how
                     many, with a way to the rest. It used to say only "showing
                     the first 50 — narrow your search", which is honest about
                     the cap and offers no exit. */
                  <tr>
                    <td colSpan={6} className="px-6 py-3 border-t border-border">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {t(
                            `Showing ${page * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE + visibleRows.length, txTotal)} of ${txTotal}`,
                            `عرض ${page * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE + visibleRows.length, txTotal)} من ${txTotal}`,
                          )}
                        </span>
                        <span className="flex gap-2">
                          <Button variant="outline" size="sm" disabled={page === 0}
                            onClick={() => setPage((p) => Math.max(0, p - 1))}>
                            {t("Previous", "السابق")}
                          </Button>
                          <Button variant="outline" size="sm"
                            disabled={page * PAGE_SIZE + visibleRows.length >= txTotal}
                            onClick={() => setPage((p) => p + 1)}>
                            {t("Next", "التالي")}
                          </Button>
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={!!editTx} onOpenChange={(open) => !open && setEditTx(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Edit Transaction", "تعديل المعاملة")}</DialogTitle>
          </DialogHeader>
          {editTx && (
            <form onSubmit={handleUpdate} className="space-y-6 pt-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{editTx.description}</p>
                <p className="text-xl font-mono tracking-tight">{formatCurrency(editTx.amount)}</p>
              </div>

              <div className="space-y-3">
                <Label>{t("Category Override", "تجاوز الفئة")}</Label>
                <Select name="category_id" defaultValue={editTx.categoryId ? String(editTx.categoryId) : undefined}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("Select a category", "اختر فئة")} />
                  </SelectTrigger>
                  <SelectContent>
                    {categories?.map(c => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("This will mark the transaction as manually overridden.", "سيتم تحديد المعاملة كمعدّلة يدوياً.")}</p>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditTx(null)}>{t("Cancel", "إلغاء")}</Button>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
                  {t("Save Override", "حفظ التعديل")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
