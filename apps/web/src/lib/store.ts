"use client";
import { create } from "zustand";
import { api, getToken, setToken, clearToken, runtimePath } from "./api";

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  // Load the token from localStorage and validate it against /api/auth/me.
  hydrate: () => Promise<void>;
  setAuth: (token: string, user: User) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  token: null,
  loading: true,
  hydrate: async () => {
    const token = getToken();
    if (!token) {
      set({ loading: false, user: null, token: null });
      return;
    }
    try {
      const user = await api.get<User>("/api/auth/me");
      set({ user, token, loading: false });
    } catch {
      clearToken();
      set({ user: null, token: null, loading: false });
    }
  },
  setAuth: (token, user) => {
    setToken(token);
    set({ token, user, loading: false });
  },
  logout: () => {
    clearToken();
    set({ user: null, token: null });
    if (typeof window !== "undefined") window.location.href = runtimePath("/login");
  },
}));
