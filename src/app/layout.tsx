import type { Metadata } from 'next';
import { Shell } from '@/components/shell';
import './globals.css';
export const metadata: Metadata = { title: { default: 'PlasmaTech AI — наука, технологии, интеллект', template: '%s | PlasmaTech AI' }, description: 'Платформа вакуумно-плазменных технологий, научных исследований и инженерных AI-инструментов.' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="ru"><body><a className="skip-link" href="#main-content">Перейти к содержимому</a><Shell>{children}</Shell></body></html>; }
