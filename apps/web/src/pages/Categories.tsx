import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useListCategories, 
  useCreateCategory,
  getListCategoriesQueryKey,
  CategoryInputType
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Tags, Plus, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

/** M18.1 — the liquidity class is meaningful only on these two account types. */
const isBalanceSheet = (type: string) => type === "asset" || type === "liability";

/**
 * Owner-legible labels (Finance Hub Q4). "Quick asset" is jargon; "cash within
 * 12 months" is the same fact in words the reader already has. The stored
 * VALUES stay the accounting terms — it is the label that translates.
 */
const LIQUIDITY_OPTIONS = [
  { value: "cash",        en: "Cash or bank",                     ar: "نقد أو بنك" },
  { value: "quick",       en: "Expected as cash within 12 months", ar: "يُتوقع تحصيله نقداً خلال 12 شهراً" },
  { value: "current",     en: "Used or owed within 12 months",     ar: "يُستخدم أو يُستحق خلال 12 شهراً" },
  { value: "non_current", en: "Longer than 12 months",             ar: "أطول من 12 شهراً" },
];

export default function Categories() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  // Drives whether the liquidity selector is shown — it must react to the
  // account-type choice, so the form needs this one piece of state.
  const [newType, setNewType] = useState<string>("expense");

  const { data: categories, isLoading } = useListCategories();

  const createMutation = useCreateCategory({
    mutation: {
      onSuccess: () => {
        toast({ title: t("Category Created", "تم إنشاء الفئة"), description: t("The new category has been added to the chart of accounts.", "تمت إضافة الفئة الجديدة إلى دليل الحسابات.") });
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        setOpen(false);
      },
      onError: (err: any) => {
        toast({ title: t("Error", "خطأ"), description: err?.message || t("Failed to create category.", "فشل في إنشاء الفئة."), variant: "destructive" });
      }
    }
  });

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const type = formData.get("type") as CategoryInputType;
    const liquidityClass = formData.get("liquidityClass") as string;

    createMutation.mutate({
      data: {
        name: formData.get("name") as string,
        nameAr: formData.get("nameAr") as string,
        type,
        vatApplicable: formData.get("vatApplicable") === "on",
        // M18.1 — only sent for balance-sheet accounts; the server refuses it
        // on any other type, so sending a stale value from a switched form
        // would 400 rather than silently store nonsense.
        liquidityClass: isBalanceSheet(type) && liquidityClass ? (liquidityClass as never) : null,
        description: formData.get("description") as string,
      }
    });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Tags className="w-8 h-8 text-primary" />
            {t("Chart of Accounts", "دليل الحسابات")}
          </h1>
          <p className="text-muted-foreground mt-1">{t("Manage categories and tax rules.", "إدارة الفئات وقواعد الضرائب.")}</p>
        </div>
        
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="lg">
              <Plus className="w-5 h-5 me-2" />
              {t("New Category", "فئة جديدة")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("Create Category", "إنشاء فئة")}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t("Name (English)", "الاسم (بالإنجليزية)")}</Label>
                  <Input name="name" required placeholder={t("e.g. Software Subscriptions", "مثال: اشتراكات البرامج")} />
                </div>
                <div className="space-y-2">
                  <Label>{t("Name (Arabic)", "الاسم (بالعربية)")}</Label>
                  <Input name="nameAr" required placeholder="اشتراكات البرامج" dir="rtl" />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t("Account Type", "نوع الحساب")}</Label>
                <Select name="type" defaultValue="expense" onValueChange={setNewType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="income">{t("Income", "دخل")}</SelectItem>
                    <SelectItem value="expense">{t("Expense", "مصروف")}</SelectItem>
                    <SelectItem value="asset">{t("Asset", "أصل")}</SelectItem>
                    <SelectItem value="liability">{t("Liability", "التزام")}</SelectItem>
                    <SelectItem value="equity">{t("Equity", "حقوق الملكية")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/*
                M18.1 — shown ONLY for asset and liability accounts, because the
                distinction is meaningless elsewhere and the server refuses it
                there. Asking every account "how liquid is this?" would teach
                the user that the answer does not matter.
              */}
              {isBalanceSheet(newType) && (
                <div className="space-y-2">
                  <Label>{t("When does this turn into cash?", "متى يتحول هذا إلى نقد؟")}</Label>
                  <Select name="liquidityClass" defaultValue="current">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LIQUIDITY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{t(o.en, o.ar)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Used by the Finance Hub to work out whether you can cover your short-term obligations.",
                      "تستخدمه لوحة المالية لتحديد ما إذا كان بإمكانك تغطية التزاماتك قصيرة الأجل.",
                    )}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label>{t("Description (Optional)", "الوصف (اختياري)")}</Label>
                <Input name="description" />
              </div>

              <div className="flex flex-col gap-3 pt-2">
                <div className="flex items-center justify-between p-3 border rounded-md bg-secondary/20">
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium">{t("VAT Applicable", "خاضع لضريبة القيمة المضافة")}</Label>
                    <p className="text-xs text-muted-foreground">{t("Transactions in this category will calculate 15% VAT.", "ستُحسب ضريبة القيمة المضافة بنسبة 15% على معاملات هذه الفئة.")}</p>
                  </div>
                  <Switch name="vatApplicable" defaultChecked />
                </div>
                {/*
                  M17.0 — the "Zakat Relevant" toggle was removed. It wrote a
                  flag whose only reader was a report that returned SAR 0.00
                  for almost every tenant, so the switch did nothing a user
                  could observe.
                  Zakat classification returns in M17.3 as a chart-of-accounts
                  mapping (which worksheet line this account feeds), not a
                  boolean. See docs/product/design-zakat-module.md.
                */}
              </div>

              <DialogFooter className="pt-4">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("Cancel", "إلغاء")}</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  {t("Create Category", "إنشاء فئة")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="border rounded-lg bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-start">
            <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
              <tr>
                <th className="px-6 py-4 font-semibold">{t("Name", "الاسم")}</th>
                <th className="px-6 py-4 font-semibold">{t("Type", "النوع")}</th>
                <th className="px-6 py-4 font-semibold">{t("Turns into cash", "يتحول إلى نقد")}</th>
                <th className="px-6 py-4 font-semibold">{t("Tax & Compliance", "الضريبة والامتثال")}</th>
                <th className="px-6 py-4 font-semibold">{t("Description", "الوصف")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">{t("Loading categories...", "جارٍ تحميل الفئات...")}</td>
                </tr>
              ) : categories?.map((cat) => (
                <tr key={cat.id} className="hover:bg-secondary/30 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-semibold text-foreground">{cat.name}</div>
                    <div className="text-xs text-muted-foreground font-arabic mt-1" dir="rtl">{cat.nameAr}</div>
                  </td>
                  <td className="px-6 py-4 uppercase text-xs font-bold">
                    {cat.type === 'income' && <span className="text-positive">{t("Income", "دخل")}</span>}
                    {cat.type === 'expense' && <span className="text-destructive">{t("Expense", "مصروف")}</span>}
                    {cat.type === 'asset' && <span className="text-primary">{t("Asset", "أصل")}</span>}
                    {cat.type === 'liability' && <span className="text-attention-surface">{t("Liability", "التزام")}</span>}
                    {cat.type === 'equity' && <span className="text-purple-400">{t("Equity", "حقوق الملكية")}</span>}
                  </td>
                  {/*
                    M18.1 — 🔴 an UNCLASSIFIED balance-sheet account is shown as
                    such, not left blank. A blank cell reads as "nothing to say
                    here"; this account is in fact excluded from the Finance
                    Hub's liquidity figures, and the user is the only one who
                    can fix that.
                  */}
                  <td className="px-6 py-4 text-xs">
                    {!isBalanceSheet(cat.type) ? (
                      <span className="text-muted-foreground/40">—</span>
                    ) : cat.liquidityClass ? (
                      <span className="text-muted-foreground">
                        {t(
                          LIQUIDITY_OPTIONS.find((o) => o.value === cat.liquidityClass)?.en ?? cat.liquidityClass,
                          LIQUIDITY_OPTIONS.find((o) => o.value === cat.liquidityClass)?.ar ?? cat.liquidityClass,
                        )}
                      </span>
                    ) : (
                      <Badge variant="outline" className="border-attention-surface/40 text-attention-surface text-[10px]">
                        {t("Not set", "غير محدد")}
                      </Badge>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {cat.vatApplicable && <Badge variant="outline" className="border-positive-surface/30 text-positive-surface text-[10px]">{t("VAT 15%", "ضريبة القيمة المضافة 15%")}</Badge>}
                      {!cat.vatApplicable && <span className="text-muted-foreground text-xs italic">{t("Standard", "قياسي")}</span>}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground max-w-[250px] truncate">
                    {cat.description || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
