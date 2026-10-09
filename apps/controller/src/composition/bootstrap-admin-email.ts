/**
 * The bootstrap Job's administrator email rule: trim, lowercase, then one `@` and a dot
 * in the domain, with no whitespace. The Helm chart repeats it in `_helpers.tpl`, and
 * the installation profile renderer imports it so its preflight gives the same verdict.
 * Returns the normalized address, or undefined when the value is not an email.
 */
export function normalizeBootstrapAdminEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : undefined;
}
