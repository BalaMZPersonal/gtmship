"use client";

import { useState, useEffect, useCallback } from "react";
import { Sidebar } from "@/components/sidebar";
import { AgentTerminal } from "@/components/agent-terminal";
import { UpdateBanner } from "@/components/update-banner";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentSessionKey, setAgentSessionKey] = useState(0);
  const [agentInitialMessage, setAgentInitialMessage] = useState<
    string | undefined
  >();

  const handleOpenAgent = useCallback((initialMessage?: string) => {
    setAgentInitialMessage(initialMessage);
    setAgentSessionKey((current) => current + 1);
    setAgentOpen(true);
  }, []);

  // Listen for "open-agent" events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      handleOpenAgent(detail?.initialMessage);
    };
    window.addEventListener("open-agent", handler);
    return () => window.removeEventListener("open-agent", handler);
  }, [handleOpenAgent]);

  return (
    <div className="flex">
      <Sidebar />
      <div className="flex h-screen min-w-0 flex-1 flex-col">
        <UpdateBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      {agentOpen && (
        <AgentTerminal
          key={agentSessionKey}
          onClose={() => {
            setAgentOpen(false);
            setAgentInitialMessage(undefined);
          }}
          initialMessage={agentInitialMessage}
        />
      )}
    </div>
  );
}
