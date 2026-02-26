import { config } from "../config";
import { DateTime } from "luxon";
import { log } from "../utils/logger";

export type GraphEventInput = {
  organizerUserId: string;
  subject: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
  attendeeEmail: string;
  body: string;
  transactionId?: string;
};

export type GraphEventResult = {
  eventId: string;
  iCalUId: string;
  etag: string;
};

export type GraphBusySlot = { startUtc: string; endUtc: string };
export type GraphSendMailInput = {
  to: string;
  subject: string;
  body: string;
};
export type GraphEventDetails = { eventId: string; startUtc: string; endUtc: string; etag: string };
export type GraphSubscriptionInput = { resource: string; expirationUtc: string; clientState?: string };
export type GraphSubscriptionResult = { subscriptionId: string; expiresAtUtc: string };

type TokenCacheEntry = { accessToken: string; expiresAtMs: number };
type ScheduleEmailCacheEntry = { email: string; expiresAtMs: number };

export class GraphClient {
  private tokenCache = new Map<string, TokenCacheEntry>();
  private scheduleEmailCache = new Map<string, ScheduleEmailCacheEntry>();
  private readonly scheduleEmailTtlMs = 24 * 60 * 60 * 1000;

  private graphBase() {
    return "https://graph.microsoft.com/v1.0";
  }

