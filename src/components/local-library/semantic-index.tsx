'use client';
import { useCallback, useEffect, useState } from 'react';
import styles from '@/components/scifinder/search.module.css';

type SemanticIndexStatus = 'not_configured' | 'empty' | 'partial' | 'ready' | 'stale' | 'building' | 'error';
interface SemanticIndexProgressView {
  running: boolean; cancelled: boolean;
  total: number; processed: number; reused: number; embedded: number;
  failed: number; skipped: number; orphanRemoved: number;
  percent: number; elapsedMs: number;
}
interface SemanticIndexInfo {
  status: SemanticIndexStatus;
  totalChunks: number; embeddedChunks: number; coveragePercent: number;
  provider: string | null; model: string | null; dimension: number | null;
  invalidVectorCount: number; staleCount: number; orphanCount: number;
  lastBuildTime: string | null; lastError: string | null;
  requiresExternalConfirmation: boolean; outboundDataDescription: string | null;
  progress: SemanticIndexProgressView | null;
}

const SAMPLE_TIERS = [200, 2000, 10000] as const;
const STATUS_LABELS: Record<SemanticIndexStatus, string> = {
  not_configured: 'Провайдер эмбеддингов не настроен',
  empty: 'Индекс пуст',
  partial: 'Построен частично',
  ready: 'Готов',
  stale: 'Есть устаревшие записи',
  building: 'Строится…',
  error: 'Ошибка',
};

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${s % 60} с`;
}

export function SemanticIndex() {
  const [info, setInfo] = useState<SemanticIndexInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<(typeof SAMPLE_TIERS)[number]>(200);
  const [confirmExternal, setConfirmExternal] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/library/semantic', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Не удалось получить статус.');
      setInfo(data); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось получить статус семантического индекса.'); }
  }, []);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    if (!info?.progress?.running) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [info?.progress?.running, load]);

  async function start() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/library/semantic', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleSize: tier, confirmExternal }), signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Не удалось запустить индексирование.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось запустить индексирование.'); }
    finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/library/semantic', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Не удалось остановить индексирование.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось остановить индексирование.'); }
    finally { setBusy(false); }
  }

  const running = !!info?.progress?.running;
  const notConfigured = info?.status === 'not_configured';
  const alreadyCovered = !!info && info.embeddedChunks >= tier;
  const needsConfirmation = !!info?.requiresExternalConfirmation;
  const startDisabled = busy || running || notConfigured || alreadyCovered || (needsConfirmation && !confirmExternal) || !info;

  return <section aria-label="Семантический индекс" className={styles.results}>
    <p className={styles.hint}>
      Семантический индекс позволяет искать «по смыслу», а не только по точным словам. Он строится отдельно от обычного
      текстового поиска и требует явного запуска здесь. Полное индексирование будет доступно после дополнительной проверки -
      сейчас можно построить ограниченный тестовый объём.
    </p>
    {error && <div role="alert" className={`${styles.status} ${styles.error}`}>{error}<button className="button secondary" onClick={() => void load()}>Обновить статус</button></div>}
    {!info && !error && <p role="status">Загрузка статуса…</p>}
    {info && <div className={styles.results} role="status">
      <p>
        Статус: <strong>{STATUS_LABELS[info.status]}</strong>
        {info.totalChunks > 0 && <> · Покрытие: {info.embeddedChunks} из {info.totalChunks} фрагментов ({info.coveragePercent}%)</>}
      </p>
      {info.provider && <p className={styles.hint}>Провайдер: {info.provider}{info.model ? ` · модель ${info.model}` : ''}{info.dimension ? ` · размерность ${info.dimension}` : ''}</p>}
      {(info.staleCount > 0 || info.orphanCount > 0 || info.invalidVectorCount > 0) &&
        <p className={styles.hint}>
          {info.staleCount > 0 && <>Устаревших: {info.staleCount}. </>}
          {info.orphanCount > 0 && <>Ссылаются на удалённые фрагменты: {info.orphanCount}. </>}
          {info.invalidVectorCount > 0 && <>Повреждённых записей: {info.invalidVectorCount}. </>}
          Они не участвуют в поиске и будут исправлены при следующем запуске.
        </p>}
      <p className={styles.hint}>Последнее завершённое построение: {info.lastBuildTime ? new Date(info.lastBuildTime).toLocaleString('ru-RU') : 'ещё не выполнялось'}</p>
      {info.lastError && !running && <p role="alert" className={styles.hint}>{info.lastError}</p>}
      {notConfigured && <p className={styles.hint}>Чтобы включить семантический поиск, задайте провайдер эмбеддингов в конфигурации сервера (переменная окружения). Обычный поиск по словам и вся остальная библиотека продолжают работать без него.</p>}
    </div>}

    {info && !notConfigured && <div className={`${styles.publication} ${styles.results}`}>
      <div className={styles.form}>
        <label className={styles.field}>Объём тестового индексирования
          <select className={styles.control} value={tier} disabled={busy || running} onChange={e => setTier(Number(e.target.value) as (typeof SAMPLE_TIERS)[number])}>
            {SAMPLE_TIERS.map(n => <option key={n} value={n}>{n.toLocaleString('ru-RU')} фрагментов</option>)}
          </select>
        </label>
      </div>
      {needsConfirmation && <div className={styles.checks}>
        <label>
          <input type="checkbox" checked={confirmExternal} disabled={busy || running} onChange={e => setConfirmExternal(e.target.checked)} />
          Я понимаю, что текст фрагментов будет отправлен во внешний API эмбеддингов: {info.outboundDataDescription}
        </label>
      </div>}
      <div className={styles.actions} style={{ marginTop: 16 }}>
        <button className="button primary" disabled={startDisabled} onClick={() => void start()}>
          {running ? 'Индексирование выполняется…' : alreadyCovered ? 'Уже покрыто выбранным объёмом' : 'Запустить индексирование'}
        </button>
        {running && <button className="button secondary" disabled={busy || info.progress?.cancelled} onClick={() => void stop()}>{info.progress?.cancelled ? 'Останавливается…' : 'Остановить'}</button>}
        <button className="button secondary" disabled={busy} onClick={() => void load()}>Обновить статус</button>
      </div>

      {info.progress && (running || info.progress.total > 0) && <div className={styles.results}>
        <div style={{ width: '100%', height: 10, borderRadius: 5, background: '#eef0f2', overflow: 'hidden' }} role="progressbar" aria-valuenow={info.progress.percent} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${info.progress.percent}%`, height: '100%', background: '#ea6944', transition: 'width 0.4s ease' }} />
        </div>
        <p className={styles.hint} style={{ marginTop: 8 }}>
          {info.progress.percent}% · обработано {info.progress.processed} из {info.progress.total}
          {' '}· повторно использовано {info.progress.reused} · встроено {info.progress.embedded} · ошибок {info.progress.failed}
          {' '}· пропущено {info.progress.skipped}{info.progress.orphanRemoved > 0 ? ` · удалено устаревших ${info.progress.orphanRemoved}` : ''}
          {' '}· {running ? 'выполняется' : info.progress.cancelled ? 'остановлено' : 'завершено'} · {formatElapsed(info.progress.elapsedMs)}
        </p>
      </div>}
    </div>}
  </section>;
}
