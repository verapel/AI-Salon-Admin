import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase, SUPABASE_CONFIG_ERROR } from '@/lib/supabase';
import { api, setAccessToken } from '@/lib/api';

export interface AuthInfo {
  userId: string;
  email: string;
  isDeveloper: boolean;
  platformRole: 'developer' | null;
  salonId: string | null;
  role: 'owner' | 'admin' | 'staff_readonly' | null;
  staffId: string | null;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  authInfo: AuthInfo | null;
  loading: boolean;
  isDeveloper: boolean;
  hasSalonAccess: boolean;
  signIn: (email: string, password: string) => Promise<AuthInfo>;
  signOut: () => Promise<void>;
  refreshAuthInfo: () => Promise<AuthInfo | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function fetchAuthInfo(): Promise<AuthInfo> {
  return api.auth.getMe();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshAuthInfo = useCallback(async (): Promise<AuthInfo | null> => {
    try {
      const info = await fetchAuthInfo();
      setAuthInfo(info);
      return info;
    } catch {
      setAuthInfo(null);
      return null;
    }
  }, []);

  const applySession = useCallback(
    async (nextSession: Session | null) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setAccessToken(nextSession?.access_token ?? null);

      if (!nextSession?.access_token) {
        setAuthInfo(null);
        return null;
      }

      return refreshAuthInfo();
    },
    [refreshAuthInfo]
  );

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      return;
    }

    const client = supabase;
    let mounted = true;

    async function init() {
      const { data } = await client.auth.getSession();
      if (!mounted) return;
      await applySession(data.session);
      if (mounted) setLoading(false);
    }

    init();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange(async (_event, nextSession) => {
      await applySession(nextSession);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [applySession]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<AuthInfo> => {
      if (!supabase) {
        throw new Error(SUPABASE_CONFIG_ERROR);
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error('No session returned');

      setAccessToken(data.session.access_token);
      setSession(data.session);
      setUser(data.session.user);

      const info = await fetchAuthInfo();
      setAuthInfo(info);
      return info;
    },
    []
  );

  const signOut = useCallback(async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setAccessToken(null);
    setSession(null);
    setUser(null);
    setAuthInfo(null);
  }, []);

  const isDeveloper = authInfo?.isDeveloper ?? false;
  const hasSalonAccess = Boolean(authInfo?.salonId && authInfo?.role);

  const value = useMemo(
    () => ({
      session,
      user,
      authInfo,
      loading,
      isDeveloper,
      hasSalonAccess,
      signIn,
      signOut,
      refreshAuthInfo,
    }),
    [session, user, authInfo, loading, isDeveloper, hasSalonAccess, signIn, signOut, refreshAuthInfo]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
