import { useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Layout } from '@/components/Layout';
import { DemoBanner } from '@/components/DemoBanner';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { LanguageProvider } from '@/contexts/LanguageContext';

import Login from '@/pages/Login';
import Signup from '@/pages/Signup';
import VerificationStatus from '@/pages/VerificationStatus';
import AcceptInvite from '@/pages/AcceptInvite';
import OperatorReview from '@/pages/OperatorReview';
import Dashboard from '@/pages/Dashboard';
import Transactions from '@/pages/Transactions';
import TransactionReview from '@/pages/TransactionReview';
import Recurring from '@/pages/Recurring';
import Categorize from '@/pages/Categorize';
import Upload from '@/pages/Upload';
import VatReport from '@/pages/VatReport';
import ZakatReport from '@/pages/ZakatReport';
import Categories from '@/pages/Categories';
import Customers from '@/pages/Customers';
// Both BUILT (M21) — real routes, real persistence. The last two façades the
// 2026-08-20 audit found are gone; `KNOWN_UNBACKED` is now empty.
import Quotations from '@/pages/Quotations';
import PurchaseOrders from '@/pages/PurchaseOrders';
import Invoices from '@/pages/Invoices';
import CreditNotes from '@/pages/CreditNotes';
import Vendors from '@/pages/Vendors';
import Bills from '@/pages/Bills';
import JournalEntries from '@/pages/JournalEntries';
import Employees from '@/pages/Employees';
import Payroll from '@/pages/Payroll';
import Assets from '@/pages/Assets';
import Products from '@/pages/Products';
import BankAccounts from '@/pages/BankAccounts';
import Budgets from '@/pages/Budgets';
import UserManagement from '@/pages/UserManagement';
import CompanySettings from '@/pages/CompanySettings';
import ZatcaOnboarding from '@/pages/ZatcaOnboarding';
import Approvals from '@/pages/Approvals';
import ChangePassword from '@/pages/ChangePassword';
import TrialBalance from '@/pages/TrialBalance';
import IncomeStatement from '@/pages/IncomeStatement';
import BalanceSheet from '@/pages/BalanceSheet';
import CashFlow from '@/pages/CashFlow';
import ArAging from '@/pages/ArAging';
import InvoiceSummary from '@/pages/InvoiceSummary';
import ApAging from '@/pages/ApAging';
import PayrollReport from '@/pages/PayrollReport';
import AssetSchedule from '@/pages/AssetSchedule';
// Scanner review page
import ScanReview from '@/pages/ScanReview';
// Reports Hub + new report pages
import ReportsHub from '@/pages/ReportsHub';
import FinanceHub from '@/pages/FinanceHub';
import Analytics from '@/pages/Analytics';
import JournalReport from '@/pages/reports/JournalReport';
import AccountStatement from '@/pages/reports/AccountStatement';
import AccountSummary from '@/pages/reports/AccountSummary';
import GeneralLedger from '@/pages/reports/GeneralLedger';
import CustomerLedger from '@/pages/reports/CustomerLedger';
import OwnerEquity from '@/pages/reports/OwnerEquity';
import TaxJournalEntries from '@/pages/reports/TaxJournalEntries';
import ActivityReport from '@/pages/reports/ActivityReport';
import AgingReports from '@/pages/reports/AgingReports';
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
      <Route path="/signup" component={Signup} />
      {/* Public + token-authenticated: the invitee may have no account yet. */}
      <Route path="/accept-invite" component={AcceptInvite} />

      {/*
        Authenticated but OUTSIDE Layout: these serve users who cannot reach
        business routes at all — an org pending verification (M11.2 gate) and a
        platform operator (no org membership). Rendering them inside Layout would
        fire the sidebar's tenant-scoped queries, which 403 for both.
      */}
      <Route path="/verification">
        <AuthGuard><VerificationStatus /></AuthGuard>
      </Route>
      <Route path="/operator">
        <AuthGuard><OperatorReview /></AuthGuard>
      </Route>

      {/* Protected — everything else */}
      <Route>
        <AuthGuard>
          <Layout>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/transactions" component={Transactions} />
              <Route path="/review" component={TransactionReview} />
              <Route path="/recurring" component={Recurring} />
              <Route path="/categorize" component={Categorize} />
              <Route path="/upload" component={Upload} />
              {/* Sales */}
              <Route path="/customers" component={Customers} />
              <Route path="/quotations" component={Quotations} />
              <Route path="/invoices" component={Invoices} />
              <Route path="/credit-notes" component={CreditNotes} />
              {/* Scanner review */}
              <Route path="/scan-review" component={ScanReview} />
              {/* Purchases */}
              <Route path="/vendors" component={Vendors} />
              <Route path="/purchase-orders" component={PurchaseOrders} />
              <Route path="/bills" component={Bills} />
              {/* Report pages (each backed by a mounted API route) */}
              <Route path="/ar-aging" component={ArAging} />
              <Route path="/invoice-summary" component={InvoiceSummary} />
              <Route path="/ap-aging" component={ApAging} />
              <Route path="/payroll-report" component={PayrollReport} />
              <Route path="/asset-schedule" component={AssetSchedule} />
              {/* Reports Hub */}
              <Route path="/reports" component={ReportsHub} />
              <Route path="/finance-hub" component={FinanceHub} />
              <Route path="/analytics" component={Analytics} />
              {/* New report pages under /reports/* */}
              <Route path="/reports/journal-report" component={JournalReport} />
              <Route path="/reports/account-statement" component={AccountStatement} />
              <Route path="/reports/account-summary" component={AccountSummary} />
              <Route path="/reports/general-ledger" component={GeneralLedger} />
              <Route path="/reports/customer-ledger" component={CustomerLedger} />
              <Route path="/reports/owner-equity" component={OwnerEquity} />
              <Route path="/reports/tax-journal-entries" component={TaxJournalEntries} />
              <Route path="/reports/activity" component={ActivityReport} />
              <Route path="/reports/aging" component={AgingReports} />
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
              <Route path="/approvals" component={Approvals} />
              <Route path="/company" component={CompanySettings} />
              <Route path="/zatca" component={ZatcaOnboarding} />
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
          <LanguageProvider>
            {/*
              OUTSIDE AuthProvider and above the Router, so the banner renders
              on the login page too (D7 — "every page including login"). Placing
              it inside Layout would have covered only authenticated pages,
              which is exactly where a demo notice is least needed: the person
              deciding whether to trust these numbers sees the login screen
              first.
            */}
            <DemoBanner />
            <AuthProvider>
              <Router />
            </AuthProvider>
          </LanguageProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
