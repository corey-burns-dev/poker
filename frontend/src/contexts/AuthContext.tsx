import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ApiRequestError, getBackendUrl, requestJson } from "../lib/api";

export type User = {
  id: number;
  email: string;
  username: string;
  balance: number;
};

type AuthContextType = {
  user: User | null;
  authError: string | null;
  authPending: boolean;
  clearAuthError: () => void;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const BACKEND_URL = getBackendUrl();

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authPending, setAuthPending] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const guestLogin = useCallback(async () => {
    try {
      const data = await requestJson<{ data: User }>(
        `${BACKEND_URL}/api/users/guest`,
        {
          method: "POST",
          credentials: "include",
        },
        "Guest login failed",
      );
      setUser(data.data);
    } catch (error) {
      console.error("Failed to authenticate as guest", error);
      setUser(null);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const data = await requestJson<{ data: User }>(
        `${BACKEND_URL}/api/users/me`,
        {
          credentials: "include",
        },
        "Failed to restore your session",
      );

      setUser(data.data);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        // Automatically attempt guest login if no valid session
        await guestLogin();
      } else {
        console.error("Failed to fetch user", error);
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [guestLogin]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    setAuthPending(true);
    setAuthError(null);

    try {
      const data = await requestJson<{ data: User }>(
        `${BACKEND_URL}/api/users/log-in`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: { email, password } }),
          credentials: "include",
        },
        "Login failed",
      );

      setUser(data.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed";
      setAuthError(message);
      throw error;
    } finally {
      setAuthPending(false);
    }
  };

  const register = async (email: string, username: string, password: string) => {
    setAuthPending(true);
    setAuthError(null);

    try {
      const data = await requestJson<{ data: User }>(
        `${BACKEND_URL}/api/users/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: { email, username, password } }),
          credentials: "include",
        },
        "Registration failed",
      );

      setUser(data.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Registration failed";
      setAuthError(message);
      throw error;
    } finally {
      setAuthPending(false);
    }
  };

  const logout = async () => {
    setAuthPending(true);
    setAuthError(null);

    try {
      await requestJson<{ ok: boolean }>(
        `${BACKEND_URL}/api/users/log-out`,
        {
          method: "DELETE",
          credentials: "include",
        },
        "Logout failed",
      );
      setUser(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Logout failed";
      setAuthError(message);
      throw error;
    } finally {
      setAuthPending(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        authError,
        authPending,
        clearAuthError,
        isAuthenticated: user != null,
        loading,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
