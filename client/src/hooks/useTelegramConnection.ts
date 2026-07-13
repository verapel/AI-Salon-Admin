import { useCallback, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';

export type TelegramConnectionStatus = 'checking' | 'connected' | 'disconnected' | 'error';

export interface TelegramBotInfo {
  username: string;
  name: string;
}

/**
 * Salon-cabinet Telegram connection hook.
 * Legacy unauthenticated HTTP endpoints are closed (Security-2a).
 * Token connect / status / test are developer-only via /api/developer/*.
 */
export function useTelegramConnection() {
  const { t } = useLanguage();
  const [status] = useState<TelegramConnectionStatus>('disconnected');
  const [botInfo] = useState<TelegramBotInfo | null>(null);
  const [connecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const refreshStatus = useCallback(async () => {
    // No unauthenticated status probe. Salon cabinet does not manage bot tokens.
  }, []);

  const connect = useCallback(
    async (_token: string): Promise<boolean> => {
      setConnectError(t('ai.connectionFailed'));
      return false;
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
    isConnected: false,
  };
}
