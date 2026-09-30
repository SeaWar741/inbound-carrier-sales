import { AntdRegistry } from "@ant-design/nextjs-registry";
import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AntdProvider } from "@/components/antd-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control Tower",
  description: "Live view of inbound carrier calls for senior reps.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-[100dvh]">
        {/* The registry writes antd's styles into the server render, so its selectors never flash unstyled. */}
        <AntdRegistry>
          <AntdProvider>{children}</AntdProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
