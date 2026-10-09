import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? "Invalid request." });
  } else if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "That chunk is larger than the upload allows." });
  } else if (typeof err?.status === "number" && err.status < 500) {
    res.status(err.status).json({ error: err.status === 404 ? "Not found." : "Bad request." });
  } else {
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  }
};
