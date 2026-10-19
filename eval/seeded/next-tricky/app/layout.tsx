import { inter } from './fonts';

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
