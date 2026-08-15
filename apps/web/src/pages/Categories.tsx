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

export default function Categories() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

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
    
    createMutation.mutate({
      data: {
        name: formData.get("name") as string,
        nameAr: formData.get("nameAr") as string,
        type: formData.get("type") as CategoryInputType,
        vatApplicable: formData.get("vatApplicable") === "on",
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
              <Plus className="w-5 h-5 mr-2" />
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
                <Select name="type" defaultValue="expense">
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
                  {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {t("Create Category", "إنشاء فئة")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="border rounded-lg bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
              <tr>
                <th className="px-6 py-4 font-semibold">{t("Name", "الاسم")}</th>
                <th className="px-6 py-4 font-semibold">{t("Type", "النوع")}</th>
                <th className="px-6 py-4 font-semibold">{t("Tax & Compliance", "الضريبة والامتثال")}</th>
                <th className="px-6 py-4 font-semibold">{t("Description", "الوصف")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">{t("Loading categories...", "جارٍ تحميل الفئات...")}</td>
                </tr>
              ) : categories?.map((cat) => (
                <tr key={cat.id} className="hover:bg-secondary/30 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-semibold text-white">{cat.name}</div>
                    <div className="text-xs text-muted-foreground font-arabic mt-1" dir="rtl">{cat.nameAr}</div>
                  </td>
                  <td className="px-6 py-4 uppercase text-xs font-bold">
                    {cat.type === 'income' && <span className="text-emerald-400">{t("Income", "دخل")}</span>}
                    {cat.type === 'expense' && <span className="text-destructive">{t("Expense", "مصروف")}</span>}
                    {cat.type === 'asset' && <span className="text-primary">{t("Asset", "أصل")}</span>}
                    {cat.type === 'liability' && <span className="text-amber-500">{t("Liability", "التزام")}</span>}
                    {cat.type === 'equity' && <span className="text-purple-400">{t("Equity", "حقوق الملكية")}</span>}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {cat.vatApplicable && <Badge variant="outline" className="border-emerald-500/30 text-emerald-500 text-[10px]">{t("VAT 15%", "ضريبة القيمة المضافة 15%")}</Badge>}
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
