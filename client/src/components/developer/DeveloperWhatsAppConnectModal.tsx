import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { useLanguage } from '@/context/LanguageContext';
import type { DeveloperWhatsAppIntegration, WhatsAppConnectRequest } from '@/types';

const EMPTY_FORM: WhatsAppConnectRequest = {
  accessToken: '',
  appSecret: '',
  verifyToken: '',
  businessAccountId: '',
  phoneNumberId: '',
};

interface DeveloperWhatsAppConnectModalProps {
  open: boolean;
  integration: DeveloperWhatsAppIntegration | null;
  mode: 'connect' | 'reconnect';
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: WhatsAppConnectRequest) => Promise<boolean>;
  onClearError: () => void;
}

export default function DeveloperWhatsAppConnectModal({
  open,
  integration,
  mode,
  submitting,
  error,
  onClose,
  onSubmit,
  onClearError,
}: DeveloperWhatsAppConnectModalProps) {
  const { t } = useLanguage();
  const [form, setForm] = useState<WhatsAppConnectRequest>(EMPTY_FORM);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      onClearError();
    }
  }, [open, onClearError]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !integration) return;

    const body: WhatsAppConnectRequest = {
      accessToken: form.accessToken.trim(),
      appSecret: form.appSecret.trim(),
      verifyToken: form.verifyToken.trim(),
      businessAccountId: form.businessAccountId.trim(),
      phoneNumberId: form.phoneNumberId.trim(),
    };

    const ok = await onSubmit(body);
    if (ok) {
      setForm(EMPTY_FORM);
    } else {
      setForm((prev) => ({
        ...prev,
        accessToken: '',
        appSecret: '',
        verifyToken: '',
      }));
    }
  }

  if (!integration) return null;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (submitting) return;
        setForm(EMPTY_FORM);
        onClose();
      }}
      title={
        mode === 'reconnect'
          ? t('integrations.whatsapp.reconnect')
          : t('integrations.whatsapp.connect')
      }
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {integration.salonName} · {integration.slug}
        </p>

        <div>
          <label htmlFor="dev-wa-access-token" className="mb-1.5 block text-sm font-medium">
            {t('integrations.whatsapp.accessToken')}
          </label>
          <input
            id="dev-wa-access-token"
            type="password"
            required
            className="input-field"
            value={form.accessToken}
            onChange={(e) => setForm((prev) => ({ ...prev, accessToken: e.target.value }))}
            autoComplete="new-password"
            disabled={submitting}
          />
        </div>
        <div>
          <label htmlFor="dev-wa-app-secret" className="mb-1.5 block text-sm font-medium">
            {t('integrations.whatsapp.appSecret')}
          </label>
          <input
            id="dev-wa-app-secret"
            type="password"
            required
            className="input-field"
            value={form.appSecret}
            onChange={(e) => setForm((prev) => ({ ...prev, appSecret: e.target.value }))}
            autoComplete="new-password"
            disabled={submitting}
          />
        </div>
        <div>
          <label htmlFor="dev-wa-verify-token" className="mb-1.5 block text-sm font-medium">
            {t('integrations.whatsapp.verifyToken')}
          </label>
          <input
            id="dev-wa-verify-token"
            type="password"
            required
            className="input-field"
            value={form.verifyToken}
            onChange={(e) => setForm((prev) => ({ ...prev, verifyToken: e.target.value }))}
            autoComplete="new-password"
            disabled={submitting}
          />
        </div>
        <div>
          <label htmlFor="dev-wa-waba" className="mb-1.5 block text-sm font-medium">
            {t('integrations.whatsapp.businessAccountId')}
          </label>
          <input
            id="dev-wa-waba"
            type="text"
            required
            className="input-field"
            value={form.businessAccountId}
            onChange={(e) => setForm((prev) => ({ ...prev, businessAccountId: e.target.value }))}
            autoComplete="off"
            disabled={submitting}
          />
        </div>
        <div>
          <label htmlFor="dev-wa-phone-id" className="mb-1.5 block text-sm font-medium">
            {t('integrations.whatsapp.phoneNumberId')}
          </label>
          <input
            id="dev-wa-phone-id"
            type="text"
            required
            className="input-field"
            value={form.phoneNumberId}
            onChange={(e) => setForm((prev) => ({ ...prev, phoneNumberId: e.target.value }))}
            autoComplete="off"
            disabled={submitting}
          />
        </div>

        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={submitting}
            onClick={() => {
              setForm(EMPTY_FORM);
              onClose();
            }}
          >
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting
              ? t('integrations.whatsapp.connecting')
              : mode === 'reconnect'
                ? t('integrations.whatsapp.reconnect')
                : t('integrations.whatsapp.connect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
