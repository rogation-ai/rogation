import { Nango } from "@nangohq/node";
import { env } from "@/env";

let _nango: Nango | null = null;

export function getNango(): Nango | null {
  if (!env.NANGO_SECRET_KEY) return null;
  if (_nango) return _nango;
  _nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });
  return _nango;
}

export function nangoConfigured(): boolean {
  return !!env.NANGO_SECRET_KEY;
}

export type NangoProvider = "slack" | "hotjar";

export interface NangoConnectionMeta {
  nangoConnectionId: string;
  provider: NangoProvider;
}

/**
 * Create a short-lived connect session token for the frontend.
 * Nango deprecated public keys (July 2025); the new flow is:
 *   1. Server creates session token via secret key
 *   2. Frontend opens Connect UI with that token
 */
export async function createConnectSession(endUser: {
  id: string;
  email: string;
  displayName: string;
}): Promise<string> {
  const nango = getNango();
  if (!nango) throw new Error("Nango is not configured");

  const response = await nango.createConnectSession({
    end_user: {
      id: endUser.id,
      email: endUser.email,
      display_name: endUser.displayName || endUser.email,
    },
  });

  return response.data.token;
}

export function __resetNangoForTest(): void {
  _nango = null;
}
