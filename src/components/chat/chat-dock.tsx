"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SseParser } from "@/lib/chat/sse";
import {
  deserializeHistory,
  emptyHistory,
  serializeHistory,
  storageKey,
  titleFor,
  toWireMessages,
  type ChatHistory,
  type ChatMessage,
  type Conversation,
  type MessageReceipt,
} from "@/lib/chat/history";
import type { ChatRoute } from "@/lib/chat/route";

/**
 * USAGE Chat: the second front door.
 *
 * The miner is for people who already live in Claude Code or Codex. This is
 * for everybody else: sign in, and talk to a model from inside the website.
 * Every message travels the same trust boundary the miner uses -- measured,
 * priced, signed, attributed to this account -- and the reply carries a
 * receipt saying what USAGE recorded and whether it can earn.
 *
 * What stays in this browser: the conversation. USAGE never stores prompts or
 * replies (rule 3), so history lives in localStorage under this account's key
 * and nowhere else. Clearing it here clears the only copy.
 *
 * The launcher is the one deliberate piece of motion on the site: a quiet orb
 * that breathes on hover, and a panel that comes forward while the page
 * settles back, as if the chat had been behind it all along. Minimising
 * returns it to the orb with the conversation intact. All of it is CSS and
 * all of it is off under prefers-reduced-motion.
 */

interface RouteState {
  userId: string;
  route: ChatRoute;
  models: { id: string; label: string; priced: boolean }[];
  defaultModel: string | null;
  cap: { spentMicros: number; capMicros: number; requestsToday: number; requestLimit: number } | null;
  networkLabel: string;
}

