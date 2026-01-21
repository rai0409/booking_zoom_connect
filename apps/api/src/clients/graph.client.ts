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
export type GraphEventDetails = { eventId: string; startUtc: string; endUtc: string; etag: string };
export type GraphSubscriptionInput = { resource: string; expirationUtc: string; clientState?: string };
export type GraphSubscriptionResult = { subscriptionId: string; expiresAtUtc: string };

export class GraphClient {
  async getBusySlots(): Promise<GraphBusySlot[]> {
    if (config.graphMock) {
      return [];
    }
    throw new Error("Graph client not implemented");
  }

  async createEvent(input: GraphEventInput): Promise<GraphEventResult> {
    if (config.graphMock) {
      return {
        eventId: `mock-event-${hash(input.subject)}`,
        iCalUId: `mock-ical-${hash(input.subject)}`,
        etag: `mock-etag-${Date.now()}`
      };
    }
    throw new Error("Graph client not implemented");
  }

  async getEvent(eventId: string): Promise<GraphEventDetails> {
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

  async deleteEvent(): Promise<void> {
    if (config.graphMock) {
      return;
    }
    throw new Error("Graph client not implemented");
  }

  async sendMail(): Promise<void> {
    if (config.graphMock) {
      return;
    }
    throw new Error("Graph client not implemented");
  }

  async createSubscription(input: GraphSubscriptionInput): Promise<GraphSubscriptionResult> {
    if (config.graphMock) {
      return {
        subscriptionId: `mock-sub-${hash(input.resource)}-${Date.now()}`,
        expiresAtUtc: input.expirationUtc
      };
    }
    throw new Error("Graph client not implemented");
  }

  async renewSubscription(subscriptionId: string, expirationUtc: string): Promise<GraphSubscriptionResult> {
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
