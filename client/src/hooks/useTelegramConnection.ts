import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';

export type TelegramConnectionStatus = 'checking' | 'connected' | 'disconnected' | 'error';

export interface TelegramBotInfo {
  username: string;
  name: string;
}

export function useTelegramConnection() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<TelegramConnectionStatus>('checking');
  const [botInfo, setBotInfo] = useState<TelegramBotInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const refreshStatus = useCallback(async () => {
    setStatus('checking');
    try {
      const res = await fetch('/api/telegram/status');
      const data = await res.json();
      if (data.connected) {
        setBotInfo({ username: data.bot, name: data.name });
        setStatus('connected');
      } else {
        setBotInfo(null);
        setStatus('disconnected');
      }
    } catch {
      setBotInfo(null);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const connect = useCallback(
    async (token: string): Promise<boolean> => {
      const trimmed = token.trim();
      if (!trimmed) return false;

      setConnecting(true);
      setConnectError('');

      try {
        const res = await fetch('/api/integrations/telegram/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: trimmed }),
        });

        const data = await res.json();

        if (data.success) {
          setBotInfo({ username: data.username, name: data.name });
          setStatus('connected');
          return true;
        }

        setConnectError(data.error ?? t('ai.connectionFailed'));
        return false;
      } catch {
        setConnectError(t('ai.serverError'));
        return false;
      } finally {
        setConnecting(false);
      }
    },
    [t]
  );

  const clearConnectError = useCallback(() => {
    setConnectError('');
  }, []);

  return {
    status,
    botInfo,
    connecting,
    connectError,
    refreshStatus,
    connect,
    clearConnectError,
    isConnected: status === 'connected',
  };
}
