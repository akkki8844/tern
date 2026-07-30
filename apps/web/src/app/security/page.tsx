import React from "react";
import { PageShell } from "@/components/page-shell";
import { SecurityCard } from "@/components/security-card";

export default function SecurityPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Security</h1>
      <SecurityCard />
    </PageShell>
  );
}
