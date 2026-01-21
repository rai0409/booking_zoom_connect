import * as dotenv from "dotenv";

dotenv.config({ path: process.env.ENV_FILE || ".env" });
process.env.GRAPH_MOCK = "true";
process.env.ZOOM_MOCK = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.BASE_URL = process.env.BASE_URL || "http://localhost:3000";
