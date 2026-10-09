import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";
import { Watch } from "./pages/Watch";
import { Upload } from "./pages/Upload";
import { MyVideos } from "./pages/MyVideos";
import { AuthForm } from "./pages/AuthForm";

function RequireUser({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to="/signin" replace state={{ next: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/watch/:id" element={<Watch />} />
        <Route path="/upload" element={<RequireUser><Upload /></RequireUser>} />
        <Route path="/my-videos" element={<RequireUser><MyVideos /></RequireUser>} />
        <Route path="/signin" element={<AuthForm mode="signin" />} />
        <Route path="/signup" element={<AuthForm mode="signup" />} />
        <Route path="*" element={<main className="page"><p className="type-title">That page doesn't exist.</p></main>} />
      </Routes>
    </>
  );
}
