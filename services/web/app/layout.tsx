import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sipra — Live Corridor Dashboard',
  description: 'Real-time ambulance exclusion zone visualisation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
