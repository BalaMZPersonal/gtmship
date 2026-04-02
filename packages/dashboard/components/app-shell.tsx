"use client";

import { useState, useEffect, useCallback } from "react";
import { Sidebar } from "@/components/sidebar";
import { ChatPanel } from "@/components/chat-panel";
import { AgentTerminal } from "@/components/agent-terminal";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentInitialMessage, setAgentInitialMessage] = useState<
    string | undefined
  >();

  const handleOpenAgent = useCallback((initialMessage?: string) => {
    setAgentInitialMessage(initialMessage);
    setAgentOpen(true);
    setChatOpen(false);
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
      <Sidebar
        chatOpen={chatOpen}
        onToggleChat={() => {
          setChatOpen(!chatOpen);
          if (agentOpen) setAgentOpen(false);
        }}
        onOpenAgent={() => handleOpenAgent()}
      />
      <main className="flex-1 overflow-y-auto h-screen">{children}</main>
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
      {agentOpen && (
        <AgentTerminal
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
