
import { Card } from "../components/card";
import Link from "next/link";

export default function DashboardPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Link href="/analysis" className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-neutral-200 transition">New Analysis</Link>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="Repositories" value="0" subtitle="Connected GitHub repos" />
        <Card title="Analyses" value="0" subtitle="Total pipeline runs" />
        <Card title="Pull Requests" value="0" subtitle="Opened migrations" />
      </div>
      <div className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="text-lg font-medium">Recent Activity</h2>
        <p className="mt-4 text-sm text-neutral-500">No recent activity. Connect a repository and start an analysis.</p>
      </div>
    </div>
  );
}
