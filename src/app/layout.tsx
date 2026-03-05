import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "Poker - Next.js & Bun",
  description: "A premium poker game built with Next.js and Bun.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
