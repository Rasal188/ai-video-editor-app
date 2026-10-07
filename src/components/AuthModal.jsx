import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, UserCircle, X, CheckCircle, ArrowLeft } from "@phosphor-icons/react";
import "./AuthModal.css";

export function AuthModal({ isOpen, onClose, user, onAuthSuccess, onLogout, mandatory = false }) {
  const [step, setStep] = useState("email"); // "email" | "otp"
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cooldown, setCooldown] = useState(0);

  // Reset state when opening/closing
  useEffect(() => {
    if (!isOpen) {
      setStep("email");
      setOtp("");
      setError(null);
    }
  }, [isOpen]);

  // Cooldown timer tick
  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = setInterval(() => {
      setCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!mandatory && e.key === "Escape" && isOpen) {
        onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, mandatory]);

  if (!isOpen) return null;
  if (typeof document === "undefined") return null;

  const handleRequestOtp = async (e) => {
    e?.preventDefault();
    if (!email || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Failed to send verification code.");
      }

      setStep("otp");
      setCooldown(60);
    } catch (err) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e?.preventDefault();
    if (!otp || otp.trim().length !== 6) {
      setError("Please enter the 6-digit verification code.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Invalid verification code.");
      }

      if (data.user) {
        onAuthSuccess(data.user);
        if (!mandatory) {
          onClose?.();
        }
      }
    } catch (err) {
      setError(err.message || "Failed to verify code.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      onLogout();
      onClose?.();
    } catch {
      onLogout();
      onClose?.();
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div
      className={`auth-modal-backdrop ${mandatory ? "auth-modal-mandatory" : ""}`}
      onClick={mandatory ? undefined : onClose}
    >
      <div className="auth-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="auth-modal-header">
          <h3 className="auth-modal-title">
            <UserCircle size={22} weight="bold" />
            {user ? "Account" : "Sign In / Register"}
          </h3>
          {!mandatory && (
            <button className="auth-modal-close" onClick={onClose} aria-label="Close modal">
              <X size={18} />
            </button>
          )}
        </div>

        {user ? (
          <div>
            <div className="auth-user-card">
              <div className="auth-user-info">
                <div className="auth-user-avatar">
                  {user.displayName?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || "U"}
                </div>
                <div className="auth-user-details">
                  <span className="auth-user-name">{user.displayName || "User"}</span>
                  <span className="auth-user-email">{user.email}</span>
                </div>
              </div>
            </div>
            <p className="auth-modal-description">
              You are signed in with passwordless email OTP. Cloud project sync will be available in Phase 3.
            </p>
            <button
              className="auth-submit-btn"
              style={{ backgroundColor: "#dc2626" }}
              disabled={loading}
              onClick={handleLogout}
            >
              {loading ? <CircleNotch size={18} className="is-spinning" /> : "Sign Out"}
            </button>
          </div>
        ) : step === "email" ? (
          <form className="auth-modal-form" onSubmit={handleRequestOtp}>
            <p className="auth-modal-description">
              Enter your email address to receive a secure, passwordless one-time verification code.
            </p>

            {error ? <div className="auth-error-banner">{error}</div> : null}

            <div className="auth-input-group">
              <label className="auth-input-label" htmlFor="auth-email-input">
                Email Address
              </label>
              <input
                id="auth-email-input"
                className="auth-input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
            </div>

            <button className="auth-submit-btn" type="submit" disabled={loading}>
              {loading ? <CircleNotch size={18} className="is-spinning" /> : "Send Verification Code"}
            </button>
          </form>
        ) : (
          <form className="auth-modal-form" onSubmit={handleVerifyOtp}>
            <p className="auth-modal-description">
              A 6-digit verification code has been sent to <strong>{email}</strong>.
            </p>

            {error ? <div className="auth-error-banner">{error}</div> : null}

            <div className="auth-input-group">
              <label className="auth-input-label" htmlFor="auth-otp-input">
                Verification Code
              </label>
              <input
                id="auth-otp-input"
                className="auth-input auth-otp-input"
                type="text"
                maxLength={6}
                placeholder="••••••"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                autoFocus
                required
              />
            </div>

            <button className="auth-submit-btn" type="submit" disabled={loading || otp.length !== 6}>
              {loading ? <CircleNotch size={18} className="is-spinning" /> : <CheckCircle size={18} />}
              Verify & Sign In
            </button>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <button
                type="button"
                className="auth-secondary-btn"
                onClick={() => {
                  setStep("email");
                  setError(null);
                }}
              >
                <ArrowLeft size={12} style={{ display: "inline", marginRight: 4 }} />
                Change email
              </button>

              <button
                type="button"
                className="auth-secondary-btn"
                disabled={cooldown > 0 || loading}
                onClick={handleRequestOtp}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}
