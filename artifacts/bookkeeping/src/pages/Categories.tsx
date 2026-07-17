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

export default function Categories() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const { data: categories, isLoading } = useListCategories();

  const createMutation = useCreateCategory({
    mutation: {
      onSuccess: () => {
        toast({ title: "Category Created", description: "The new category has been added to the chart of accounts." });
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        setOpen(false);
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.message || "Failed to create category.", variant: "destructive" });
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
        zakatRelevant: formData.get("zakatRelevant") === "on",
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
            Chart of Accounts
          </h1>
          <p className="text-muted-foreground mt-1">Manage categories, tax rules, and Zakat relevance.</p>
        </div>
        
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="lg">
              <Plus className="w-5 h-5 mr-2" />
              New Category
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Category</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Name (English)</Label>
                  <Input name="name" required placeholder="e.g. Software Subscriptions" />
                </div>
                <div className="space-y-2">
                  <Label>Name (Arabic)</Label>
                  <Input name="nameAr" required placeholder="اشتراكات البرامج" dir="rtl" />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Account Type</Label>
                <Select name="type" defaultValue="expense">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="income">Income</SelectItem>
                    <SelectItem value="expense">Expense</SelectItem>
                    <SelectItem value="asset">Asset</SelectItem>
                    <SelectItem value="liability">Liability</SelectItem>
                    <SelectItem value="equity">Equity</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Description (Optional)</Label>
                <Input name="description" />
              </div>

              <div className="flex flex-col gap-3 pt-2">
                <div className="flex items-center justify-between p-3 border rounded-md bg-secondary/20">
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium">VAT Applicable</Label>
                    <p className="text-xs text-muted-foreground">Transactions in this category will calculate 15% VAT.</p>
                  </div>
                  <Switch name="vatApplicable" defaultChecked />
                </div>
                
                <div className="flex items-center justify-between p-3 border rounded-md bg-secondary/20">
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium">Zakat Relevant</Label>
                    <p className="text-xs text-muted-foreground">Include in the end-of-year Zakat assessment.</p>
                  </div>
                  <Switch name="zakatRelevant" />
                </div>
              </div>

              <DialogFooter className="pt-4">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Create Category
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
                <th className="px-6 py-4 font-semibold">Name</th>
                <th className="px-6 py-4 font-semibold">Type</th>
                <th className="px-6 py-4 font-semibold">Tax & Compliance</th>
                <th className="px-6 py-4 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">Loading categories...</td>
                </tr>
              ) : categories?.map((cat) => (
                <tr key={cat.id} className="hover:bg-secondary/30 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-semibold text-white">{cat.name}</div>
                    <div className="text-xs text-muted-foreground font-arabic mt-1" dir="rtl">{cat.nameAr}</div>
                  </td>
                  <td className="px-6 py-4 uppercase text-xs font-bold">
                    {cat.type === 'income' && <span className="text-emerald-400">Income</span>}
                    {cat.type === 'expense' && <span className="text-destructive">Expense</span>}
                    {cat.type === 'asset' && <span className="text-primary">Asset</span>}
                    {cat.type === 'liability' && <span className="text-amber-500">Liability</span>}
                    {cat.type === 'equity' && <span className="text-purple-400">Equity</span>}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {cat.vatApplicable && <Badge variant="outline" className="border-emerald-500/30 text-emerald-500 text-[10px]">VAT 15%</Badge>}
                      {cat.zakatRelevant && <Badge variant="outline" className="border-amber-500/30 text-amber-500 text-[10px]">ZAKAT</Badge>}
                      {!cat.vatApplicable && !cat.zakatRelevant && <span className="text-muted-foreground text-xs italic">Standard</span>}
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
