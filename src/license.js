export function isPaidNotificationMethod(method) {
  return ['email', 'whatsapp', 'telegram', 'slack'].includes(method);
}

export async function validateKeyClientSide(key, logger = null) {
  if (!key) {
    return { valid: false, reason: 'no_key' };
  }

  try {
    const response = await fetch('https://www.heyagent.dev/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });

    if (!response.ok) {
      return { valid: false, reason: `HTTP_${response.status}` };
    }

    const data = await response.json();
    return {
      valid: data.valid,
      reason: data.reason,
      definitiveInvalid: data.definitiveInvalid,
    };
  } catch (error) {
    if (logger) logger.error('Failed to validate key: ', error);
    throw new Error('Failed to validate key');
  }
}

export async function getCheckoutUrl(logger = null) {
  try {
    const response = await fetch('https://www.heyagent.dev/api/checkout');
    if (response.ok) {
      const data = await response.json();
      return data.checkoutUrl;
    }
  } catch (error) {
    // Fallback if server is not available
    if (logger) logger.error('Failed to get checkout URL: ', error);
  }
  throw new Error('Failed to get checkout URL');
}