interface Receipt {
  found: boolean;
  rewardStatus?: string | null;
  rewardReason?: string | null;
  verificationStatus?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costMicros?: number | null;
  epochId?: string | null;
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function readHistory(userId: string): ChatHistory {
  try {
    return deserializeHistory(window.localStorage.getItem(storageKey(userId)));
  } catch {
    return emptyHistory();
  }
}

function writeHistory(userId: string, history: ChatHistory): void {
  try {
    window.localStorage.setItem(storageKey(userId), serializeHistory(history));
  } catch {
    // Storage full, private mode, or refused. The conversation is still on
    // screen; only its persistence is lost, and the panel says so.
  }
}

function formatMicros(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "cost unknown";
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 6 : 4)}`;
}

function receiptFromApi(receipt: Receipt): MessageReceipt {
  if (!receipt.found) {
    return { status: "unrecorded", inputTokens: null, outputTokens: null, costMicros: null, epochId: null, reason: "USAGE recorded no usage for this reply." };
  }
  const status: MessageReceipt["status"] =
    receipt.rewardStatus === "eligible" ? "verified" : receipt.rewardStatus === "held" ? "held" : "ineligible";
  return {
    status,
    inputTokens: receipt.inputTokens ?? null,
    outputTokens: receipt.outputTokens ?? null,
    costMicros: receipt.costMicros ?? null,
    epochId: receipt.epochId ?? null,
    reason: receipt.rewardReason ?? null,
  };
}

export function ChatDock() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RouteState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatHistory>(emptyHistory);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [model, setModel] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // The dock lives in a portal on <body>, outside <main>, so the page can be
  // transformed behind it without dragging a fixed element along.
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Route, models and cap: from the server, fresh on every open.
  const loadState = useCallback(async () => {
    try {
      const response = await fetch("/api/chat", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        setStateError(response.status === 401 ? "Sign in to chat." : "The chat could not be loaded.");
        return;
      }
      const next = (await response.json()) as RouteState;
      setState(next);
      setStateError(null);
      setModel((current) => (current && next.models.some((m) => m.id === current) ? current : (next.defaultModel ?? "")));
    } catch {
      setStateError("The chat could not be loaded.");
    }
  }, []);

  // History is hydrated once the account is known, from this browser only.
  useEffect(() => {
    const userId = state?.userId;
    if (!userId || hydratedFor === userId) return;
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      const stored = readHistory(userId);
      setHistory(stored);
      setActiveId(stored.conversations[0]?.id ?? null);
      setHydratedFor(userId);
    });
    return () => {
      alive = false;
    };
  }, [state?.userId, hydratedFor]);

  useEffect(() => {
    if (!state?.userId || hydratedFor !== state.userId) return;
    writeHistory(state.userId, history);
  }, [history, state?.userId, hydratedFor]);

  useEffect(() => {
    document.body.classList.toggle("chat-open", open);
    return () => document.body.classList.remove("chat-open");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const active = useMemo(
    () => history.conversations.find((c) => c.id === activeId) ?? null,
    [history, activeId],
  );

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, streaming, open]);

  const updateConversation = useCallback((id: string, update: (c: Conversation) => Conversation) => {
    setHistory((h) => ({ ...h, conversations: h.conversations.map((c) => (c.id === id ? update(c) : c)) }));
  }, []);

  const patchMessage = useCallback(
    (conversationId: string, messageId: string, patch: (m: ChatMessage) => ChatMessage) => {
      updateConversation(conversationId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === messageId ? patch(m) : m)) }));
    },
    [updateConversation],
  );

  const startConversation = useCallback(() => {
    const conversation: Conversation = { id: uid(), title: "New conversation", startedAt: new Date().toISOString(), messages: [] };
    setHistory((h) => ({ ...h, conversations: [conversation, ...h.conversations] }));
    setActiveId(conversation.id);
    setSendError(null);
    return conversation;
  }, []);

  const fetchReceipt = useCallback(async (conversationId: string, messageId: string, generationId: string) => {
    const delays = [1500, 3000, 5000];
    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const response = await fetch(`/api/chat/receipt?generation=${encodeURIComponent(generationId)}`, { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) continue;
        const receipt = (await response.json()) as Receipt;
        if (receipt.found) {
          patchMessage(conversationId, messageId, (m) => ({ ...m, receipt: receiptFromApi(receipt) }));
          return;
        }
      } catch {
        // Try again on the next delay.
      }
    }
    patchMessage(conversationId, messageId, (m) => ({ ...m, receipt: receiptFromApi({ found: false }) }));
  }, [patchMessage]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || streaming || !state || state.route.kind === "none" || !model) return;

    const conversation = active ?? startConversation();
    const userMessage: ChatMessage = { id: uid(), role: "user", content: text, at: new Date().toISOString() };
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      at: new Date().toISOString(),
      model,
      receipt: { status: "pending", inputTokens: null, outputTokens: null, costMicros: null, epochId: null, reason: null },
    };
    const priorMessages = conversation.messages;
    updateConversation(conversation.id, (c) => ({
      ...c,
      title: c.messages.length === 0 ? titleFor(text) : c.title,
      messages: [...c.messages, userMessage, assistantMessage],
    }));
    setDraft("");
    setSendError(null);
    setStreaming(true);

    const via = state.route.kind === "provider" ? `provider:${state.route.connectionId}` : "shared";
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/chat/completions?via=${encodeURIComponent(via)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: toWireMessages([...priorMessages, userMessage]) }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        let message = `The request failed (${response.status}).`;
        try {
          const payload = (await response.json()) as { error?: { message?: string } };
          if (payload.error?.message) message = payload.error.message;
        } catch {
          // Keep the status message.
        }
        setSendError(message);
        patchMessage(conversation.id, assistantMessage.id, (m) => ({ ...m, receipt: { ...m.receipt!, status: "unrecorded", reason: message } }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let generationId: string | null = null;
      let providerError: string | null = null;

      const handle = (events: ReturnType<SseParser["push"]>) => {
        for (const event of events) {
          if (event.type === "delta") {
            patchMessage(conversation.id, assistantMessage.id, (m) => ({ ...m, content: m.content + event.text }));
          } else if (event.type === "usage") {
            generationId = event.generationId ?? generationId;
            if (event.model) patchMessage(conversation.id, assistantMessage.id, (m) => ({ ...m, model: event.model ?? m.model }));
          } else if (event.type === "error") {
            providerError = event.message;
          }
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle(parser.push(decoder.decode(value, { stream: true })));
      }
      handle(parser.flush());

      if (providerError) {
        setSendError(providerError);
        patchMessage(conversation.id, assistantMessage.id, (m) => ({ ...m, receipt: { ...m.receipt!, status: "unrecorded", reason: providerError } }));
        return;
      }

      patchMessage(conversation.id, assistantMessage.id, (m) => ({ ...m, generationId }));
      if (generationId) void fetchReceipt(conversation.id, assistantMessage.id, generationId);
      else patchMessage(conversation.id, assistantMessage.id, (m) => ({ ...m, receipt: receiptFromApi({ found: false }) }));
      // The cap moved; the header should say so.
      void loadState();
    } catch (caught) {
      const aborted = caught instanceof DOMException && caught.name === "AbortError";
      const message = aborted ? "Stopped." : "The connection dropped before the reply finished.";
      setSendError(aborted ? null : message);
      patchMessage(conversation.id, assistantMessage.id, (m) => ({
        ...m,
        receipt: { ...m.receipt!, status: "unrecorded", reason: aborted ? "Stopped before the provider finished; USAGE records only completed generations." : message },
      }));
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }, [draft, streaming, state, model, active, startConversation, updateConversation, patchMessage, fetchReceipt, loadState]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clearAll = useCallback(() => {
    if (!window.confirm("Delete every conversation from this browser? USAGE holds no copy.")) return;
    setHistory(emptyHistory());
    setActiveId(null);
  }, []);

  if (!mounted) return null;

  const route = state?.route ?? null;
  const routeTone = !route ? "var(--faint)" : route.kind === "none" ? "var(--reported)" : route.rewardStatus === "eligible" ? "var(--verified)" : "var(--warn)";
  const routeWord = !route ? "…" : route.kind === "none" ? "No route" : route.rewardStatus === "eligible" ? "Earns" : "Measured · does not earn";
  const hasConversation = history.conversations.some((c) => c.messages.length > 0);

  return createPortal(
    <>
      <button
        type="button"
        className={`chat-orb${open ? " chat-orb--open" : ""}`}
        aria-label={open ? "Minimise USAGE Chat" : "Open USAGE Chat"}
        aria-expanded={open}
        onClick={() => {
          // Opening is the event; the route is fetched then, not by an effect
          // that watches `open` -- the same data either way, and no render
          // that exists only to trigger another.
          if (!open) void loadState();
          setOpen((o) => !o);
        }}
      >
        <span className="chat-orb__core" aria-hidden="true" />
        {hasConversation && !open && <span className="chat-orb__dot" aria-hidden="true" />}
      </button>

      <div className={`chat-backdrop${open ? " chat-backdrop--open" : ""}`} onClick={() => setOpen(false)} aria-hidden="true" />

      <section className={`chat-panel${open ? " chat-panel--open" : ""}`} aria-label="USAGE Chat" aria-hidden={!open}>
        <header className="chat-panel__head">
          <div className="min-w-0">
            <p className="tnum text-[11px] font-medium tracking-[0.3em]">USAGE CHAT</p>
            <p className="mt-1 truncate text-[11px]" style={{ color: routeTone }}>
              {route ? (route.kind === "none" ? route.reason : `${route.label} · ${routeWord}`) : "Loading route…"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="chat-btn" onClick={startConversation} disabled={streaming}>
              New
            </button>
            <button type="button" className="chat-btn" onClick={() => setOpen(false)} aria-label="Minimise">
              —
            </button>
          </div>
        </header>

        {stateError && <p className="chat-note chat-note--warn">{stateError}</p>}

        {route?.kind === "none" && (
          <div className="chat-empty">
            <p className="text-sm">Nothing can carry a message yet.</p>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{route.reason}</p>
            <a href="/api/providers/oauth/openrouter/start" className="chat-btn chat-btn--primary mt-4 inline-block">
              Connect OpenRouter
            </a>
          </div>
        )}

        {route && route.kind !== "none" && (
          <>
            <div className="chat-toolbar">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-[var(--muted)]">
                <span className="shrink-0">Model</span>
                <select className="chat-select" value={model} onChange={(e) => setModel(e.target.value)} disabled={streaming}>
                  {(state?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.priced ? "" : " · unpriced, earns nothing"}
                    </option>
                  ))}
                </select>
              </label>
              {history.conversations.length > 1 && (
                <select className="chat-select chat-select--history" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)} disabled={streaming} aria-label="Conversation">
                  {history.conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {state?.cap && route.kind === "shared" && (
              <p className="chat-note">
                Shared route · today {formatMicros(state.cap.spentMicros)} of {formatMicros(state.cap.capMicros)} ·{" "}
                {state.cap.requestsToday}/{state.cap.requestLimit} requests. Paid by USAGE, so it is measured but cannot earn.
              </p>
            )}

            <div className="chat-list" ref={listRef}>
              {(!active || active.messages.length === 0) && (
                <p className="chat-empty text-[11px] leading-relaxed text-[var(--muted)]">
                  Every message goes through USAGE, is measured and priced, and gets a receipt below the reply.
                  The conversation itself stays in this browser; USAGE keeps the metadata only.
                </p>
              )}
              {active?.messages.map((m) => (
                <div key={m.id} className={`chat-msg chat-msg--${m.role}`}>
                  <div className="chat-msg__body">{m.content || (m.role === "assistant" && streaming ? <span className="chat-cursor" /> : "")}</div>
                  {m.role === "assistant" && m.receipt && <ReceiptLine receipt={m.receipt} model={m.model} />}
                </div>
              ))}
            </div>

            {sendError && <p className="chat-note chat-note--warn">{sendError}</p>}

            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={composerRef}
                className="chat-input"
                rows={2}
                placeholder="Message…"
                value={draft}
                disabled={streaming}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {streaming ? (
                <button type="button" className="chat-btn" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button type="submit" className="chat-btn chat-btn--primary" disabled={!draft.trim() || !model}>
                  Send
                </button>
              )}
            </form>
            <div className="chat-foot">
              <span>{state?.networkLabel}</span>
              <button type="button" className="chat-link" onClick={clearAll} disabled={streaming || !hasConversation}>
                Clear this browser&apos;s history
              </button>
            </div>
          </>
        )}
      </section>
    </>,
    document.body,
  );
}

function ReceiptLine({ receipt, model }: { receipt: MessageReceipt; model?: string }) {
  const tone =
    receipt.status === "verified" ? "var(--verified)" : receipt.status === "held" ? "var(--warn)" : receipt.status === "pending" ? "var(--faint)" : "var(--reported)";
  const word =
    receipt.status === "verified" ? "VERIFIED · ELIGIBLE" : receipt.status === "held" ? "VERIFIED · HELD" : receipt.status === "pending" ? "MEASURING…" : receipt.status === "ineligible" ? "INELIGIBLE" : "NOT RECORDED";
  const tokens = receipt.inputTokens !== null && receipt.outputTokens !== null ? ` · ${receipt.inputTokens} in / ${receipt.outputTokens} out` : "";
  const cost = receipt.status === "pending" ? "" : ` · ${formatMicros(receipt.costMicros)}`;
  return (
    <p className="chat-receipt tnum" title={receipt.reason ?? undefined}>
      <span style={{ color: tone }}>{word}</span>
      {model ? ` · ${model}` : ""}
      {tokens}
      {cost}
      {receipt.epochId ? ` · ${receipt.epochId}` : ""}
    </p>
  );
}
