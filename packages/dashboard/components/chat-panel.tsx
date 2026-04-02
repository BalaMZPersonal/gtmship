"use client";

import { useChat } from "ai/react";
import { X, Send, Bot, User } from "lucide-react";
import { useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({ api: "/api/chat", maxSteps: 5 });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  return (
    <div className="flex h-screen w-96 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-blue-400" />
          <span className="text-sm font-medium">GTMShip Agent</span>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-white transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <Bot size={32} className="mx-auto mb-3 text-zinc-700" />
            <p>Ask me to set up connections,</p>
            <p>create workflows, or deploy.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex gap-3">
            <div
              className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded",
                m.role === "assistant" ? "bg-blue-600" : "bg-zinc-700"
              )}
            >
              {m.role === "assistant" ? (
                <Bot size={14} />
              ) : (
                <User size={14} />
              )}
            </div>
            <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {m.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex gap-3">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-blue-600">
              <Bot size={14} />
            </div>
            <div className="flex gap-1 pt-2">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse" />
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:0.2s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:0.4s]" />
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-800 p-3 flex gap-2"
      >
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Set up HubSpot connection..."
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-blue-600"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="rounded-md bg-blue-600 px-3 py-2 text-white disabled:opacity-50 hover:bg-blue-700 transition-colors"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
