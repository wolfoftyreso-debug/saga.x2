import type { Metadata, Viewport } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "SAGA — Scheduled Automated Generative Authoring",
  description: "Skapa, testa och förädla innehållsflöden som låter som er.",
  applicationName: "SAGA",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "SAGA" },
};

export const viewport: Viewport = {
  themeColor: "#f7f5f0",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
