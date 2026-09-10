/**
 * How an account and a network are named on a device.
 *
 * A device is a computer; an account is a person. The desktop window shows
 * both, apart, so "DESKTOP-PBL7246" never reads as the account. The account
 * display is a masked email: enough for the owner to recognise, not enough
 * for the machine to need to keep.
 */

export function accountDisplay(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "USAGE account";
  const [local, domain] = email.split("@");
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${"•".repeat(Math.max(2, Math.min(6, local.length - shown.length)))}@${domain}`;
}

/** The ordinary user sees a product name, not a protocol constant. */
export function networkLabel(network: string): string {
  switch (network) {
    case "production":
      return "USAGE Network";
    case "development":
      return "USAGE Beta Network";
    default:
      return `USAGE ${network}`;
  }
}
