"use client";

import { createBrowserClient } from "@supabase/ssr";

import { publicEnv } from "@/config/public-env";

/**
 * Browser Supabase client. Uses the anon key only — every query it makes is
 * subject to Row Level Security.
 *
 * It must never be used to read `facebook_page_connections.access_token_encrypted`;
 * RLS will deny that column to all roles, and Page tokens are read exclusively
 * by server code through the service-role client.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
}
