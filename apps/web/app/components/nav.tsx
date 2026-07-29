
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/repositories", label: "Repositories" },
  { href: "/analysis", label: "Analysis" },
  { href: "/history", label: "History" },
  { href: "/audit", label: "Audit" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between px-6 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">Tern</Link>
        <div className="flex gap-5 text-sm text-neutral-400">
          {links.map(link => (
            <Link key={link.href} href={link.href} className={`hover:text-neutral-100 transition ${pathname === link.href ? "text-neutral-100 font-medium" : ""}`}>
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
