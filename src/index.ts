import { Hono } from "hono";
import type { Env } from "./env";
import { handleApi } from "./http/api";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));
app.post("/api/*", (c) => handleApi(c.req.raw, c.env));

export default app;
