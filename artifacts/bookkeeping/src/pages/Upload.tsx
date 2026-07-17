import { useState } from "react";
import { useUploadTransactions } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { UploadCloud, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { getListTransactionsQueryKey } from "@workspace/api-client-react";

export default function Upload() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"csv" | "manual">("csv");
  const [csvData, setCsvData] = useState("");
  const [autoCategorize, setAutoCategorize] = useState(true);

  const [manualRows, setManualRows] = useState<Array<{
    date: string, description: string, amount: string, type: "debit"|"credit"
  }>>([{ date: new Date().toISOString().split('T')[0], description: "", amount: "", type: "debit" }]);

  const uploadMutation = useUploadTransactions({
    mutation: {
      onSuccess: (res) => {
        toast({ 
          title: "Upload Successful", 
          description: `Inserted ${res.inserted} transactions. ${res.categorized} auto-categorized.` 
        });
        if (res.errors && res.errors.length > 0) {
          toast({
            title: "Warning",
            description: `Encountered ${res.errors.length} errors during upload.`,
            variant: "destructive"
          });
        }
        setCsvData("");
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Upload Failed", description: err?.message || "Check your data format.", variant: "destructive" });
      }
    }
  });

  const handleCsvSubmit = () => {
    if (!csvData.trim()) return;
    
    // Parse naive CSV: date, description, amount, type
    const lines = csvData.split('\n').filter(l => l.trim().length > 0);
    const rows = lines.map((line, idx) => {
      const [date, description, amountStr, typeStr] = line.split(',').map(s => s.trim());
      return {
        date,
        description,
        amount: parseFloat(amountStr),
        currency: "SAR",
        type: (typeStr?.toLowerCase() === 'credit' ? 'credit' : 'debit') as "debit" | "credit"
      };
    });

    uploadMutation.mutate({
      data: {
        rows,
        autoCategrize: autoCategorize
      }
    });
  };

  const handleManualSubmit = () => {
    const validRows = manualRows.filter(r => r.date && r.description && r.amount);
    if (validRows.length === 0) return;

    const rows = validRows.map(r => ({
      date: r.date,
      description: r.description,
      amount: parseFloat(r.amount),
      currency: "SAR",
      type: r.type
    }));

    uploadMutation.mutate({
      data: {
        rows,
        autoCategrize: autoCategorize
      }
    });
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <UploadCloud className="w-8 h-8 text-primary" />
          Data Ingestion
        </h1>
        <p className="text-muted-foreground mt-1">Import ledger entries directly into the engine.</p>
      </div>

      <div className="flex items-center justify-between p-4 rounded-lg bg-card border shadow-sm">
        <div className="space-y-0.5">
          <Label className="text-base font-semibold">Auto-Categorization</Label>
          <p className="text-sm text-muted-foreground">Run the categorization engine immediately after import.</p>
        </div>
        <Switch checked={autoCategorize} onCheckedChange={setAutoCategorize} />
      </div>

      <Card>
        <CardHeader className="border-b bg-secondary/20 pb-0">
          <div className="flex gap-6">
            <button 
              className={`pb-4 px-2 font-medium text-sm border-b-2 transition-colors ${activeTab === 'csv' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-white'}`}
              onClick={() => setActiveTab('csv')}
            >
              CSV Paste
            </button>
            <button 
              className={`pb-4 px-2 font-medium text-sm border-b-2 transition-colors ${activeTab === 'manual' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-white'}`}
              onClick={() => setActiveTab('manual')}
            >
              Manual Entry
            </button>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {activeTab === 'csv' ? (
            <div className="space-y-4">
              <div className="bg-secondary/40 p-4 rounded text-sm font-mono text-muted-foreground flex gap-3 items-start border border-border">
                <FileText className="w-5 h-5 text-primary shrink-0" />
                <div>
                  <p className="text-white mb-2 font-sans font-semibold">Expected Format (Comma Separated)</p>
                  <p>YYYY-MM-DD, Description, Amount, debit|credit</p>
                  <p className="opacity-70 mt-2">Example:</p>
                  <p className="opacity-70">2023-10-01, Office Supplies, 1500.50, debit</p>
                  <p className="opacity-70">2023-10-05, Client Payment, 12000.00, credit</p>
                </div>
              </div>
              <Textarea 
                placeholder="Paste CSV rows here..." 
                className="min-h-[300px] font-mono text-sm"
                value={csvData}
                onChange={(e) => setCsvData(e.target.value)}
              />
              <div className="flex justify-end">
                <Button onClick={handleCsvSubmit} disabled={!csvData.trim() || uploadMutation.isPending} size="lg">
                  {uploadMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Process Import
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-3">
                {manualRows.map((row, idx) => (
                  <div key={idx} className="flex gap-3 items-start bg-secondary/20 p-3 rounded border border-border relative group">
                    <div className="flex-1 grid grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Date</Label>
                        <Input type="date" value={row.date} onChange={(e) => {
                          const newRows = [...manualRows];
                          newRows[idx].date = e.target.value;
                          setManualRows(newRows);
                        }} />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-xs">Description</Label>
                        <Input placeholder="Description" value={row.description} onChange={(e) => {
                          const newRows = [...manualRows];
                          newRows[idx].description = e.target.value;
                          setManualRows(newRows);
                        }} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Amount</Label>
                        <div className="flex gap-2">
                          <Input type="number" step="0.01" placeholder="0.00" value={row.amount} onChange={(e) => {
                            const newRows = [...manualRows];
                            newRows[idx].amount = e.target.value;
                            setManualRows(newRows);
                          }} />
                          <Select value={row.type} onValueChange={(v: any) => {
                            const newRows = [...manualRows];
                            newRows[idx].type = v;
                            setManualRows(newRows);
                          }}>
                            <SelectTrigger className="w-[100px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="debit">Debit</SelectItem>
                              <SelectItem value="credit">Credit</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                    {manualRows.length > 1 && (
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="mt-6 text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => setManualRows(manualRows.filter((_, i) => i !== idx))}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              
              <div className="flex justify-between items-center pt-4">
                <Button variant="outline" onClick={() => setManualRows([...manualRows, { date: new Date().toISOString().split('T')[0], description: "", amount: "", type: "debit" }])}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Row
                </Button>
                <Button onClick={handleManualSubmit} disabled={uploadMutation.isPending || manualRows.every(r => !r.description)} size="lg">
                  {uploadMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Submit Entries
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
