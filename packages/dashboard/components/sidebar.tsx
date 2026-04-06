"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Link2,
  Workflow,
  Rocket,
  ScrollText,
  Settings,
} from "lucide-react";

const nav = [
  {
    href: "/connections",
    label: "Connections",
    icon: Link2,
    match: (pathname: string) => pathname.startsWith("/connections"),
  },
  {
    href: "/workflows",
    label: "Workflows",
    icon: Workflow,
    match: (pathname: string) => pathname.startsWith("/workflows"),
  },
  {
    href: "/deploy",
    label: "Deploy",
    icon: Rocket,
    match: (pathname: string) => pathname === "/deploy",
  },
  {
    href: "/deploy/logs",
    label: "Logs",
    icon: ScrollText,
    match: (pathname: string) => pathname.startsWith("/deploy/logs"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    match: (pathname: string) => pathname.startsWith("/settings"),
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const currentPathname = pathname ?? "/";

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-zinc-800/60 bg-zinc-950">
      <div className="px-5 pb-4 pt-5">
        <Link
          href="/workflows"
          className="flex items-center gap-3"
          aria-label="GTMship dashboard home"
        >
          <div className="relative h-[44px] w-[160px]">
            <Image
              src="/gtmshiplogo_2.png"
              alt="GTMship logo"
              fill
              sizes="160px"
              className="object-contain object-left"
              priority
            />
          </div>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="text-[11px] text-zinc-500">Online</span>
          </span>
        </Link>
      </div>

      <nav className="flex-1 px-3 pt-2">
        <div className="space-y-0.5">
          {nav.map(({ href, label, icon: Icon, match }) => {
            const isActive = match(currentPathname);

            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors duration-150",
                  isActive
                    ? "bg-zinc-800/70 text-zinc-50"
                    : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                )}
              >
                {isActive && (
                  <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-cyan-400" />
                )}
                <Icon
                  size={16}
                  strokeWidth={1.8}
                  className={cn(
                    "shrink-0 transition-colors duration-150",
                    isActive
                      ? "text-cyan-400"
                      : "text-zinc-500 group-hover:text-zinc-300"
                  )}
                />
                <span>{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
