import { DoraDashboard } from "@/components/DoraDashboard";

export default function DoraPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <header>
        <h1 className="text-2xl font-semibold">DORA metrics</h1>
        <p className="text-sm text-gray-400 mt-1">
          Deployment frequency, lead time, change failure rate, and MTTR —
          computed live from your connected Jira + GitHub. No setup required
          beyond the connections you already made.
        </p>
      </header>
      <DoraDashboard />
    </div>
  );
}
