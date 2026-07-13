import { FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { isSupabaseConfigured, SUPABASE_CONFIG_ERROR, supabase } from '@/lib/supabase';

/**
 * Invite / recovery landing: session arrives via URL hash from Supabase.
 * User sets password, then continues to the staff portal when applicable.
 */
export default function SetPassword() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { loading, session, authInfo, refreshAuthInfo } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingForSession, setWaitingForSession] = useState(true);

  useEffect(() => {
    if (loading) return;
    // Allow Supabase client a moment to parse invite hash into a session.
    const timer = window.setTimeout(() => setWaitingForSession(false), 800);
    return () => window.clearTimeout(timer);
  }, [loading]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError(null);

    if (password.length < 6) {
      setError(t('auth.setPassword.tooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.setPassword.mismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      const info = await refreshAuthInfo();
      if (info?.role === 'staff_readonly') {
        navigate('/staff', { replace: true });
        return;
      }
      if ((info?.role === 'owner' || info?.role === 'admin') && info.salonId) {
        navigate('/', { replace: true });
        return;
      }
      if (info?.isDeveloper) {
        navigate('/developer', { replace: true });
        return;
      }
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.setPassword.error'));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || waitingForSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-surface-dark">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-surface-dark">
        <p className="text-sm text-amber-800 dark:text-amber-200">{SUPABASE_CONFIG_ERROR}</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-surface-dark">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {t('auth.setPassword.title')}
          </h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t('auth.setPassword.subtitle')}
          </p>
          {authInfo?.email ? (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{authInfo.email}</p>
          ) : null}
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          ) : null}

          <div>
            <label
              htmlFor="new-password"
              className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('auth.setPassword.password')}
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
            />
          </div>

          <div>
            <label
              htmlFor="confirm-password"
              className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('auth.setPassword.confirm')}
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="input-field"
            />
          </div>

          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? t('auth.setPassword.saving') : t('auth.setPassword.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
