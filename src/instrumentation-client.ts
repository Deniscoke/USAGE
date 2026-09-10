/**
 * Client instrumentation (M16B.1). Runs before the app becomes interactive.
 * Records safe error metadata (see src/lib/live/diagnostics.ts) and performs
 * at most one full-document reload when a stale build meets a new deployment.
 */
import { isRecoverableBuildError, reportClientError, shouldReloadOnce } from "@/lib/live/diagnostics";

let lastNavigation: string | null = null;

export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse"): void {
  lastNavigation = `${navigationType} ${url}`;
}

function recover(message: string): void {
  if (!isRecoverableBuildError(message)) return;
  if (!shouldReloadOnce(Date.now(), window.sessionStorage)) return;
  try {
    const notice = document.createElement("div");
    notice.textContent = "USAGE was updated. Reloading the latest version…";
    notice.setAttribute("style", "position:fixed;left:0;right:0;bottom:0;padding:8px 12px;font:12px system-ui;background:#111;color:#eee;z-index:2147483647");
    document.body.appendChild(notice);
  } catch {
    // cosmetic only
  }
  window.setTimeout(() => window.location.reload(), 300);
}

try {
  window.addEventListener("error", (event) => {
    const record = reportClientError("window.error", event.error ?? event.message, { navigation: lastNavigation });
    recover(record.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const record = reportClientError("unhandledrejection", event.reason, { navigation: lastNavigation });
    recover(record.message);
  });
} catch {
  // instrumentation must never break the page
}
