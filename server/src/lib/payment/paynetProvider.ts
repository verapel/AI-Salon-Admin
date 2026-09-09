import {
  PaymentProviderNotReadyError,
  type CreateProviderCheckoutInput,
  type PaymentProvider,
  type ProviderCheckout,
} from './types.js';

/**
 * Isolated Paynet adapter stub.
 *
 * Do not invent Paynet endpoints, payloads, webhook signatures, or credentials.
 * Implement this file only after verified Paynet sandbox documentation and
 * credentials are available. Subscription UI / DB / access / cancellation must
 * keep using the PaymentProvider interface.
 */
export const PAYNET_PAYMENT_PROVIDER_ID = 'paynet' as const;

export const paynetPaymentProvider: PaymentProvider = {
  id: PAYNET_PAYMENT_PROVIDER_ID,
  displayName: 'Paynet',
  // Stay false until verified Paynet documentation confirms automatic recurring charges.
  supportsAutomaticRecurring: false,
  async createCheckout(_input: CreateProviderCheckoutInput): Promise<ProviderCheckout> {
    throw new PaymentProviderNotReadyError(
      'Paynet sandbox is not implemented: verified API credentials and documentation are not in this repository.',
    );
  },
};
