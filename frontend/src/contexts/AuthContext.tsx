import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export type User = {
  id: number;
  email: string;
  username: string;
  balance: number;
};

type AuthContextType = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/users/me`, {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setUser(data.data);
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error('Failed to fetch user', error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    const response = await fetch(`${BACKEND_URL}/api/users/log-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { email, password } }),
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      setUser(data.data);
    } else {
      const data = await response.json();
      throw new Error(data.error || 'Login failed');
    }
  };

  const register = async (email: string, username: string, password: string) => {
    const response = await fetch(`${BACKEND_URL}/api/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { email, username, password } }),
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      setUser(data.data);
    } else {
      const data = await response.json();
      throw new Error(Object.entries(data.errors).map(([k, v]) => `${k} ${v}`).join(', ') || 'Registration failed');
    }
  };

  const logout = async () => {
    await fetch(`${BACKEND_URL}/api/users/log-out`, {
      method: 'DELETE',
      credentials: 'include'
    });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
