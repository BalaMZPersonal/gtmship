"use client";

import { useChat } from "ai/react";
import type { UIMessage } from "ai";
import { useRef, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  X,
  Send,
  Bot,
  User,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ToolRenderer,
  type OAuthCompletionPayload,
} from "@/components/agent/tool-renderers";

interface AgentTerminalProps {
  onClose: () => void;
  initialMessage?: string;
}

export function AgentTerminal({ onClose, initialMessage }: AgentTerminalProps) {
  const { messages, input, handleInputChange, handleSubmit, isLoading, append } =
    useChat({ api: "/api/agent", maxSteps: 25 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasSentInitial, setHasSentInitial] = useState(false);
  const notifiedRef = useRef<Set<string>>(new Set());
  const completedOAuthRef = useRef<Set<string>>(new Set());

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  // Notify connections page when agent successfully saves or connects
  useEffect(() => {
    for (const m of messages) {
      if (!m.toolInvocations) continue;
      for (const inv of m.toolInvocations) {
        const t = inv as unknown as { toolName: string; state: string; result?: Record<string, unknown> };
        if (t.state !== "result" || !t.result) continue;
        if (t.toolName !== "connectApiKey" && t.toolName !== "saveProvider") continue;
        const key = `${m.id}-${t.toolName}`;
        if (notifiedRef.current.has(key)) continue;
        if (t.result.error) continue;
        notifiedRef.current.add(key);
        window.dispatchEvent(new CustomEvent("connections-changed"));
      }
    }
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Send initial message if provided
  useEffect(() => {
    if (initialMessage && !hasSentInitial && messages.length === 0) {
      setHasSentInitial(true);
      append({ role: "user", content: initialMessage });
    }
  }, [initialMessage, hasSentInitial, messages.length, append]);

  const handleOAuthComplete = (payload: OAuthCompletionPayload) => {
    const providers = Array.isArray(payload.providers)
      ? payload.providers.filter(
          (slug): slug is string => typeof slug === "string" && slug.length > 0
        )
      : [payload.provider].filter(
          (slug): slug is string => typeof slug === "string" && slug.length > 0
        );
    const connectionIds = Array.isArray(payload.connectionIds)
      ? payload.connectionIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0
        )
      : [payload.connectionId].filter(
          (id): id is string => typeof id === "string" && id.length > 0
        );
    const completionKey = JSON.stringify({
      providers: [...providers].sort(),
      connectionIds: [...connectionIds].sort(),
    });

    if (completedOAuthRef.current.has(completionKey)) {
      return;
    }

    completedOAuthRef.current.add(completionKey);
    window.dispatchEvent(new CustomEvent("connections-changed"));

    const providerSummary = providers.length > 0 ? providers.join(", ") : "the integration";
    const connectionSummary =
      connectionIds.length > 0
        ? ` Connection IDs: ${connectionIds.join(", ")}.`
        : "";

    append({
      role: "user",
      content: `OAuth completed successfully in the browser for ${providerSummary}.${connectionSummary} Continue the setup here, verify the connection if useful, and do not ask me for the callback URL.`,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 bg-zinc-950">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-blue-600">
            <Terminal size={14} />
          </div>
          <div>
            <span className="text-sm font-medium">Integration Agent</span>
            <span className="ml-2 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
              bash, curl, python
            </span>
          </div>
          {isLoading && (
            <span className="ml-3 text-xs text-blue-400 animate-pulse">
              working...
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
        >
          <X size={12} />
          Close
        </button>
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 md:px-8 lg:px-16 xl:px-32 py-6"
      >
        {messages.length === 0 && !initialMessage && (
          <div className="max-w-2xl mx-auto text-center mt-16">
            <Terminal size={40} className="mx-auto mb-4 text-zinc-700" />
            <h3 className="text-lg font-medium text-zinc-300 mb-2">
              Integration Agent
            </h3>
            <p className="text-sm text-zinc-500 mb-6">
              I can help you set up custom API integrations. I have access to
              bash, curl, and python to research docs, test endpoints, and
              configure connections.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg mx-auto">
              {[
                "Set up a Notion API integration",
                "Connect to a custom REST API",
                "Help me configure OAuth for my app",
                "Test if my API key works",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => append({ role: "user", content: suggestion })}
                  className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-900 hover:border-zinc-700 transition-colors text-left"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((m) => (
            <MessageBlock
              key={m.id}
              message={m}
              onOAuthComplete={handleOAuthComplete}
            />
          ))}

          {/* Loading indicator — hide if a tool call is actively rendering */}
          {isLoading && (() => {
            const last = messages[messages.length - 1];
            if (!last) return null;
            const hasActiveTool = last.parts?.some(
              (p) => p.type === "tool-invocation" && p.toolInvocation.state === "call",
            );
            if (hasActiveTool) return null;
            return (
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
            );
          })()}
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-zinc-800 bg-zinc-950 px-4 md:px-8 lg:px-16 xl:px-32 py-3">
        <form
          onSubmit={handleSubmit}
          className="max-w-3xl mx-auto flex gap-2 items-center"
        >
          <span className="text-green-400 font-mono text-sm">$</span>
          <input
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            placeholder="Describe the integration you want to set up, or paste a docs URL..."
            className="flex-1 bg-transparent text-sm text-white placeholder-zinc-600 outline-none font-mono"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-white disabled:opacity-30 hover:bg-blue-700 transition-colors"
          >
            <Send size={14} />
          </button>
        </form>
        <p className="max-w-3xl mx-auto text-[10px] text-zinc-600 mt-1.5 ml-4">
          Powered by Activepieces (MIT) + Vercel AI SDK. The agent can execute
          curl, python, and node commands.
        </p>
      </div>
    </div>
  );
}

/* ── Markdown renderer ────────────────────────────────────── */

function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => <h2 className="text-base font-semibold text-white mt-4 mb-2">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold text-white mt-3 mb-1.5">{children}</h3>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="text-white font-medium">{children}</strong>,
        code: ({ className, children }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <code className="block rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-mono text-green-300/80 overflow-x-auto whitespace-pre my-2">
                {children}
              </code>
            );
          }
          return <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs font-mono text-zinc-300">{children}</code>;
        },
        pre: ({ children }) => <>{children}</>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-zinc-300">{children}</li>,
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="text-xs border border-zinc-800 rounded">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-zinc-900/50">{children}</thead>,
        th: ({ children }) => <th className="px-3 py-1.5 text-left text-zinc-400 font-medium border-b border-zinc-800">{children}</th>,
        td: ({ children }) => <td className="px-3 py-1.5 text-zinc-300 border-b border-zinc-800/50">{children}</td>,
        hr: () => <hr className="border-zinc-800 my-3" />,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/* ── Message rendering with sequential parts ──────────────── */

function MessageBlock({
  message,
  onOAuthComplete,
}: {
  message: UIMessage;
  onOAuthComplete?: (payload: OAuthCompletionPayload) => void;
}) {
  const { role, content, parts } = message;

  // User messages — render plain text
  if (role === "user") {
    return (
      <div className="flex gap-3 mb-1">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-zinc-700">
          <User size={14} />
        </div>
        <div className="text-sm text-zinc-300 leading-relaxed flex-1">{content}</div>
      </div>
    );
  }

  // Assistant messages — render parts sequentially (text interleaved with tool calls)
  let needsAvatar = true;
  let suppressTrailingParts = false;

  return (
    <div>
      {parts.map((part, i) => {
        if (suppressTrailingParts) {
          return null;
        }

        if (part.type === "text" && part.text) {
          const showAvatar = needsAvatar;
          needsAvatar = false;
          return (
            <div key={i} className="flex gap-3 mb-2">
              {showAvatar ? (
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-blue-600">
                  <Bot size={14} />
                </div>
              ) : (
                <div className="w-6 shrink-0" />
              )}
              <div className="text-sm text-zinc-300 leading-relaxed flex-1">
                <MarkdownContent text={part.text} />
              </div>
            </div>
          );
        }

        if (part.type === "tool-invocation") {
          needsAvatar = true;
          const invocation = part.toolInvocation as unknown as {
            toolName: string;
            args: Record<string, unknown>;
            state: "call" | "result" | "partial-call";
            result?: unknown;
          };
          const oauthResult = invocation.result as
            | { authorize_url?: string; error?: string }
            | undefined;

          if (
            invocation.toolName === "startOAuth" &&
            invocation.state === "result" &&
            oauthResult?.authorize_url &&
            !oauthResult?.error
          ) {
            suppressTrailingParts = true;
          }

          return (
            <div key={i} className="ml-9 mb-2">
              <ToolRenderer
                invocation={invocation}
                onOAuthComplete={onOAuthComplete}
              />
            </div>
          );
        }

        // step-start, reasoning, source, file — skip
        return null;
      })}
    </div>
  );
}
