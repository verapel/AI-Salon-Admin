import { useEffect, useRef, useState } from 'react';
import { Menu, Moon, Sun, Bell, X, Globe, Check, LogOut } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useTheme } from '@/context/ThemeContext';
import { useLanguage, LANGUAGES, type LangCode } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/utils';
import type { InAppNotification, NotificationFeed } from '@/types';

const LANG_ABBR: Record<LangCode, string> = {
  ru: 'RU',
  en: 'EN',
  hy: 'AM',
};

const langAbbrClass =
  'inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-bold leading-none';

function LangAbbr({ code }: { code: LangCode }) {
  return <span className={langAbbrClass}>{LANG_ABBR[code]}</span>;
}

interface HeaderProps {
  title: string;
  subtitle?: string;
  onMenuClick: () => void;
  actions?: React.ReactNode;
}

export default function Header({ title, subtitle, onMenuClick, actions }: HeaderProps) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  const [panelOpen, setPanelOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const feedSeq = useRef(0);

  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLButtonElement>(null);
  const langPanelRef = useRef<HTMLDivElement>(null);

  function applyFeed(feed: NotificationFeed) {
    setItems(feed.items);
    setUnreadCount(feed.unreadCount);
  }

  useEffect(() => {
    api.notifications
      .list()
      .then(applyFeed)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!panelOpen) return;
    if (unreadCount > 0) setUnreadCount(0);
    const seq = ++feedSeq.current;
    api.notifications
      .markRead()
      .then((feed) => {
        if (feedSeq.current === seq) applyFeed(feed);
      })
      .catch(console.error);
  }, [panelOpen]);

  // Закрытие по клику снаружи — добавляем listener только когда панель открыта
  useEffect(() => {
    if (!panelOpen) return;

    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Клик внутри панели или на кнопку bell — не закрываем
      if (panelRef.current?.contains(target) || bellRef.current?.contains(target)) {
        return;
      }
      setPanelOpen(false);
    };

    // Небольшая задержка, чтобы mousedown, который открыл панель, не закрыл её сразу
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handleOutside);
    }, 0);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handleOutside);
    };
  }, [panelOpen]);

  useEffect(() => {
    if (!langOpen) return;

    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (langPanelRef.current?.contains(target) || langRef.current?.contains(target)) {
        return;
      }
      setLangOpen(false);
    };

    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handleOutside);
    }, 0);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handleOutside);
    };
  }, [langOpen]);

  const close = () => setPanelOpen(false);

  async function handleDismissAll() {
    if (busy || items.length === 0) return;
    setBusy(true);
    feedSeq.current += 1;
    const seq = feedSeq.current;
    try {
      const feed = await api.notifications.dismissAll();
      if (feedSeq.current === seq) applyFeed(feed);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleDismissOne(id: string) {
    if (busy) return;
    setBusy(true);
    feedSeq.current += 1;
    const seq = feedSeq.current;
    try {
      const feed = await api.notifications.dismiss(id);
      if (feedSeq.current === seq) applyFeed(feed);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  function handleLanguageChange(code: LangCode) {
    setLanguage(code);
    setLangOpen(false);
  }

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 min-w-0 items-center justify-between gap-2 border-b bg-white/80 px-4 backdrop-blur-md dark:bg-gray-900/80 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button onClick={onMenuClick} className="btn-ghost shrink-0 lg:hidden">
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
          {subtitle && (
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        {actions}

        {/* Кнопка уведомлений */}
        <div className="relative">
          <button
            ref={bellRef}
            onClick={() => setPanelOpen((v) => !v)}
            className="btn-ghost relative"
            aria-label={t('header.notifications')}
          >
            <Bell className="h-5 w-5" />
            {!loading && unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand-500 text-[9px] font-bold text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {panelOpen && (
            <div
              ref={panelRef}
              className="fixed left-4 right-4 top-16 z-50 mt-2 flex max-h-[min(24rem,calc(100dvh-5rem))] min-w-0 flex-col overflow-hidden rounded-xl border bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-80 sm:max-h-none"
            >
              {/* Заголовок */}
              <div className="flex min-w-0 items-center justify-between gap-2 border-b px-4 py-3 dark:border-gray-700">
                <div className="min-w-0">
                  <h3 className="break-words font-semibold text-gray-900 dark:text-white">{t('header.notifications')}</h3>
                  {!loading && (
                    <p className="break-words text-xs text-gray-500 dark:text-gray-400">
                      {unreadCount} {t('header.unread')}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={close}
                  className="btn-ghost shrink-0 p-1 text-gray-400"
                  aria-label={t('header.closeNotifications')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Тело */}
              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                </div>
              ) : items.length === 0 ? (
                <p className="break-words px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  {t('header.noNotifications')}
                </p>
              ) : (
                <ul className="min-h-0 flex-1 divide-y overflow-y-auto overflow-x-hidden dark:divide-gray-700 sm:max-h-72">
                  {items.slice(0, 15).map((r) => (
                    <li key={r.id} className="flex items-start gap-2 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium text-gray-900 dark:text-white">
                          {r.clientName}
                        </p>
                        {r.appointmentDate && (
                          <p className="mt-0.5 break-words text-xs text-gray-500 dark:text-gray-400">
                            {formatDate(r.appointmentDate)}
                            {r.appointmentTime ? ` ${t('header.at')} ${formatTime(r.appointmentTime)}` : ''}
                          </p>
                        )}
                        <p className="mt-0.5 break-words text-xs text-gray-400 dark:text-gray-500">
                          {r.message}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDismissOne(r.id)}
                        disabled={busy}
                        className="btn-ghost shrink-0 p-1 text-gray-400"
                        aria-label={t('header.dismissNotification')}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex min-w-0 items-center justify-between gap-2 border-t px-4 py-2.5 dark:border-gray-700">
                <Link
                  to="/reminders"
                  onClick={close}
                  className="min-w-0 truncate text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
                >
                  {t('header.viewAllReminders')}
                </Link>
                {items.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void handleDismissAll()}
                    disabled={busy}
                    className="shrink-0 text-xs font-medium text-gray-500 hover:text-gray-800 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    {t('header.clearAll')}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* Language selector */}
        <div className="relative">
          <button
            ref={langRef}
            onClick={() => setLangOpen((v) => !v)}
            className="btn-ghost flex items-center gap-1.5"
            aria-label={t('header.selectLanguage')}
          >
            <Globe className="h-5 w-5" />
            <span className="hidden sm:inline">
              <LangAbbr code={language} />
            </span>
          </button>

          {langOpen && (
            <div
              ref={langPanelRef}
              className="absolute right-0 top-full z-50 mt-2 w-44 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
            >
              <div className="border-b px-3 py-2 dark:border-gray-700">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('header.language')}</p>
              </div>
              <ul className="py-1">
                {LANGUAGES.map((lang) => (
                  <li key={lang.code}>
                    <button
                      type="button"
                      onClick={() => handleLanguageChange(lang.code)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50 ${
                        language === lang.code
                          ? 'font-medium text-brand-600 dark:text-brand-400'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <LangAbbr code={lang.code} />
                        <span>{lang.label}</span>
                      </span>
                      {language === lang.code && (
                        <Check className="h-4 w-4 shrink-0 text-brand-600 dark:text-brand-400" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <button onClick={toggleTheme} className="btn-ghost" aria-label={t('header.toggleTheme')}>
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>

        <button
          type="button"
          onClick={handleSignOut}
          className="btn-ghost inline-flex items-center gap-1.5 text-sm font-medium"
          aria-label={t('auth.signOut')}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">{t('auth.signOut')}</span>
        </button>

        <div className="ml-2 hidden items-center gap-2 sm:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
            AD
          </div>
        </div>
      </div>
    </header>
  );
}
