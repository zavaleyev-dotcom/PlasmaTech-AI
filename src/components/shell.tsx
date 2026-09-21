'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { navigation } from '@/lib/content';
import { moduleBadge } from '@/modules/workspace/registry';
import { Icon } from './icon';
export function Shell({ children }: { children: React.ReactNode }) {
 const pathname = usePathname(); const [open, setOpen] = useState(false);
 const isActive = (href: string) => pathname === href || (href === '/workspace' && pathname.startsWith('/workspace/'));
 const current = navigation.find(n => isActive(n.href))?.label || 'Страница';
 return <div className="app-shell">
 <aside className={`sidebar ${open ? 'is-open' : ''}`}><button className="sidebar-close icon-button" onClick={() => setOpen(false)} aria-label="Закрыть меню"><Icon name="close"/></button><Link className="brand" href="/" onClick={() => setOpen(false)}><span className="brand-mark"><Icon name="atom" size={27}/></span><span>PlasmaTech <b>AI</b><small>SCIENCE. ENGINEERING. INTELLIGENCE.</small></span></Link>
 <div className="nav-label">ПЛАТФОРМА</div><nav aria-label="Основная навигация">{navigation.map(n => <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={`nav-link ${isActive(n.href) ? 'active' : ''}`} aria-current={pathname === n.href ? 'page' : undefined}><Icon name={n.icon}/><span>{n.label}</span>{n.href === '/workspace' && <span className="nav-count">6</span>}</Link>)}</nav>
 <div className="sidebar-bottom"><div className="lab-symbol"><Icon name="flask" size={22}/></div><strong>От науки к технологии</strong><p>Инженерный подход.<br/>Возможности искусственного интеллекта.</p><div className="demo-status"><span/> Локальная версия — без ИИ-провайдера</div></div><div className="sidebar-footer">© {new Date().getFullYear()} PlasmaTech AI <span>v0.1</span></div></aside>
 {open && <button className="nav-backdrop" aria-label="Закрыть меню" onClick={() => setOpen(false)}/>}
 <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" onClick={() => setOpen(!open)} aria-label={open ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={open}><Icon name={open ? 'close' : 'menu'}/></button><span>Платформа</span><Icon name="chevron" size={14}/><strong>{current}</strong></div><div className="topbar-right"><span className="technical-label">VACUUM & PLASMA TECHNOLOGIES</span><span className="mode-badge">{moduleBadge(pathname)}</span></div></header><main id="main-content">{children}</main><footer className="main-footer"><span>PlasmaTech AI · Наука и инженерия в одном пространстве</span><span>Создано для сложных задач <Icon name="atom" size={15}/></span></footer></div></div>;
}
