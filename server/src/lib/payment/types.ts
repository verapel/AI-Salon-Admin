export type PaymentProviderId = 'test' | 'paynet';

export type CheckoutOutcome = 'success' | 'failure';

export interface CreateProviderCheckoutInput {
  salonId: string;
  checkoutId: string;
  planId: string;
  amount: number;
  currency: string;
}

export interface ProviderCheckout {
  provider: PaymentProviderId;
  displayName: string;
  /** False for the current test provider — UI must not claim automatic charges. */
  supportsAutomaticRecurring: boolean;
  providerSessionId: string;
  /** In-app path for hosted payment. Never a secret. */
  hostedPaymentPath: string;
}

export interface ProviderPaymentEvent {
  provider: PaymentProviderId;
  providerPaymentId: string;
  providerSessionId: string;
  checkoutId: string;
  salonId: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed';
  paidAt: string | null;
}

export class PaymentProviderNotReadyError extends Error {
  readonly code = 'PROVIDER_NOT_READY' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderNotReadyError';
  }
}

export function isPaymentProviderNotReadyError(
  value: unknown,
): value is PaymentProviderNotReadyError {
  return value instanceof PaymentProviderNotReadyError;
}

/**
 * Provider-agnostic payment boundary.
 * Subscription UI / DB / access / cancellation must depend on this, not Paynet.
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly displayName: string;
  readonly supportsAutomaticRecurring: boolean;
  createCheckout(input: CreateProviderCheckoutInput): Promise<ProviderCheckout>;
  /**
   * Optional webhook parser for providers that confirm asynchronously.
   * Must verify authenticity using provider documentation — never trust raw bodies.
   */
  parseWebhook?(headers: Record<string, string | string[] | undefined>, rawBody: string): ProviderPaymentEvent;
}
