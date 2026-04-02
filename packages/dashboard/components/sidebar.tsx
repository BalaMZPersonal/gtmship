"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Link2,
  Workflow,
  Rocket,
  ScrollText,
  Settings,
  MessageSquare,
  Terminal,
} from "lucide-react";

const nav = [
  { href: "/connections", label: "Connections", icon: Link2 },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/deploy", label: "Deploy", icon: Rocket },
  { href: "/deploy/logs", label: "Logs", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({
  chatOpen,
  onToggleChat,
  onOpenAgent,
}: {
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenAgent: () => void;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="px-4 py-5">
        <h1 className="text-lg font-semibold tracking-tight">GTMShip</h1>
        <p className="text-xs text-zinc-500">Ship GTM workflows</p>
      </div>

      <nav className="flex-1 space-y-1 px-2">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              pathname === href
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-white"
            )}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>

      <div className="border-t border-zinc-800 p-2 space-y-1">
        <button
          onClick={onOpenAgent}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-white transition-colors"
        >
          <Terminal size={16} />
          AI Agent
        </button>
        <button
          onClick={onToggleChat}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
            chatOpen
              ? "bg-blue-600 text-white"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-white"
          )}
        >
          <MessageSquare size={16} />
          AI Chat
        </button>
      </div>
    </aside>
  );
}
