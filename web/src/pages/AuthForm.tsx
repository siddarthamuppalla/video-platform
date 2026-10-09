import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = (location.state as { next?: string } | null)?.next ?? "/";
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") await signIn(email, password);
      else await signUp(email, username, password);
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const signup = mode === "signup";
  return (
    <main className="page page--narrow">
      <form className="panel auth" onSubmit={submit} noValidate>
        <h1 className="type-title">{signup ? "Create your account" : "Sign in"}</h1>
        <label className="rl-field">
          <span className="rl-field__label">Email</span>
          <input id="email" className="rl-field__input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {signup && (
          <label className="rl-field">
            <span className="rl-field__label">Username</span>
            <input id="username" className="rl-field__input" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
            <span className="rl-field__hint">Shown next to your videos. Letters, numbers and underscores.</span>
          </label>
        )}
        <label className={`rl-field${error ? " rl-field--error" : ""}`}>
          <span className="rl-field__label">Password</span>
          <input
            id="password"
            className="rl-field__input"
            type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="rl-field__hint" role={error ? "alert" : undefined}>
            {error ?? (signup ? "Use at least 8 characters." : " ")}
          </span>
        </label>
        <button className="rl-btn rl-btn--primary auth__submit" disabled={busy}>
          {busy ? (signup ? "Creating account…" : "Signing in…") : signup ? "Create account" : "Sign in"}
        </button>
        <p className="auth__switch">
          {signup ? (
            <>Already have an account? <Link to="/signin" state={location.state}>Sign in</Link></>
          ) : (
            <>New here? <Link to="/signup" state={location.state}>Create an account</Link></>
          )}
        </p>
      </form>
    </main>
  );
}
