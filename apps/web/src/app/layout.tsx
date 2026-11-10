import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Asset Monitor",
  description: "Self-hosted read-only crypto portfolio dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body className="antialiased">{children}</body>
    </html>
  );
}
