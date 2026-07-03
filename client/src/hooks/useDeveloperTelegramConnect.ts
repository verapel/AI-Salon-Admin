import { useCallback, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';

export function useDeveloperTelegramConnect() {
  const { t } = useLanguage();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const connect = useCallback(
    async (params: {
      salonName?: string;
      salonId?: string;
      token: string;
      botDisplayName?: string;
    }) => {
      setConnecting(true);
      setConnectError('');
      try {
        await api.developer.connectTelegram(params);
        return true;
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : t('ai.connectionFailed'));
        return false;
      } finally {
        setConnecting(false);
      }
    },
    [t]
  );

  const updateMetadata = useCallback(
    async (salonId: string, params: { salonName?: string; botDisplayName?: string }) => {
      setConnecting(true);
      setConnectError('');
      try {
        await api.developer.updateTelegramIntegration(salonId, params);
        return true;
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : t('developer.integrations.updateFailed'));
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

  return { connecting, connectError, connect, updateMetadata, clearConnectError };
}
