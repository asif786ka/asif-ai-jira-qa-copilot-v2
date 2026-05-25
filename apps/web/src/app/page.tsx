import Link from "next/link";
import { Wizard } from "@/components/Wizard";
import { ArrowRight, GitBranch, Layers, Sparkles } from "lucide-react";

export default function HomePage() {
  return (
    <div className="space-y-10 animate-fade-in">
      <section className="text-center space-y-4 pt-6">
        <span className="pill bg-bg-panel">
          <Sparkles className="w-3 h-3 text-accent" />
          AI-generated test cases · platform-aware
        </span>
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight">
          Turn any Jira ticket into{" "}
          <span className="bg-gradient-to-r from-accent to-accent-glow bg-clip-text text-transparent">
            Android · iOS · Web
          </span>{" "}
          test cases.
        </h1>
        <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto">
          Connect your Jira project and GitHub repo. Pick a ticket. Pick a platform.
          We pull repo context and prompt your preferred LLM with QA-grade rules to generate
          structured test cases in seconds.
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <Link href="/connections" className="btn-primary">
            Connect Jira + GitHub <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      <section className="grid md:grid-cols-3 gap-4">
        <FeatureCard
          icon={<Layers className="w-5 h-5 text-accent" />}
          title="Platform-aware prompts"
          body="Espresso/UI Automator for Android, XCUITest for iOS, Playwright/Cypress for Web. The system prompt changes with the target."
        />
        <FeatureCard
          icon={<GitBranch className="w-5 h-5 text-accent" />}
          title="Repo-grounded"
          body="We pull your README, file tree sample, and key config files into the prompt so test cases match how your code actually works."
        />
        <FeatureCard
          icon={<Sparkles className="w-5 h-5 text-accent" />}
          title="Swappable LLMs"
          body="OpenAI and Gemini today. Anthropic, local Ollama, or your own provider — drop in a new file implementing LLMProvider."
        />
      </section>

      <Wizard />
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed">{body}</p>
    </div>
  );
}
