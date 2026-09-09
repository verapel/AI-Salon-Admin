import type { CreateProviderCheckoutInput, PaymentProvider, ProviderCheckout } from './types.js';

/** Isolated TEST/SANDBOX provider. Completes the no-money flow today. */
export const TEST_PAYMENT_PROVIDER_ID = 'test' as const;

export const testPaymentProvider: PaymentProvider = {
  id: TEST_PAYMENT_PROVIDER_ID,
  displayName: 'Test sandbox',
  supportsAutomaticRecurring: false,
  async createCheckout(input: CreateProviderCheckoutInput): Promise<ProviderCheckout> {
    return {
      provider: TEST_PAYMENT_PROVIDER_ID,
      displayName: 'Test sandbox',
      supportsAutomaticRecurring: false,
      providerSessionId: `test_sess_${input.checkoutId}`,
      hostedPaymentPath: `/subscription/checkout/${input.checkoutId}`,
    };
  },
};
