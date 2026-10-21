import type { ReactNode } from "react";
// The /anchors entry is safe in a server component; the main entry pulls in client code.
import { paAnchor } from "@page-assistant/react/anchors";
import { Assistant } from "@/components/Assistant";

export const metadata = { title: "Notes — Agent mode example" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <header style={{ display: "flex", gap: 16, padding: "12px 20px", borderBottom: "1px solid #e5e7eb" }}>
          <a href="/">Notes</a>
          <a href="/settings" {...paAnchor("nav.settings")}>
            Settings
          </a>
        </header>
        <main style={{ maxWidth: 720, margin: "0 auto", padding: 20 }}>{children}</main>
        <Assistant />
      </body>
    </html>
  );
}
