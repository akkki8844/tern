
import "./globals.css";
import { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Sidebar } from "@/components/sidebar";
import { SkipLink } from "@/components/skip-link";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Tern — OpenAPI Migration Platform",
  description: "Automatically migrate TypeScript repositories when OpenAPI specifications change.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased bg-background text-foreground min-h-screen`}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <SkipLink />
          <div className="flex min-h-screen">
            <Sidebar />
            <main id="main-content" className="flex-1 flex flex-col overflow-hidden outline-none">
              <div className="flex-1 overflow-auto p-6 md:p-8">
                {children}
              </div>
            </main>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
