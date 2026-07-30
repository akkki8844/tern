"use client";

import Link from "next/link";
import { cn } from "./utils";
import { Home, GitBranch, FileText, Shield, Settings, Activity } from "lucide-react";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/repositories", label: "Repositories", icon: GitBranch },
  { href: "/analysis", label: "Analysis", icon: Activity },
  { href: "/history", label: "History", icon: FileText },
  { href: "/audit", label: "Audit", icon: Shield },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-60 border-r bg-background">
      <div className="flex h-14 items-center border-b px-4 font-semibold">Tern</div>
      <nav className="space-y-1 p-3">
        {nav.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent transition-colors")}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