  private async getAccessToken(m365TenantId: string): Promise<string> {
    if (!m365TenantId) throw new Error("m365TenantId required");
    if (!config.msClientId || !config.msClientSecret) {
      throw new Error("MS_CLIENT_ID/MS_CLIENT_SECRET required");
    }

    const cached = this.tokenCache.get(m365TenantId);
    const now = Date.now();
    if (cached && cached.expiresAtMs - 60_000 > now) {
      return cached.accessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
      m365TenantId
    )}/oauth2/v2.0/token`;

    const form = new URLSearchParams();
    form.set("client_id", config.msClientId);
    form.set("client_secret", config.msClientSecret);
    form.set("scope", "https://graph.microsoft.com/.default");
    form.set("grant_type", "client_credentials");

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Graph token failed: ${res.status} ${txt}`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAtMs = now + Math.max(0, (json.expires_in || 3600) * 1000);
    this.tokenCache.set(m365TenantId, { accessToken: json.access_token, expiresAtMs });
    return json.access_token;
  }

  private async graphFetch(m365TenantId: string, path: string, init?: RequestInit) {
    const token = await this.getAccessToken(m365TenantId);
    const url = `${this.graphBase()}${path}`;
    const headers = new Headers(init?.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(url, { ...init, headers });
    return res;
  }

  private isoNoZ(isoUtc: string) {
    const dt = DateTime.fromISO(isoUtc, { zone: "utc" });
    return dt.toFormat("yyyy-LL-dd'T'HH:mm:ss");
  }

  private async resolveScheduleEmail(m365TenantId: string, userId: string): Promise<string | null> {
    const cacheKey = `${m365TenantId}:${userId}`;
    const cached = this.scheduleEmailCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAtMs > now) {
      return cached.email;
    }

    try {
      const res = await this.graphFetch(
        m365TenantId,
        `/users/${encodeURIComponent(userId)}?$select=mail,userPrincipalName`,
        { method: "GET" }
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`resolveScheduleEmail failed: ${res.status} ${txt}`);
      }

      const json = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
      const scheduleEmail = String(json.mail || json.userPrincipalName || "").trim();
      if (!scheduleEmail) {
        throw new Error("mail and userPrincipalName are empty");
      }

      this.scheduleEmailCache.set(cacheKey, {
        email: scheduleEmail,
        expiresAtMs: now + this.scheduleEmailTtlMs
      });
      return scheduleEmail;
    } catch (err) {
      log("warn", "graph_schedule_email_resolve_failed", {
        tenantId: m365TenantId,
        userId,
        err: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  async getBusySlots(m365TenantId: string, userId: string, startUtcIso: string, endUtcIso: string): Promise<GraphBusySlot[]>;
  async getBusySlots(...args: [string, string, string, string]): Promise<GraphBusySlot[]> {
    const [m365TenantId, userId, startUtcIso, endUtcIso] = args;
    if (config.graphMock) {
      void m365TenantId;
      void userId;
      void startUtcIso;
      void endUtcIso;
      return [];
    }

    const scheduleEmail = await this.resolveScheduleEmail(m365TenantId, userId);
    if (!scheduleEmail) {
      return [{ startUtc: startUtcIso, endUtc: endUtcIso }];
    }

    const body = {
      schedules: [scheduleEmail],
      startTime: { dateTime: this.isoNoZ(startUtcIso), timeZone: "UTC" },
      endTime: { dateTime: this.isoNoZ(endUtcIso), timeZone: "UTC" },
      availabilityViewInterval: 60
    };

    const res = await this.graphFetch(m365TenantId, `/users/${encodeURIComponent(userId)}/calendar/getSchedule`, {
      method: "POST",
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`getSchedule failed: ${res.status} ${txt}`);
    }

    const json = (await res.json()) as any;
    const value = Array.isArray(json?.value) ? json.value : [];
    const first = value[0];
    const items = Array.isArray(first?.scheduleItems) ? first.scheduleItems : [];

    const busy: GraphBusySlot[] = [];
    for (const it of items) {
      const status = (it?.status || "").toLowerCase();
      if (status === "free") continue;
      const s = it?.start;
      const e = it?.end;
      if (!s?.dateTime || !e?.dateTime) continue;
      const sTz = s?.timeZone || "UTC";
      const eTz = e?.timeZone || "UTC";
      const startUtc = DateTime.fromISO(String(s.dateTime), { zone: sTz }).toUTC().toISO();
      const endUtc = DateTime.fromISO(String(e.dateTime), { zone: eTz }).toUTC().toISO();
      if (!startUtc || !endUtc) continue;
      busy.push({ startUtc, endUtc });
    }

    return busy;
  }

  async createEvent(m365TenantId: string, input: GraphEventInput): Promise<GraphEventResult>;
  async createEvent(...args: [GraphEventInput] | [string, GraphEventInput]): Promise<GraphEventResult> {
    const input = (args.length === 1 ? args[0] : args[1]) as GraphEventInput;
    const m365TenantId = (args.length === 2 ? args[0] : undefined) as string | undefined;

    if (config.graphMock) {
      void m365TenantId;
      return {
        eventId: `mock-event-${hash(input.subject)}-${Date.now()}`,
        iCalUId: `mock-ical-${hash(input.subject)}-${Date.now()}`,
        etag: `mock-etag-${Date.now()}`
      };
    }
    if (!m365TenantId) throw new Error("m365TenantId required");

    const payload: any = {
      subject: input.subject,
      showAs: "busy",
      sensitivity: "private",
      start: { dateTime: this.isoNoZ(input.startUtc), timeZone: "UTC" },
      end: { dateTime: this.isoNoZ(input.endUtc), timeZone: "UTC" },
      body: { contentType: "text", content: input.body },
      attendees: [
        {
          emailAddress: { address: input.attendeeEmail },
          type: "required"
        }
      ]
    };
    if (input.transactionId) payload.transactionId = input.transactionId;

    const res = await this.graphFetch(
      m365TenantId,
      `/users/${encodeURIComponent(input.organizerUserId)}/events`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`createEvent failed: ${res.status} ${txt}`);
    }

    const json = (await res.json()) as any;
    const etag = json?.["@odata.etag"] || "";
    return {
      eventId: String(json?.id || ""),
      iCalUId: String(json?.iCalUId || ""),
      etag: String(etag)
    };
  }

  async getEvent(m365TenantId: string, organizerUserId: string, eventId: string): Promise<GraphEventDetails>;
  async getEvent(...args: [string] | [string, string, string]): Promise<GraphEventDetails> {
    // Backward-compat for mock-only path: getEvent(eventId)
    if (args.length === 1) {
      const eventId = args[0];
      if (!config.graphMock) {
        throw new Error("getEvent(eventId) is not supported in non-mock mode. Use getEvent(m365TenantId, organizerUserId, eventId). ");
      }
      const now = Date.now();
      return {
        eventId,
        startUtc: new Date(now + 15 * 60_000).toISOString(),
        endUtc: new Date(now + 75 * 60_000).toISOString(),
        etag: `mock-etag-${now}`
      };
    }

    const [m365TenantId, organizerUserId, eventId] = args as [string, string, string];
    if (config.graphMock) {
      const now = Date.now();
      return {
        eventId,
        startUtc: new Date(now + 15 * 60_000).toISOString(),
        endUtc: new Date(now + 75 * 60_000).toISOString(),
        etag: `mock-etag-${now}`
      };
    }

    const res = await this.graphFetch(
      m365TenantId,
      `/users/${encodeURIComponent(organizerUserId)}/events/${encodeURIComponent(eventId)}?$select=id,start,end`,
      { method: "GET" }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`getEvent failed: ${res.status} ${txt}`);
    }

    const json = (await res.json()) as any;
    const start = json?.start;
    const end = json?.end;
    const startUtc = DateTime.fromISO(String(start?.dateTime || ""), { zone: start?.timeZone || "UTC" })
      .toUTC()
      .toISO();
    const endUtc = DateTime.fromISO(String(end?.dateTime || ""), { zone: end?.timeZone || "UTC" })
      .toUTC()
      .toISO();
    const etag = json?.["@odata.etag"] || "";

    return {
      eventId: String(json?.id || eventId),
      startUtc: startUtc || "",
      endUtc: endUtc || "",
      etag: String(etag)
    };
  }

  async deleteEvent(m365TenantId: string, organizerUserId: string, eventId: string): Promise<void>;
  async deleteEvent(...args: [string] | [string, string, string]): Promise<void> {
    const eventId = (args.length === 1 ? args[0] : args[2]) as string;
    const m365TenantId = (args.length === 3 ? args[0] : undefined) as string | undefined;
    const organizerUserId = (args.length === 3 ? args[1] : undefined) as string | undefined;

    if (config.graphMock) {
      void m365TenantId;
      void organizerUserId;
      void eventId;
      return;
    }
    if (!m365TenantId || !organizerUserId) throw new Error("m365TenantId/organizerUserId required");

    const res = await this.graphFetch(
      m365TenantId,
      `/users/${encodeURIComponent(organizerUserId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" }
    );
    if (!res.ok && res.status !== 404) {
      const txt = await res.text().catch(() => "");
      throw new Error(`deleteEvent failed: ${res.status} ${txt}`);
    }
  }

  async sendMail(): Promise<void>;
  async sendMail(m365TenantId: string, input: GraphSendMailInput): Promise<void>;
  async sendMail(...args: [] | [string, GraphSendMailInput]): Promise<void> {
    const m365TenantId = (args.length === 2 ? args[0] : undefined) as string | undefined;
    const input = (args.length === 2 ? args[1] : undefined) as GraphSendMailInput | undefined;

    if (config.graphMock) {
      return;
    }
    if (!m365TenantId || !input) throw new Error("sendMail(m365TenantId, input) required");
    if (!config.msSharedMailbox) {
      throw new Error("MS_SHARED_MAILBOX required for app-only sendMail");
    }

    const payload = {
      message: {
        subject: input.subject,
        body: { contentType: "text", content: input.body },
        toRecipients: [{ emailAddress: { address: input.to } }]
      }
    };

    const res = await this.graphFetch(
      m365TenantId,
      `/users/${encodeURIComponent(config.msSharedMailbox)}/sendMail`,
      { method: "POST", body: JSON.stringify(payload) }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`sendMail failed: ${res.status} ${txt}`);
    }
  }

  async createSubscription(input: GraphSubscriptionInput): Promise<GraphSubscriptionResult>;
  async createSubscription(m365TenantId: string, input: GraphSubscriptionInput): Promise<GraphSubscriptionResult>;
  async createSubscription(...args: [GraphSubscriptionInput] | [string, GraphSubscriptionInput]): Promise<GraphSubscriptionResult> {
    const m365TenantId = (args.length === 2 ? args[0] : undefined) as string | undefined;
    const input = (args.length === 2 ? args[1] : args[0]) as GraphSubscriptionInput;

    if (config.graphMock) {
      return {
        subscriptionId: `mock-sub-${hash(input.resource)}-${Date.now()}`,
        expiresAtUtc: input.expirationUtc
      };
    }
    if (!m365TenantId) throw new Error("m365TenantId required");

    const notificationUrl = `${config.apiBaseUrl.replace(/\/$/, "")}/v1/webhooks/graph`;

    const payload: any = {
      changeType: "updated,deleted",
      notificationUrl,
      resource: input.resource,
      expirationDateTime: input.expirationUtc,
      clientState: input.clientState,
      latestSupportedTlsVersion: "v1_2"
    };

    const res = await this.graphFetch(m365TenantId, `/subscriptions`, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`createSubscription failed: ${res.status} ${txt}`);
    }

    const json = (await res.json()) as any;
    return {
      subscriptionId: String(json?.id || ""),
      expiresAtUtc: String(json?.expirationDateTime || input.expirationUtc)
    };
  }

  async renewSubscription(subscriptionId: string, expirationUtc: string): Promise<GraphSubscriptionResult>;
  async renewSubscription(m365TenantId: string, subscriptionId: string, expirationUtc: string): Promise<GraphSubscriptionResult>;
  async renewSubscription(...args: [string, string] | [string, string, string]): Promise<GraphSubscriptionResult> {
    const m365TenantId = (args.length === 3 ? args[0] : undefined) as string | undefined;
    const subscriptionId = (args.length === 3 ? args[1] : args[0]) as string;
    const expirationUtc = (args.length === 3 ? args[2] : args[1]) as string;

    if (config.graphMock) {
      return { subscriptionId, expiresAtUtc: expirationUtc };
    }
    if (!m365TenantId) throw new Error("m365TenantId required");

    const payload = { expirationDateTime: expirationUtc };

    const res = await this.graphFetch(m365TenantId, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`renewSubscription failed: ${res.status} ${txt}`);
    }

    const json = (await res.json()) as any;
    return {
      subscriptionId: String(json?.id || subscriptionId),
      expiresAtUtc: String(json?.expirationDateTime || expirationUtc)
    };
  }
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
