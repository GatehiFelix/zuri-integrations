// Strict E.164 for the outbound payload. Do NOT reuse the CRM's phoneNormalizer: it keeps the last
// 9 digits and forces an EAC prefix, which mangles non-EAC numbers.
// Returns "+<digits>" or null when the input can't be a valid number (caller sends msisdn_raw instead).
export function toE164(raw, defaultCc = '254') {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = defaultCc + d.slice(1);
  else if (d.length === 9) d = defaultCc + d;
  return d.length >= 10 && d.length <= 15 ? `+${d}` : null;
}