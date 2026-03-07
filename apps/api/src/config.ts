export const config = {
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:4000",
  nodeEnv: process.env.NODE_ENV || "development",
  adminApiKey: process.env.ADMIN_API_KEY || "change-me",
  mailDriver: (process.env.MAIL_DRIVER || "graph").toLowerCase(),
  graphMock: (process.env.GRAPH_MOCK || "false").toLowerCase() === "true",
  zoomMock: (process.env.ZOOM_MOCK || "false").toLowerCase() === "true",
  queueDriver: (process.env.QUEUE_DRIVER || "memory").toLowerCase(),
  serviceBusConnection: process.env.SERVICEBUS_CONNECTION || "",
  serviceBusQueueName: process.env.SERVICEBUS_QUEUE_NAME || "graph-webhooks",
  msClientId: process.env.MS_CLIENT_ID || "",
  msClientSecret: process.env.MS_CLIENT_SECRET || "",
  msSharedMailbox: process.env.MS_SHARED_MAILBOX || "",
  zoomAccountId: process.env.ZOOM_ACCOUNT_ID || "",
  zoomClientId: process.env.ZOOM_CLIENT_ID || "",
  zoomClientSecret: process.env.ZOOM_CLIENT_SECRET || ""
};
