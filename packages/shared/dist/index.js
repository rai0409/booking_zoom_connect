"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphWebhookJobPayloadSchema = void 0;
const zod_1 = require("zod");
exports.GraphWebhookJobPayloadSchema = zod_1.z.object({
    tenant_id: zod_1.z.string().uuid(),
    salesperson_id: zod_1.z.string().uuid(),
    subscription_id: zod_1.z.string(),
    change_type: zod_1.z.enum(["created", "updated", "deleted"]),
    resource_id: zod_1.z.string(),
    received_at_utc: zod_1.z.string().datetime()
});
