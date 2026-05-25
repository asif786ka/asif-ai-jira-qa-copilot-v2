import "@/styles/globals.css";
import type { Metadata, Viewport } from "next";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "AI Jira QA Copilot",
  description:
    "Connect Jira + GitHub, generate platform-aware test cases for Android, iOS and Web with swappable LLM providers.",
};

export const viewport: Viewport = {
  themeColor: "#07080a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <Header />
        <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 py-10 text-xs text-gray-500">
          AI Jira QA Copilot · TypeScript + Python · pluggable providers · MIT
        </footer>
      </body>
    </html>
  );
}
