import express from "express";
import cookieParser from "cookie-parser";
import { paths } from "./config.js";
import { authRouter, loadUser } from "./auth.js";
import { uploadsRouter } from "./uploads.js";
import { videosRouter } from "./videos.js";
import { errorHandler } from "./errors.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cookieParser());
  app.use(express.json({ limit: "100kb" }));
  app.use(loadUser);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/auth", authRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api/videos", videosRouter);

  // HLS output is plain files: playlists (.m3u8), segments (.ts) and a thumbnail.
  // The original upload stays private.
  app.use("/media", (req, res, next) => {
    if (/\/source\.[^/]+$/.test(req.path)) {
      res.status(404).end();
      return;
    }
    next();
  });
  app.use(
    "/media",
    express.static(paths.mediaRoot(), {
      fallthrough: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".m3u8")) {
          res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.endsWith(".ts")) {
          res.setHeader("Content-Type", "video/mp2t");
          // Segments never change once written, so browsers can cache them forever.
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use(errorHandler);
  return app;
}
