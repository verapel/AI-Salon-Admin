import { FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { isSupabaseConfigured, SUPABASE_CONFIG_ERROR } from '@/lib/supabase';

function resolveRedirectPath(isDeveloper: boolean, hasSalonAccess: boolean): string | null {
  if (isDeveloper) return '/developer';
  if (hasSalonAccess) return '/';
  return null;
}

export default function Login() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { loading, session, authInfo, isDeveloper, hasSalonAccess, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !session || !authInfo) return;
    const path = resolveRedirectPath(isDeveloper, hasSalonAccess);
    if (path) navigate(path, { replace: true });
  }, [loading, session, authInfo, isDeveloper, hasSalonAccess, navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isSupabaseConfigured) return;
    setError(null);
    setSubmitting(true);

    try {
      const info = await signIn(email.trim(), password);
      const path = resolveRedirectPath(info.isDeveloper, Boolean(info.salonId && info.role));
      if (!path) {
        setError(t('auth.login.noAccess'));
        return;
      }
      navigate(path, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('auth.login.error');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-surface-dark">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (session && authInfo) {
    const path = resolveRedirectPath(isDeveloper, hasSalonAccess);
    if (path) return <Navigate to={path} replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-surface-dark">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('auth.login.title')}</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('auth.login.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          {!isSupabaseConfigured && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {SUPABASE_CONFIG_ERROR}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('auth.login.email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              disabled={!isSupabaseConfigured}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('auth.login.password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={!isSupabaseConfigured}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
            />
          </div>

          <button type="submit" disabled={submitting || !isSupabaseConfigured} className="btn-primary w-full">
            {submitting ? t('auth.login.signingIn') : t('auth.login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
