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
import type { OwnerSubscription } from '@/types';

interface BillingContextType {
  snapshot: OwnerSubscription | null;
  loading: boolean;
  refresh: () => Promise<OwnerSubscription | null>;
}

const BillingContext = createContext<BillingContextType | undefined>(undefined);

export function BillingProvider({ children }: { children: ReactNode }) {
  const { session, authInfo } = useAuth();
  const [snapshot, setSnapshot] = useState<OwnerSubscription | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<OwnerSubscription | null> => {
    if (!session || !authInfo?.salonId) {
      setSnapshot(null);
      return null;
    }
    try {
      const data = await api.billing.getSubscription();
      setSnapshot(data);
      return data;
    } catch {
      // Fail open on read errors so a billing outage cannot lock the cabinet.
      setSnapshot(null);
      return null;
    }
  }, [session, authInfo?.salonId]);

  useEffect(() => {
    if (!session || !authInfo?.salonId) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void refresh().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [session, authInfo?.salonId, refresh]);

  const value = useMemo(
    () => ({ snapshot, loading, refresh }),
    [snapshot, loading, refresh],
  );

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

export function useBilling() {
  const context = useContext(BillingContext);
  if (!context) throw new Error('useBilling must be used within BillingProvider');
  return context;
}
