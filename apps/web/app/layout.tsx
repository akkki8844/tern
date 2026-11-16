import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./components/theme-provider";
import { Sidebar } from "./components/sidebar";
import { SkipLink } from "./components/skip-link";
import { Toaster } from "./components/toaster";

export const metadata: Metadata = {
  title: "Capibara — API Migration Platform",
  description: "Automated, safe API migration for engineering teams"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SkipLink />
          <Sidebar />
          <main id="main-content" className="ml-60 min-h-screen p-6">
            {children}
          </main>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
