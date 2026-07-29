
import "./globals.css";
import { Nav } from "./components/nav";

export const metadata = {
  title: "Tern — API Migration",
  description: "Automatic migration for breaking OpenAPI changes"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <Nav />
        <main className="px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
