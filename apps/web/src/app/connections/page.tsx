import { ConnectionsPanel } from "@/components/ConnectionsPanel";

export default function ConnectionsPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <header>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-gray-400 mt-1">
          Tokens are stored in an encrypted, HttpOnly cookie. They never touch localStorage and
          are never logged. Disconnect at any time below.
        </p>
      </header>
      <ConnectionsPanel />
    </div>
  );
}
