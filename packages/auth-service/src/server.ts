import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "dotenv";
import { providerRoutes } from "./routes/providers.js";
import { connectionRoutes } from "./routes/connections.js";
import { authRoutes } from "./routes/auth.js";
import { proxyRoutes } from "./routes/proxy.js";
import { settingsRoutes } from "./routes/settings.js";
import { catalogRoutes } from "./routes/catalog.js";
import { cloudAuthRoutes } from "./routes/cloud-auth.js";
import { workflowControlPlaneRoutes } from "./services/workflow-control-plane-routes.js";
import { oauthProviderRoutes } from "./routes/oauth-providers.js";

config();

const app: import("express").Express = express();
const PORT = process.env.PORT || 4000;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "10mb";

type RequestBodyError = Error & {
  body?: unknown;
  status?: number;
  type?: string;
};

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "gtmship-auth", version: "0.1.0" });
});

// Routes
app.use("/providers", providerRoutes);
app.use("/connections", connectionRoutes);
app.use("/auth", authRoutes);
app.use("/proxy", proxyRoutes);
app.use("/settings", settingsRoutes);
app.use("/catalog", catalogRoutes);
app.use("/cloud-auth", cloudAuthRoutes);
app.use("/workflow-control", workflowControlPlaneRoutes);
app.use("/workflow-control-plane", workflowControlPlaneRoutes);
app.use("/oauth-providers", oauthProviderRoutes);
app.use(
  (
    error: RequestBodyError,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error?.type === "entity.too.large" || error?.status === 413) {
      const contentLength = req.get("content-length") || "unknown";
      console.warn(
        `[request-body] ${req.method} ${req.originalUrl} exceeded JSON body limit ${JSON_BODY_LIMIT} (content-length: ${contentLength})`
      );
      res.status(413).json({
        error:
          "Request body too large. Reduce the payload size or increase JSON_BODY_LIMIT.",
        code: "request_too_large",
        limit: JSON_BODY_LIMIT,
      });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({ error: "Invalid JSON body." });
      return;
    }

    next(error);
  }
);

app.listen(PORT, () => {
  console.log(
    `🚀 GTMShip Auth Service running on port ${PORT} (JSON body limit: ${JSON_BODY_LIMIT})`
  );
});

export default app;
