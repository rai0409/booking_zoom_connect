import { z } from "zod";

export const GraphWebhookJobPayloadSchema = z.object({
  tenant_id: z.string().uuid(),
  salesperson_id: z.string().uuid(),
  subscription_id: z.string(),
  change_type: z.enum(["created", "updated", "deleted"]),
  resource_id: z.string(),
  received_at_utc: z.string().datetime()
});

export type GraphWebhookJobPayload = z.infer<typeof GraphWebhookJobPayloadSchema>;
