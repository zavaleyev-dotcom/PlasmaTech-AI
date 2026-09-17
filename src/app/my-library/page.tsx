import type { Metadata } from 'next';
import { LocalLibrary } from '@/components/local-library/library';
export const metadata: Metadata = { title: 'Моя библиотека' };
export default function MyLibraryPage() {
  return <div className="page inner-page"><div className="page-intro"><div className="eyebrow">SCIFINDER / LOCAL LIBRARY</div><h1>Моя библиотека</h1><p>Локальные научные статьи, книги и другие PDF. Поиск по индексу без изменения исходных документов.</p></div><LocalLibrary /></div>;
}
