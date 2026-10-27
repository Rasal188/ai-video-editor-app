import { useState, useEffect, useCallback } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { App } from "../App.jsx";
import { Dashboard } from "./Dashboard.jsx";
import { AuthModal } from "./AuthModal.jsx";
import { useToast } from "../hooks/useToast.js";
import "./AuthModal.css";

export function AuthGate() {
  const [authState, setAuthState] = useState("checking"); // "checking" | "authenticated" | "unauthenticated"
  const [currentUser, setCurrentUser] = useState(null);
  const [currentView, setCurrentView] = useState(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("view") === "editor" || params.get("project") || window.location.pathname === "/editor") {
        return "editor";
      }
    }
    return "dashboard";
  });
  const [activeProject, setActiveProject] = useState(null);
  const [initialImportFile, setInitialImportFile] = useState(null);
  const [initialGeneratedProject, setInitialGeneratedProject] = useState(null);
  const { notify, toast } = useToast(3000, "en");

  // Check URL on load if a project ID is present
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const projectId = params.get("project");
      if (projectId && (!activeProject || activeProject.id !== projectId)) {
        let isCancelled = false;
        fetch(`/api/projects/${projectId}`, { credentials: "include" })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (!isCancelled && data?.project) {
              setActiveProject(data.project);
              setCurrentView("editor");
            }
          })
          .catch(() => {});
        return () => {
          isCancelled = true;
        };
      }
    }
  }, [activeProject]);

  // Listen to popstate for browser Back/Forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const view = params.get("view");
      const projId = params.get("project");
      if (view === "editor" || projId || window.location.pathname === "/editor") {
        setCurrentView("editor");
      } else {
        setCurrentView("dashboard");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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
    setActiveProject(null);
    setInitialGeneratedProject(null);
    setCurrentView("dashboard");
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      url.searchParams.delete("project");
      window.history.pushState({}, "", url);
    }
  }, []);

  const handleOpenProject = useCallback((project) => {
    setActiveProject(project);
    setInitialImportFile(null);
    setInitialGeneratedProject(null);
    setCurrentView("editor");
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "editor");
      if (project?.id) {
        url.searchParams.set("project", project.id);
      }
      window.history.pushState({}, "", url);
    }
  }, []);

  const handleImportArchive = useCallback((file) => {
    setActiveProject(null);
    setInitialImportFile(file);
    setInitialGeneratedProject(null);
    setCurrentView("editor");
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "editor");
      url.searchParams.delete("project");
      window.history.pushState({}, "", url);
    }
  }, []);

  const handleOpenGeneratedProject = useCallback((project) => {
    setActiveProject(null);
    setInitialImportFile(null);
    setInitialGeneratedProject(project);
    setCurrentView("editor");
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "editor");
      url.searchParams.delete("project");
      window.history.pushState({}, "", url);
    }
  }, []);

  const handleBackToDashboard = useCallback(() => {
    setActiveProject(null);
    setInitialImportFile(null);
    setInitialGeneratedProject(null);
    setCurrentView("dashboard");
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      url.searchParams.delete("project");
      window.history.pushState({}, "", url);
    }
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
    <>
      {currentView === "dashboard" ? (
        <Dashboard
          currentUser={currentUser}
          onLogout={handleLogout}
          onOpenProject={handleOpenProject}
          onImportArchive={handleImportArchive}
          onOpenGeneratedProject={handleOpenGeneratedProject}
          notify={notify}
        />
      ) : (
        <App
          currentUser={currentUser}
          onLogout={handleLogout}
          activeProject={activeProject}
          initialImportFile={initialImportFile}
          initialGeneratedProject={initialGeneratedProject}
          onBackToDashboard={handleBackToDashboard}
        />
      )}
      {toast && (
        <aside className="toast" role="status" aria-live="polite">
          {toast}
        </aside>
      )}
    </>
  );
}
