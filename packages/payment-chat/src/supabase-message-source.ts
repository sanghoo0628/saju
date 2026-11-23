import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { ChatMessage } from "../../../contracts/payment-chat.ts";
import {
  schedule,
  type MessageSource,
  type Schedule,
} from "./message-source.ts";

type Client = Pick<SupabaseClient, "channel" | "removeChannel"> & {
  auth: Pick<SupabaseClient["auth"], "getUser" | "onAuthStateChange">;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
/** Copy only public message fields. DELETE/UPDATE and unrelated rows never reach the UI. */
export function decodeInsertedMessage(
  payload: unknown,
  conversationId: string,
): ChatMessage | undefined {
  if (!payload || typeof payload !== "object") return;
  const event = payload as Record<string, unknown>;
  if (
    event.eventType !== "INSERT" ||
    event.schema !== "public" ||
    event.table !== "messages" ||
    (event.errors != null &&
      (!Array.isArray(event.errors) || event.errors.length))
  )
    return;
  if (!event.new || typeof event.new !== "object") return;
  const row = event.new as Record<string, unknown>;
  if (
    !uuid(row.id) ||
    row.conversation_id !== conversationId ||
    !uuid(row.sender_id) ||
    typeof row.body !== "string" ||
    !row.body.trim() ||
    row.body.length > 2000 ||
    typeof row.created_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(row.created_at) ||
    !Number.isFinite(Date.parse(row.created_at))
  )
    return;
  return {
    id: row.id,
    conversationId,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

/** Browser authenticated client only. Never pass a service-role/secret-key client. */
export function createSupabaseMessageSource(
  client: Client,
  options: { retryMs?: number; schedule?: Schedule } = {},
): MessageSource {
  const retryMs = options.retryMs ?? 5000;
  if (!Number.isFinite(retryMs) || retryMs < 1 || retryMs > 60000)
    throw new Error("Invalid realtime retry delay");
  const later = options.schedule ?? schedule;
  return {
    subscribe(request) {
      if (!uuid(request.userId) || !uuid(request.conversationId))
        throw new Error("Canonical Supabase UUIDs are required");
      let active = true;
      let channel: RealtimeChannel | undefined;
      let cancelRetry: (() => void) | undefined;
      let detachAuth: (() => void) | undefined;
      const notify = (status: Parameters<typeof request.onStatus>[0]) => {
        if (active) {
          try {
            request.onStatus(status);
          } catch {
            /* Observer failure must not break SDK cleanup. */
          }
        }
      };
      const detach = () => {
        const old = detachAuth;
        detachAuth = undefined;
        try {
          old?.();
        } catch {
          /* Keep channel cleanup possible. */
        }
      };
      const remove = () => {
        if (!channel) return;
        const old = channel;
        channel = undefined;
        try {
          void Promise.resolve(client.removeChannel(old)).catch(() => {});
        } catch {
          /* Already disconnected. */
        }
      };
      const stop = () => {
        if (!active) return;
        active = false;
        cancelRetry?.();
        detach();
        remove();
      };
      const unauthorized = () => {
        if (!active) return;
        active = false;
        try {
          request.onStatus("auth_required");
        } catch {
          /* Isolate consumers. */
        }
        // Supabase warns against awaiting auth operations inside onAuthStateChange callbacks.
        active = false;
        cancelRetry?.();
        queueMicrotask(() => {
          detach();
          remove();
        });
      };
      const retry = () => {
        if (!active) return;
        notify("reconnecting");
        cancelRetry?.();
        cancelRetry = later(() => {
          cancelRetry = undefined;
          void connect();
        }, retryMs);
      };
      async function connect() {
        if (!active || channel) return;
        try {
          const { data, error } = await client.auth.getUser();
          if (!active) return;
          if (error) {
            const status = (error as { status?: number }).status;
            if (status === 0 || (status !== undefined && status >= 500))
              retry();
            else unauthorized();
            return;
          }
          if (data.user?.id !== request.userId) {
            unauthorized();
            return;
          }
          const current = client.channel(
            `c-messages:${request.userId}:${request.conversationId}:${crypto.randomUUID()}`,
            {
              config: { postgres_changes_options: { wait: true } },
            },
          );
          channel = current;
          current
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "messages",
                filter: `conversation_id=eq.${request.conversationId}`,
              },
              (payload) => {
                if (!active || channel !== current) return;
                const message = decodeInsertedMessage(
                  payload,
                  request.conversationId,
                );
                if (message) {
                  try {
                    request.onMessage(message);
                  } catch {
                    /* Keep the stream and cleanup usable. */
                  }
                }
              },
            )
            .subscribe((status) => {
              if (!active || channel !== current) return;
              if (status === "SUBSCRIBED") notify("live");
              else if (status === "CLOSED") {
                remove();
                retry();
              } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
                notify("reconnecting");
              // The SDK rejoins established channels; the HTTP session fills any gaps.
            });
        } catch {
          remove();
          retry();
        }
      }
      notify("connecting");
      try {
        const { data } = client.auth.onAuthStateChange((_event, session) => {
          if (session?.user.id !== request.userId) unauthorized();
        });
        detachAuth = () => data.subscription.unsubscribe();
        if (!active) queueMicrotask(detach);
        else void connect();
      } catch {
        notify("closed");
        stop();
      }
      return stop;
    },
  };
}
