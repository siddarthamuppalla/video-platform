import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { query } from "./db.js";
import { HttpError } from "./errors.js";

export type User = { id: string; email: string; username: string };

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const COOKIE = "reel_session";
// The cookie carries a random token; the database stores only its hash, so a leaked table can't be replayed.
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

async function startSession(res: Response, userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    hashToken(token),
    userId,
    expires,
  ]);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    expires,
    path: "/",
  });
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    const { rows } = await query<User>(
      `SELECT u.id, u.email, u.username FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    req.user = rows[0];
  }
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, "Sign in to do that.");
  next();
}

const registerBody = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_]{3,24}$/, "Usernames are 3 to 24 letters, numbers or underscores."),
  password: z.string().min(8, "Use at least 8 characters."),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const body = registerBody.parse(req.body);
  const hash = await bcrypt.hash(body.password, 10);
  const { rows } = await query<User>(
    `INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id, email, username`,
    [body.email, body.username, hash],
  );
  if (!rows[0]) throw new HttpError(409, "That email or username is already taken.");
  await startSession(res, rows[0].id);
  res.status(201).json({ user: rows[0] });
});

authRouter.post("/login", async (req, res) => {
  const body = loginBody.parse(req.body);
  const { rows } = await query<User & { password_hash: string }>(
    "SELECT id, email, username, password_hash FROM users WHERE email = $1",
    [body.email],
  );
  const row = rows[0];
  if (!row || !(await bcrypt.compare(body.password, row.password_hash))) {
    throw new HttpError(401, "That email and password don't match.");
  }
  await startSession(res, row.id);
  res.json({ user: { id: row.id, email: row.email, username: row.username } });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  res.clearCookie(COOKIE, { path: "/" });
  res.status(204).end();
});

authRouter.get("/me", (req, res) => {
  res.json({ user: req.user ?? null });
});
