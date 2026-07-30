import React from "react";
import { PageShell } from "@/components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SettingsPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="github-app-id">GitHub App ID</Label>
            <Input id="github-app-id" placeholder="123456" />
          </div>
          <Button>Save</Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
