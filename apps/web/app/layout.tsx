import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Frame-2 MVP Workbench",
  description: "Director Deck inspired MVP workbench"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
