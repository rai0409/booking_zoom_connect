import { z } from "zod";
export declare const GraphWebhookJobPayloadSchema: z.ZodObject<{
    tenant_id: z.ZodString;
    salesperson_id: z.ZodString;
    subscription_id: z.ZodString;
    change_type: z.ZodEnum<["created", "updated", "deleted"]>;
    resource_id: z.ZodString;
    received_at_utc: z.ZodString;
}, "strip", z.ZodTypeAny, {
    tenant_id: string;
    salesperson_id: string;
    subscription_id: string;
    change_type: "created" | "updated" | "deleted";
    resource_id: string;
    received_at_utc: string;
}, {
    tenant_id: string;
    salesperson_id: string;
    subscription_id: string;
    change_type: "created" | "updated" | "deleted";
    resource_id: string;
    received_at_utc: string;
}>;
export type GraphWebhookJobPayload = z.infer<typeof GraphWebhookJobPayloadSchema>;
