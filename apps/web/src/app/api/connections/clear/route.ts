/**
 * POST /api/connections/clear
 * Wipes the session cookie. Used by the Disconnect button.
 */

import { jsonResponse } from "@/lib/utils";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST() {
  const session = await getSession();
  session.destroy();
  return jsonResponse({ ok: true });
}
