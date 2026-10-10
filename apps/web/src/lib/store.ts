"use client";
import { create } from "zustand";
import { api, getToken, setToken, clearToken, runtimePath } from "./api";
import { getHostRuntime, navigatePointer } from "./host-runtime";

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
    const host = getHostRuntime();
    if (host) { set({ user: host.user, token: null, loading: false }); return; }
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
    const host = getHostRuntime();
    if (host) { host.onSignOut(); return; }
    clearToken();
    set({ user: null, token: null });
    if (typeof window !== "undefined") navigatePointer(runtimePath("/login"));
  },
}));
