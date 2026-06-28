import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  translations,
  LANGUAGES,
  type LangCode,
  type TranslationKey,
} from '@/i18n/translations';

export { LANGUAGES, type LangCode, type TranslationKey };

interface LanguageContextType {
  language: LangCode;
  setLanguage: (code: LangCode) => void;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const STORAGE_KEY = 'salon_lang';
const DEFAULT_LANG: LangCode = 'ru';

function readStoredLanguage(): LangCode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'ru' || stored === 'en' || stored === 'hy') return stored;
  return DEFAULT_LANG;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<LangCode>(readStoredLanguage);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((code: LangCode) => {
    setLanguageState(code);
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      return translations[language][key] ?? translations.en[key] ?? key;
    },
    [language]
  );

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}
