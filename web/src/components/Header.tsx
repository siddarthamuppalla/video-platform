import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

export function Header() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [menuOpen, setMenuOpen] = useState(false);

  function search(e: FormEvent) {
    e.preventDefault();
    navigate(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/");
  }

  return (
    <header className="rl-header app-header">
      <Link className="rl-wordmark" to="/">
        <span className="rl-wordmark__dot" aria-hidden="true" />
        Reel
      </Link>
      <form className="app-header__search" role="search" onSubmit={search}>
        <input
          id="search"
          className="rl-header__search"
          type="search"
          placeholder="Search videos"
          aria-label="Search videos"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>
      <div className="rl-header__actions">
        {user ? (
          <>
            <Link className="rl-btn rl-btn--primary rl-btn--sm" to="/upload">
              Upload
            </Link>
            <div className="app-account">
              <button
                className="rl-avatar app-account__button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`Account menu for ${user.username}`}
                onClick={() => setMenuOpen((o) => !o)}
              >
                {user.username.slice(0, 1).toUpperCase()}
              </button>
              {menuOpen && (
                <div className="rl-menu app-account__menu" role="menu" onClick={() => setMenuOpen(false)}>
                  <div className="rl-menu__title">{user.username}</div>
                  <Link className="rl-menu__item app-menu-link" role="menuitem" to="/my-videos">
                    Your videos
                  </Link>
                  <button
                    className="rl-menu__item app-menu-link"
                    role="menuitem"
                    onClick={async () => {
                      await signOut();
                      navigate("/");
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <Link className="rl-btn rl-btn--ghost rl-btn--sm" to="/signin">
              Sign in
            </Link>
            <Link className="rl-btn rl-btn--primary rl-btn--sm" to="/signup">
              Create account
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
