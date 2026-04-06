import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase';
import type { User, Session } from '@supabase/supabase-js';

export interface AppUser {
  id: string;
  auth_id: string | null;
  email: string;
  full_name: string | null;
  role: 'user' | 'admin';
  wallet_address?: string | null;
}

export interface OutletContext {
  user: AppUser | null;
}

interface AuthContextType {
  user: AppUser | null;
  session: Session | null;
  isLoading: boolean;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null; sessionCreated?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error: Error | null }>;
  updateProfile: (data: { full_name?: string }) => Promise<{ error: Error | null }>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  try { return new Error(JSON.stringify(err)); } catch { return new Error('Unknown error'); }
}

function getAppOrigin(): string {
  const envUrl = (import.meta.env.VITE_APP_URL as string | undefined)?.replace(/\/+$/, '');
  return envUrl || window.location.origin;
}

function normalizeSignupError(error: { message?: string; status?: number } | null): Error | null {
  if (!error) return null;
  const rawMsg = (error.message ?? '').trim();
  const status = error.status;

  // Detect empty / unparseable body (the root cause of "error {}")
  const isEmptyBody =
    !rawMsg ||
    rawMsg === '{}' ||
    rawMsg === '[]' ||
    rawMsg === 'null' ||
    rawMsg.length < 3;

  if (isEmptyBody) {
    if (status === 422 || status === 400) {
      return new Error('Invalid email address or password. Please check and try again.');
    }
    if (status && status >= 500) {
      return new Error(
        'Email delivery failed. Please check your Supabase SMTP settings ' +
        '(Supabase → Auth → SMTP Settings) or disable custom email templates temporarily and try again.'
      );
    }
    if (status === 429) {
      return new Error('Too many signup attempts. Please wait a few minutes and try again.');
    }
    return new Error(
      `Signup failed (HTTP ${status ?? 'unknown'}). ` +
      'Check your Supabase SMTP and email template settings.'
    );
  }

  const lower = rawMsg.toLowerCase();

  if (
    lower.includes('smtp') ||
    lower.includes('email rate') ||
    lower.includes('sending') ||
    lower.includes('over_email_send_rate_limit') ||
    lower.includes('email could not be') ||
    lower.includes('failed to send')
  ) {
    return new Error(
      'Email delivery failed. Please check your Supabase SMTP settings ' +
      '(Supabase → Auth → SMTP Settings) and try again.'
    );
  }

  if (lower.includes('rate limit') || lower.includes('too many')) {
    return new Error('Too many signup attempts. Wait a few minutes and try again.');
  }

  if (lower.includes('already registered') || lower.includes('user already exists')) {
    return new Error('An account with this email already exists. Please sign in.');
  }

  return new Error(rawMsg);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Track the last auth_id we fetched a profile for — skip redundant fetches
  const lastLoadedAuthId = useRef<string | null>(null);
  // Whether the onAuthStateChange listener has fired at least once
  const listenerFired = useRef(false);
  // Set to true while signIn() is doing its own fetchAppUser to prevent the
  // onAuthStateChange handler from doing a redundant second fetch
  const signInFetchInProgress = useRef(false);
  // Track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);

  const fetchAppUser = useCallback(async (authUser: User): Promise<AppUser> => {
    const minimal: AppUser = {
      id: authUser.id,
      auth_id: authUser.id,
      email: authUser.email!,
      full_name: authUser.user_metadata?.full_name ?? null,
      role: 'user',
    };

    try {
      type ProfileRow = Record<string, unknown>;

      const { data: rowByAuthId } = await supabase
        .from('users')
        .select('*')
        .eq('auth_id', authUser.id)
        .maybeSingle();

      let row: ProfileRow | null = rowByAuthId as ProfileRow | null;

      if (!row) {
        const { data: rowByEmail } = await supabase
          .from('users')
          .select('*')
          .eq('email', authUser.email!)
          .maybeSingle();
        row = rowByEmail as ProfileRow | null;
      }

      if (row) {
        // Backfill auth_id if missing (legacy row)
        if (!row['auth_id']) {
          supabase
            .from('users')
            .update({ auth_id: authUser.id })
            .eq('id', row['id'])
            .then(() => {});
        }
        return { ...row, auth_id: row['auth_id'] ?? authUser.id } as unknown as AppUser;
      }

      // Row doesn't exist yet — create it (trigger may not have run yet on fresh signup)
      const { data: newRow } = await supabase.from('users').upsert(
        {
          auth_id: authUser.id,
          email: authUser.email!,
          full_name: authUser.user_metadata?.full_name ?? null,
          role: 'user',
        },
        { onConflict: 'auth_id' }
      ).select().maybeSingle();

      supabase.from('user_balances').upsert(
        { user_email: authUser.email!, balance_usd: 0, total_invested: 0, total_profit_loss: 0 },
        { onConflict: 'user_email' }
      ).then(() => {});

      if (newRow) return newRow as unknown as AppUser;
      return minimal;
    } catch (err) {
      console.warn('[Salarn] fetchAppUser: using minimal user (schema may not be applied yet):', err);
      return minimal;
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const { data: { session: current } } = await supabase.auth.getSession();
    if (current?.user) {
      lastLoadedAuthId.current = null;
      const appUser = await fetchAppUser(current.user);
      if (mountedRef.current) setUser(appUser);
    }
  }, [fetchAppUser]);

  useEffect(() => {
    mountedRef.current = true;

    // ── Subscribe FIRST so we never miss an event ──
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mountedRef.current) return;

      listenerFired.current = true;
      setSession(newSession);

      if (!newSession?.user) {
        lastLoadedAuthId.current = null;
        setUser(null);
        if (mountedRef.current) setIsLoading(false);
        return;
      }

      // Skip redundant fetch on token refresh when we already have the user
      if (
        event === 'TOKEN_REFRESHED' &&
        lastLoadedAuthId.current === newSession.user.id &&
        user !== null
      ) {
        if (mountedRef.current) setIsLoading(false);
        return;
      }

      // If signIn() is already fetching the profile, don't duplicate
      if (signInFetchInProgress.current && lastLoadedAuthId.current === newSession.user.id) {
        if (mountedRef.current) setIsLoading(false);
        return;
      }

      lastLoadedAuthId.current = newSession.user.id;
      const appUser = await fetchAppUser(newSession.user);

      if (mountedRef.current) {
        setUser(appUser);
        setIsLoading(false);
      }
    });

    // ── Then do the initial session check ──
    const initAuth = async () => {
      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        if (!mountedRef.current) return;

        // If the listener already handled state, just clear loading
        if (listenerFired.current) {
          if (mountedRef.current) setIsLoading(false);
          return;
        }

        if (currentSession?.user) {
          setSession(currentSession);
          lastLoadedAuthId.current = currentSession.user.id;
          const appUser = await fetchAppUser(currentSession.user);
          if (mountedRef.current && !listenerFired.current) {
            setUser(appUser);
            setIsLoading(false);
          }
        } else {
          if (mountedRef.current && !listenerFired.current) {
            setUser(null);
            setSession(null);
            setIsLoading(false);
          }
        }
      } catch {
        if (mountedRef.current) setIsLoading(false);
      }
    };

    initAuth();

    return () => {
      mountedRef.current = false;
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAppUser]);

  const signUp = async (email: string, password: string, fullName: string) => {
    try {
      const origin = getAppOrigin();
      const redirectTo = `${origin}/auth/callback`;
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectTo,
          data: { full_name: fullName },
        },
      });

      if (error) {
        console.error('[Salarn] signUp error —', {
          message: error.message,
          status: (error as { status?: number }).status,
          raw: error,
        });
        const normalized = normalizeSignupError({
          message: error.message,
          status: (error as { status?: number }).status,
        });
        return { error: normalized };
      }

      // identities: [] means the email is already registered
      // (Supabase doesn't return an error for duplicate signups by default)
      if (data?.user && data.user.identities?.length === 0) {
        return { error: new Error('An account with this email already exists. Please sign in.') };
      }

      const sessionCreated = !!(data?.session);
      return { error: null, sessionCreated };
    } catch (err) {
      return { error: toError(err) };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error && data?.user) {
        // Mark that we're handling the profile fetch here so the listener
        // doesn't fire a duplicate fetch when SIGNED_IN event arrives
        signInFetchInProgress.current = true;
        lastLoadedAuthId.current = data.user.id;
        const appUser = await fetchAppUser(data.user);
        if (mountedRef.current) {
          setUser(appUser);
          setSession(data.session);
        }
        signInFetchInProgress.current = false;
      }
      return { error: error ? toError(error) : null };
    } catch (err) {
      signInFetchInProgress.current = false;
      return { error: toError(err) };
    }
  };

  const resetPassword = async (email: string) => {
    try {
      const origin = getAppOrigin();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/callback`,
      });
      return { error: error ? toError(error) : null };
    } catch (err) {
      return { error: toError(err) };
    }
  };

  const signOut = async () => {
    // Reset all tracking refs before signOut so the next login starts clean
    lastLoadedAuthId.current = null;
    listenerFired.current = false;
    signInFetchInProgress.current = false;
    if (mountedRef.current) {
      setIsLoading(false);
      setUser(null);
      setSession(null);
    }
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
  };

  const updateProfile = async (data: { full_name?: string }) => {
    if (!user) return { error: new Error('Not authenticated') };
    try {
      const { error } = await supabase
        .from('users')
        .update({ ...data, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      if (!error && mountedRef.current) setUser(prev => prev ? { ...prev, ...data } : null);
      return { error: error ? toError(error) : null };
    } catch (err) {
      return { error: toError(err) };
    }
  };

  return (
    <AuthContext.Provider value={{ user, session, isLoading, signUp, signIn, signOut, resetPassword, updateProfile, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
