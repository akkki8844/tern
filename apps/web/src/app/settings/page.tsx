
"use client";

import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

export default function SettingsPage() {
  const [saved, setSaved] = useState(false);
  return (
    <PageShell title="Settings" subtitle="Configure Tern behavior and integrations.">
      <Card>
        <CardHeader>
          <CardTitle>LLM Provider</CardTitle>
          <CardDescription>API key and model used for fallback migrations.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="api-key">API Key</Label>
            <Input id="api-key" type="password" placeholder="sk-..." aria-label="API key" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model">Model</Label>
            <Input id="model" defaultValue="accounts/fireworks/models/llama-v3p1-70b-instruct" aria-label="Model" />
          </div>
          <Button onClick={() => setSaved(true)}>{saved ? "Saved" : "Save"}</Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
