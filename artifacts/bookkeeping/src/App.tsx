import { useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Layout } from '@/components/Layout';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { setAuthTokenGetter } from '@workspace/api-client-react';
import { TOKEN_KEY } from '@/lib/api';

// Wire the generated API client to use the same Bearer token as apiFetch.
// This makes useGetVatSummary / useGetZakatSummary work inside the iframe
// where session cookies are blocked by Chrome's third-party cookie policy.
setAuthTokenGetter(() => localStorage.getItem(TOKEN_KEY));

import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Transactions from '@/pages/Transactions';
import Categorize from '@/pages/Categorize';
import Upload from '@/pages/Upload';
import VatReport from '@/pages/VatReport';
import ZakatReport from '@/pages/ZakatReport';
import Categories from '@/pages/Categories';
import Customers from '@/pages/Customers';
import Vendors from '@/pages/Vendors';
import Invoices from '@/pages/Invoices';
import Bills from '@/pages/Bills';
import JournalEntries from '@/pages/JournalEntries';
import Employees from '@/pages/Employees';
import Payroll from '@/pages/Payroll';
import Assets from '@/pages/Assets';
import Products from '@/pages/Products';
import BankAccounts from '@/pages/BankAccounts';
import Budgets from '@/pages/Budgets';
import UserManagement from '@/pages/UserManagement';
import ChangePassword from '@/pages/ChangePassword';
import TrialBalance from '@/pages/TrialBalance';
import IncomeStatement from '@/pages/IncomeStatement';
import BalanceSheet from '@/pages/BalanceSheet';
import CashFlow from '@/pages/CashFlow';
import ArAging from '@/pages/ArAging';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [, navigate] = useLocation();

  // Redirect to login in an effect to avoid setState-during-render
  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [loading, user, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      {/* Public */}
      <Route path="/login" component={Login} />

      {/* Protected — everything else */}
      <Route>
        <AuthGuard>
          <Layout>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/transactions" component={Transactions} />
              <Route path="/categorize" component={Categorize} />
              <Route path="/upload" component={Upload} />
              {/* AR */}
              <Route path="/customers" component={Customers} />
              <Route path="/invoices" component={Invoices} />
              <Route path="/ar-aging" component={ArAging} />
              {/* AP */}
              <Route path="/vendors" component={Vendors} />
              <Route path="/bills" component={Bills} />
              {/* General Ledger */}
              <Route path="/journal-entries" component={JournalEntries} />
              <Route path="/trial-balance" component={TrialBalance} />
              {/* Financial Reports */}
              <Route path="/income-statement" component={IncomeStatement} />
              <Route path="/balance-sheet" component={BalanceSheet} />
              <Route path="/cash-flow" component={CashFlow} />
              <Route path="/vat" component={VatReport} />
              <Route path="/zakat" component={ZakatReport} />
              {/* HR & Payroll */}
              <Route path="/employees" component={Employees} />
              <Route path="/payroll" component={Payroll} />
              {/* Assets & Inventory */}
              <Route path="/assets" component={Assets} />
              <Route path="/products" component={Products} />
              {/* Banking */}
              <Route path="/bank-accounts" component={BankAccounts} />
              {/* Planning */}
              <Route path="/budgets" component={Budgets} />
              {/* Settings */}
              <Route path="/categories" component={Categories} />
              <Route path="/users" component={UserManagement} />
              <Route path="/change-password" component={ChangePassword} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
        </AuthGuard>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
