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
import { Markdown } from "@/components/chat/markdown";
import { looksLikeDocument, parseMarkdown } from "@/lib/chat/markdown";
import { PREFERENCES_KEY, MAX_PREFERENCES_CHARS } from "@/lib/chat/preferences";

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
  cap: {
    spentMicros: number;
    capMicros: number;
    requestsToday: number;
    requestLimit: number;
    credit: { grantMicros: number; spentMicros: number; remainingMicros: number };
    refusal: "credit" | "daily_cap" | "daily_requests" | null;
  } | null;
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
  // Hundreds of discovered models, a handful with an approved price. The
  // ones that cannot earn are hidden by default rather than labelled, because
  // a list where every line says "earns nothing" reads as a broken product.
  const [showUnpriced, setShowUnpriced] = useState(false);
  // A reply opened on a page of its own: copy it, or print it to PDF.
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // The dock lives in a portal on <body>, outside <main>, so the page can be
  // transformed behind it without dragging a fixed element along.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setMounted(true);
      try {
        const stored = window.localStorage.getItem(PREFERENCES_KEY);
        if (stored) setPreferences(stored);
      } catch {
        // Storage refused; the assistant simply gets no standing instructions.
      }
    });
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

  // Printing the open document: everything else is hidden by the print CSS.
  useEffect(() => {
    document.body.classList.toggle("chat-printing", documentId !== null);
    return () => document.body.classList.remove("chat-printing");
  }, [documentId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (open && event.key === "Escape") {
        if (documentId) setDocumentId(null);
        else closePanel();
        return;
      }
      // Ctrl+K / Cmd+K: the shortcut every chat has.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) closePanel();
        else openPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const active = useMemo(
    () => history.conversations.find((c) => c.id === activeId) ?? null,
    [history, activeId],
  );

  // Follow the stream only while the reader is at the bottom. Yanking
  // somebody back down while they are reading what was said earlier is the
  // rudest thing a chat window can do.
  const pinnedRef = useRef(true);
  const lastLength = active?.messages.at(-1)?.content.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, lastLength, open, expanded]);

  const openPanel = useCallback(() => {
    void loadState();
    setOpen(true);
    // After the panel is painted, so the caret lands in the composer.
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [loadState]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setDocumentId(null);
    // Focus goes back where it came from, or a keyboard is left nowhere.
    requestAnimationFrame(() => orbRef.current?.focus());
  }, []);

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
        body: JSON.stringify({
          model,
          messages: toWireMessages([...priorMessages, userMessage]),
          preferences: preferences.trim() ? preferences.trim().slice(0, MAX_PREFERENCES_CHARS) : undefined,
        }),
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
        // Nothing was said, so nothing is kept: the pair comes back out and
        // the words return to the box, where they can be sent again or
        // edited. Losing what somebody typed is unforgivable.
        updateConversation(conversation.id, (c) => ({
          ...c,
          messages: c.messages.filter((m) => m.id !== userMessage.id && m.id !== assistantMessage.id),
        }));
        setDraft(text);
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
  }, [draft, streaming, state, model, preferences, active, startConversation, updateConversation, patchMessage, fetchReceipt, loadState]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const deleteConversation = useCallback(
    (id: string) => {
      // Both decisions made here, from what is already known. Setting state
      // inside another setter's updater runs twice under StrictMode.
      const remaining = history.conversations.filter((c) => c.id !== id);
      setHistory((h) => ({ ...h, conversations: h.conversations.filter((c) => c.id !== id) }));
      setActiveId(remaining[0]?.id ?? null);
      setDocumentId(null);
    },
    [history.conversations],
  );

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
  const totals = (active?.messages ?? []).reduce(
    (sum, m) => ({
      tokens: sum.tokens + (m.receipt?.inputTokens ?? 0) + (m.receipt?.outputTokens ?? 0),
      micros: sum.micros + (m.receipt?.costMicros ?? 0),
      counted: sum.counted + (m.receipt?.costMicros !== null && m.receipt?.costMicros !== undefined ? 1 : 0),
    }),
    { tokens: 0, micros: 0, counted: 0 },
  );
  const allModels = state?.models ?? [];
  const unpricedCount = allModels.filter((m) => !m.priced).length;
  const visibleModels = allModels.filter((m) => m.priced || showUnpriced || m.id === model);

  return createPortal(
    <>
      <button
        type="button"
        ref={orbRef}
        className={`chat-orb${open ? " chat-orb--open" : ""}`}
        aria-label={open ? "Minimise USAGE Chat" : "Open USAGE Chat"}
        aria-expanded={open}
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <span className="chat-orb__core" aria-hidden="true" />
        {hasConversation && !open && <span className="chat-orb__dot" aria-hidden="true" />}
      </button>

      <div className={`chat-backdrop${open ? " chat-backdrop--open" : ""}`} onClick={closePanel} aria-hidden="true" />

      <section
        className={`chat-panel${open ? " chat-panel--open" : ""}${expanded ? " chat-panel--expanded" : ""}`}
        aria-label="USAGE Chat"
        aria-hidden={!open}
      >
        <header className="chat-panel__head">
          <div className="min-w-0">
            <p className="tnum text-[11px] font-medium tracking-[0.3em]">USAGE CHAT</p>
            <p className="mt-1 truncate text-[11px]" style={{ color: routeTone }}>
              {route ? (route.kind === "none" ? route.reason : `${route.label} · ${routeWord}`) : "Loading route…"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="chat-btn"
              onClick={() => {
                // Personal instructions: this browser only, like the
                // conversation. Read when the drawer opens rather than by an
                // effect that watches nothing.
                if (!settingsOpen) {
                  try {
                    setPreferences(window.localStorage.getItem(PREFERENCES_KEY) ?? "");
                  } catch {
                    // Storage refused; the field simply starts empty.
                  }
                }
                setSettingsOpen((s) => !s);
              }}
              aria-label="Personal instructions"
              aria-pressed={settingsOpen}
            >
              ⚙
            </button>
            <button type="button" className="chat-btn" onClick={startConversation} disabled={streaming}>
              New
            </button>
            <button
              type="button"
              className="chat-btn"
              onClick={() => setExpanded((e) => !e)}
              aria-label={expanded ? "Shrink" : "Expand"}
              aria-pressed={expanded}
            >
              {expanded ? "⤡" : "⤢"}
            </button>
            <button type="button" className="chat-btn" onClick={closePanel} aria-label="Minimise">
              —
            </button>
          </div>
        </header>

        {stateError && <p className="chat-note chat-note--warn">{stateError}</p>}

        {settingsOpen && (
          <div className="chat-settings">
            <label className="block text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]" htmlFor="chat-preferences">
              Personal instructions
            </label>
            <textarea
              id="chat-preferences"
              className="chat-input mt-1.5 w-full"
              rows={4}
              maxLength={MAX_PREFERENCES_CHARS}
              placeholder="What you use AI for, how you like answers, anything the assistant should always know."
              value={preferences}
              onChange={(e) => {
                setPreferences(e.target.value);
                try {
                  window.localStorage.setItem(PREFERENCES_KEY, e.target.value);
                } catch {
                  // Storage refused; the instructions still apply this session.
                }
              }}
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--faint)]">
              Sent with every message and kept in this browser only. {preferences.length}/{MAX_PREFERENCES_CHARS}
            </p>
          </div>
        )}

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
            {/* One control per line. Three of them in a 440px row left the
                model name, the conversation title and the checkbox all cut in
                half, which is how a chat starts looking like a settings page. */}
            <div className="chat-toolbar">
              <label className="chat-field">
                <span>Model</span>
                <select className="chat-select" value={model} onChange={(e) => setModel(e.target.value)} disabled={streaming}>
                  {visibleModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.priced ? "" : " · earns nothing"}
                    </option>
                  ))}
                </select>
              </label>

              {history.conversations.length > 1 && (
                <label className="chat-field">
                  <span>Chat</span>
                  <select className="chat-select" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)} disabled={streaming}>
                    {history.conversations.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {unpricedCount > 0 && (
                <button
                  type="button"
                  className="chat-link chat-toolbar__more"
                  onClick={() => setShowUnpriced((v) => !v)}
                  disabled={streaming}
                  title="Models without an approved protocol price are measured but earn nothing."
                >
                  {showUnpriced
                    ? `Showing all ${allModels.length} models · show only the ${allModels.length - unpricedCount} that earn`
                    : `Show all ${allModels.length} models, including ${unpricedCount} that earn nothing`}
                </button>
              )}
            </div>

            {state?.cap && route.kind === "shared" && (
              <div className="chat-credit">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">Starting credit</span>
                  <span className="tnum text-sm" style={{ color: state.cap.credit.remainingMicros > 0 ? "var(--foreground)" : "var(--warn)" }}>
                    {formatMicros(state.cap.credit.remainingMicros)}
                    <span className="text-[10px] text-[var(--faint)]"> of {formatMicros(state.cap.credit.grantMicros)}</span>
                  </span>
                </div>
                <div className="chat-credit__bar" aria-hidden="true">
                  <span style={{ width: `${state.cap.credit.grantMicros > 0 ? Math.round((100 * state.cap.credit.remainingMicros) / state.cap.credit.grantMicros) : 0}%` }} />
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--faint)]">
                  {state.cap.refusal === "credit"
                    ? "Used up. Connect a paid provider of your own to keep chatting, and to earn."
                    : `Today ${state.cap.requestsToday}/${state.cap.requestLimit} messages, ${formatMicros(state.cap.spentMicros)} of ${formatMicros(state.cap.capMicros)}. USAGE pays for this credit, so it is measured but cannot earn.`}
                </p>
              </div>
            )}

            <div
              className="chat-list"
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }}
            >
              {(!active || active.messages.length === 0) && (
                <p className="chat-empty text-[11px] leading-relaxed text-[var(--muted)]">
                  Every message goes through USAGE, is measured and priced, and gets a receipt below the reply.
                  The conversation itself stays in this browser; USAGE keeps the metadata only.
                </p>
              )}
              {active?.messages.map((m) => {
                const isDocument =
                  m.role === "assistant" && m.content.length > 0 && looksLikeDocument(parseMarkdown(m.content), m.content);
                return (
                  <div key={m.id} className={`chat-msg chat-msg--${m.role}`}>
                    <div className="chat-msg__body">
                      {m.role === "assistant" ? (
                        m.content ? (
                          <Markdown text={m.content} />
                        ) : streaming ? (
                          <span className="chat-cursor" />
                        ) : null
                      ) : (
                        m.content
                      )}
                    </div>
                    {m.role === "assistant" && m.content.length > 0 && !streaming && (
                      <div className="chat-msg__tools">
                        <button
                          type="button"
                          className="chat-link"
                          onClick={() => {
                            void navigator.clipboard?.writeText(m.content);
                            setCopiedId(m.id);
                            window.setTimeout(() => setCopiedId((id) => (id === m.id ? null : id)), 1600);
                          }}
                        >
                          {copiedId === m.id ? "Copied" : "Copy"}
                        </button>
                        {isDocument && (
                          <button type="button" className="chat-link" onClick={() => setDocumentId(m.id)}>
                            Open as document
                          </button>
                        )}
                      </div>
                    )}
                    {m.role === "assistant" && m.receipt && <ReceiptLine receipt={m.receipt} model={m.model} />}
                  </div>
                );
              })}
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
                rows={1}
                placeholder="Message…  (Ctrl+K opens this, Enter sends)"
                value={draft}
                disabled={streaming}
                onChange={(e) => {
                  setDraft(e.target.value);
                  // Grow with the message, up to a third of the panel.
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
                }}
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
              <span className="flex items-center gap-3">
                {totals.counted > 0 && (
                  <span className="tnum" title="What this conversation has cost, from the persisted receipts.">
                    {totals.tokens.toLocaleString()} tokens · {formatMicros(totals.micros)}
                  </span>
                )}
                {active && active.messages.length > 0 && (
                  <button type="button" className="chat-link" onClick={() => deleteConversation(active.id)} disabled={streaming}>
                    Delete
                  </button>
                )}
                <button type="button" className="chat-link" onClick={clearAll} disabled={streaming || !hasConversation}>
                  Clear all
                </button>
              </span>
            </div>
          </>
        )}
      </section>

      {documentId && active && (
        <div className="chat-doc" role="dialog" aria-label="Document">
          <div className="chat-doc__bar">
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">{active.title}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="chat-btn"
                onClick={() => void navigator.clipboard?.writeText(active.messages.find((m) => m.id === documentId)?.content ?? "")}
              >
                Copy
              </button>
              <button type="button" className="chat-btn" onClick={() => window.print()}>
                Print / PDF
              </button>
              <button type="button" className="chat-btn" onClick={() => setDocumentId(null)} aria-label="Close">
                ✕
              </button>
            </div>
          </div>
          <article className="chat-doc__page">
            <Markdown text={active.messages.find((m) => m.id === documentId)?.content ?? ""} />
          </article>
        </div>
      )}
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
