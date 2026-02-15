import { config } from "../config";

export type GraphEventInput = {
  organizerUserId: string;
  subject: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
  attendeeEmail: string;
  body: string;
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

export class GraphClient {
  async getBusySlots(m365TenantId: string, userId: string, startUtcIso: string, endUtcIso: string): Promise<GraphBusySlot[]>;
  async getBusySlots(...args: [string, string, string, string]): Promise<GraphBusySlot[]> {
    const [m365TenantId, userId, startUtcIso, endUtcIso] = args;
    void m365TenantId;
    void userId;
    void startUtcIso;
    void endUtcIso;
    if (config.graphMock) {
      return [];
    }
    throw new Error("Graph client not implemented");
  }

  async createEvent(m365TenantId: string, input: GraphEventInput): Promise<GraphEventResult>;
  async createEvent(...args: [GraphEventInput] | [string, GraphEventInput]): Promise<GraphEventResult> {
    const input = (args.length === 1 ? args[0] : args[1]) as GraphEventInput;
    const m365TenantId = (args.length === 2 ? args[0] : undefined) as string | undefined;
    void m365TenantId;
    if (config.graphMock) {
      void m365TenantId;
      return {
        eventId: `mock-event-${hash(input.subject)}`,
        iCalUId: `mock-ical-${hash(input.subject)}`,
        etag: `mock-etag-${Date.now()}`
      };
    }
    throw new Error("Graph client not implemented");
  }

  async getEvent(eventId: string): Promise<GraphEventDetails>;
  async getEvent(m365TenantId: string, eventId: string): Promise<GraphEventDetails>;
  async getEvent(...args: [string] | [string, string]): Promise<GraphEventDetails> {
    const m365TenantId = (args.length === 2 ? args[0] : undefined) as string | undefined;
    const eventId = (args.length === 2 ? args[1] : args[0]) as string;
    void m365TenantId;
    if (config.graphMock) {
      const now = Date.now();
      return {
        eventId,
        startUtc: new Date(now + 15 * 60_000).toISOString(),
        endUtc: new Date(now + 75 * 60_000).toISOString(),
        etag: `mock-etag-${now}`
      };
    }
    throw new Error("Graph client not implemented");
  }

  async deleteEvent(m365TenantId: string, organizerUserId: string, eventId: string): Promise<void>;
  async deleteEvent(...args: [string] | [string, string, string]): Promise<void> {
    const eventId = (args.length === 1 ? args[0] : args[2]) as string;
    const m365TenantId = (args.length === 3 ? args[0] : undefined) as string | undefined;
    const organizerUserId = (args.length === 3 ? args[1] : undefined) as string | undefined;
    void m365TenantId;
    void organizerUserId;
    if (config.graphMock) {
      void m365TenantId; void organizerUserId; void eventId;
      return;
    }
    throw new Error("Graph client not implemented");
  }

  async sendMail(): Promise<void>;
  async sendMail(m365TenantId: string, input: GraphSendMailInput): Promise<void>;
  async sendMail(...args: [] | [string, GraphSendMailInput]): Promise<void> {
    const m365TenantId = (args.length === 2 ? args[0] : undefined) as string | undefined;
    const input = (args.length === 2 ? args[1] : undefined) as GraphSendMailInput | undefined;
    void m365TenantId;
    void input;
    if (config.graphMock) {
      return;
    }
    throw new Error("Graph client not implemented");
  }

  async createSubscription(input: GraphSubscriptionInput): Promise<GraphSubscriptionResult>;
  async createSubscription(m365TenantId: string, input: GraphSubscriptionInput): Promise<GraphSubscriptionResult>;
  async createSubscription(...args: [GraphSubscriptionInput] | [string, GraphSubscriptionInput]): Promise<GraphSubscriptionResult> {
    const m365TenantId = (args.length === 2 ? args[0] : undefined) as string | undefined;
    const input = (args.length === 2 ? args[1] : args[0]) as GraphSubscriptionInput;
    void m365TenantId;
    if (config.graphMock) {
      return {
        subscriptionId: `mock-sub-${hash(input.resource)}-${Date.now()}`,
        expiresAtUtc: input.expirationUtc
      };
    }
    throw new Error("Graph client not implemented");
  }

  async renewSubscription(subscriptionId: string, expirationUtc: string): Promise<GraphSubscriptionResult>;
  async renewSubscription(m365TenantId: string, subscriptionId: string, expirationUtc: string): Promise<GraphSubscriptionResult>;
  async renewSubscription(...args: [string, string] | [string, string, string]): Promise<GraphSubscriptionResult> {
    const m365TenantId = (args.length === 3 ? args[0] : undefined) as string | undefined;
    const subscriptionId = (args.length === 3 ? args[1] : args[0]) as string;
    const expirationUtc = (args.length === 3 ? args[2] : args[1]) as string;
    void m365TenantId;
    if (config.graphMock) {
      return {
        subscriptionId,
        expiresAtUtc: expirationUtc
      };
    }
    throw new Error("Graph client not implemented");
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
