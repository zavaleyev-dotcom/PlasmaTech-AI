import Link from 'next/link';
export default function NotFound() { return <div className="page inner-page"><span className="eyebrow">ОШИБКА 404</span><h1>Страница не найдена</h1><p>Проверьте адрес или вернитесь на главную страницу.</p><Link href="/" className="button primary">На главную</Link></div>; }
