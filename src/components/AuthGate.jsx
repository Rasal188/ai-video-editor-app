import { useState, useEffect, useCallback } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { App } from "../App.jsx";
import { AuthModal } from "./AuthModal.jsx";
import "./AuthModal.css";

export function AuthGate() {
  const [authState, setAuthState] = useState("checking"); // "checking" | "authenticated" | "unauthenticated"
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    let isMounted = true;
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted) return;
        if (data?.user) {
          setCurrentUser(data.user);
          setAuthState("authenticated");
        } else {
          setCurrentUser(null);
          setAuthState("unauthenticated");
        }
      })
      .catch(() => {
        if (isMounted) {
          setCurrentUser(null);
          setAuthState("unauthenticated");
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const handleAuthSuccess = useCallback((user) => {
    setCurrentUser(user);
    setAuthState("authenticated");
  }, []);

  const handleLogout = useCallback(() => {
    setCurrentUser(null);
    setAuthState("unauthenticated");
  }, []);

  if (authState === "checking") {
    return (
      <div className="auth-gate-loading">
        <CircleNotch size={36} className="is-spinning auth-gate-loading-spinner" />
        <span style={{ fontSize: "14px", letterSpacing: "0.02em" }}>Loading Timeline Studio...</span>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return (
      <AuthModal
        isOpen={true}
        mandatory={true}
        user={null}
        onAuthSuccess={handleAuthSuccess}
      />
    );
  }

  return (
    <App
      currentUser={currentUser}
      onLogout={handleLogout}
    />
  );
}
