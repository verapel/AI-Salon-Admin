import { paynetPaymentProvider } from './paynetProvider.js';
import { testPaymentProvider } from './testProvider.js';
import type { PaymentProvider, PaymentProviderId } from './types.js';

export {
  PaymentProviderNotReadyError,
  isPaymentProviderNotReadyError,
} from './types.js';
export type {
  CheckoutOutcome,
  CreateProviderCheckoutInput,
  PaymentProvider,
  PaymentProviderId,
  ProviderCheckout,
  ProviderPaymentEvent,
} from './types.js';
export { testPaymentProvider } from './testProvider.js';
export { paynetPaymentProvider } from './paynetProvider.js';

export function parseBillingProviderId(raw: string | undefined): PaymentProviderId {
  return raw === 'paynet' ? 'paynet' : 'test';
}

export function getPaymentProvider(
  env: NodeJS.ProcessEnv = process.env,
): PaymentProvider {
  return parseBillingProviderId(env.BILLING_PROVIDER) === 'paynet'
    ? paynetPaymentProvider
    : testPaymentProvider;
}
