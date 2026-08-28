import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import {
  DEFAULT_SALON_CURRENCY,
  formatCurrency as formatCurrencyValue,
  formatCurrencyAxis as formatCurrencyAxisValue,
  parseSalonCurrency,
  type SalonCurrency,
} from '@/lib/currency';

interface CurrencyContextType {
  currency: SalonCurrency;
  setCurrency: (code: SalonCurrency) => Promise<void>;
  formatCurrency: (amount: number) => string;
  formatCurrencyAxis: (amount: number) => string;
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { authInfo, hasSalonAccess } = useAuth();
  const [currency, setCurrencyState] = useState<SalonCurrency>(DEFAULT_SALON_CURRENCY);

  useEffect(() => {
    if (!hasSalonAccess || !authInfo?.salonId) {
      setCurrencyState(DEFAULT_SALON_CURRENCY);
      return;
    }

    let cancelled = false;
    api.salon
      .getSettings()
      .then((settings) => {
        if (!cancelled) setCurrencyState(parseSalonCurrency(settings.currency));
      })
      .catch(() => {
        if (!cancelled) setCurrencyState(DEFAULT_SALON_CURRENCY);
      });

    return () => {
      cancelled = true;
    };
  }, [authInfo?.salonId, hasSalonAccess]);

  const setCurrency = useCallback(async (code: SalonCurrency) => {
    const next = parseSalonCurrency(code);
    setCurrencyState(next);
    try {
      const saved = await api.salon.updateSettings({ currency: next });
      setCurrencyState(parseSalonCurrency(saved.currency));
    } catch (err) {
      const settings = await api.salon.getSettings().catch(() => null);
      setCurrencyState(parseSalonCurrency(settings?.currency ?? DEFAULT_SALON_CURRENCY));
      throw err;
    }
  }, []);

  const formatCurrency = useCallback(
    (amount: number) => formatCurrencyValue(amount, currency),
    [currency]
  );

  const formatCurrencyAxis = useCallback(
    (amount: number) => formatCurrencyAxisValue(amount, currency),
    [currency]
  );

  const value = useMemo(
    () => ({ currency, setCurrency, formatCurrency, formatCurrencyAxis }),
    [currency, setCurrency, formatCurrency, formatCurrencyAxis]
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  const context = useContext(CurrencyContext);
  if (!context) throw new Error('useCurrency must be used within CurrencyProvider');
  return context;
}
