import { Composio } from "@composio/core";
import type { EndpointDefinition, EndpointReport, EndpointStatus, TestReport } from "./types";

// ── Response helpers ───────────────────────────────────────────────────────

function extractHttpStatus(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  // Direct fields on result
  if (typeof r.status === "number" && r.status >= 100 && r.status < 600) return r.status;
  if (typeof r.statusCode === "number") return r.statusCode;

  // Nested under .data
  if (r.data && typeof r.data === "object") {
    const d = r.data as Record<string, unknown>;
    if (typeof d.status === "number" && d.status >= 100 && d.status < 600) return d.status;
    if (typeof d.statusCode === "number") return d.statusCode;
    if (typeof d.status_code === "number") return d.status_code;
    if (d.response_data && typeof d.response_data === "object") {
      const rd = d.response_data as Record<string, unknown>;
      if (typeof rd.status === "number" && rd.status >= 100) return rd.status;
    }
  }

  // Fallback: Composio's successfull flag (note: intentional typo in SDK)
  if ((r as Record<string, unknown>).successfull === true) return 200;

  return null;
}

function extractResponseData(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  // Unwrap Composio's wrapper to get the actual API response body
  if (r.data && typeof r.data === "object") {
    const d = r.data as Record<string, unknown>;
    if (d.response_data !== undefined) return d.response_data;
    return d;
  }
  return result;
}

function classify(httpStatus: number | null, result: unknown): EndpointStatus {
  if (httpStatus !== null) {
    if (httpStatus >= 200 && httpStatus < 300) return "valid";
    if (httpStatus === 404 || httpStatus === 405 || httpStatus === 501) return "invalid_endpoint";
    if (httpStatus === 401 || httpStatus === 403) return "insufficient_scopes";
    return "error";
  }
  const r = result as Record<string, unknown> | null;
  return r?.successfull ? "valid" : "error";
}

function summarize(status: EndpointStatus, httpStatus: number | null): string {
  const code = httpStatus ? `HTTP ${httpStatus}` : "no HTTP status";
  switch (status) {
    case "valid": return `${code} — endpoint exists and returned a successful response`;
    case "invalid_endpoint": return `${code} — endpoint does not exist in the real API (fake or deprecated)`;
    case "insufficient_scopes": return `${code} — connected account lacks the required OAuth scopes`;
    case "error": return `${code} — unexpected error, bad parameters, or server-side issue`;
  }
}

function sanitize(data: unknown): unknown {
  const raw = JSON.stringify(data) ?? "";
  // Redact emails and names
  const redacted = raw
    .replace(/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/"(?:displayName|name)"\s*:\s*"[^"]{2,80}"/g, '"name":"[redacted]"');
  const truncated = redacted.length > 2000 ? redacted.slice(0, 2000) + "...[truncated]" : redacted;
  try { return JSON.parse(truncated); } catch { return truncated; }
}

function makeRfc2822Base64(to: string, subject: string, body: string): string {
  const msg = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain", "", body].join("\r\n");
  return Buffer.from(msg).toString("base64url");
}

// ── Body builder ───────────────────────────────────────────────────────────

function buildBody(
  ep: EndpointDefinition,
  ctx: { userEmail: string | null }
): Record<string, unknown> | undefined {
  if (!ep.parameters.body) return undefined;

  const to = ctx.userEmail ?? "test@example.com";
  const body: Record<string, unknown> = {};

  for (const field of ep.parameters.body.fields) {
    if (!field.required) continue;
    switch (field.name) {
      case "raw":
        body.raw = makeRfc2822Base64(to, "Endpoint Test", "Automated endpoint test message.");
        break;
      case "message":
        body.message = { raw: makeRfc2822Base64(to, "Draft Test", "Automated test draft.") };
        break;
      case "summary":
        body.summary = "Endpoint Tester — Test Event";
        break;
      case "start":
        body.start = { dateTime: "2026-04-01T10:00:00Z", timeZone: "UTC" };
        break;
      case "end":
        body.end = { dateTime: "2026-04-01T11:00:00Z", timeZone: "UTC" };
        break;
      default:
        if (field.type === "string") body[field.name] = "test";
        else if (field.type === "integer" || field.type === "number") body[field.name] = 1;
        else if (field.type === "boolean") body[field.name] = true;
        else if (field.type === "object") body[field.name] = {};
    }
  }

  return body;
}

// ── Main agent ─────────────────────────────────────────────────────────────

export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const { composio, connectedAccountId, endpoints } = params;

  // ── Resolve real connected account IDs from entity ID ─────────────────────
  // run.ts passes "candidate" as connectedAccountId, but proxyExecute needs
  // the actual account ID (e.g. "ca_xxx"). Look them up by entity.
  type AccountItem = { id: string; status: string; toolkit: { slug: string }; createdAt: string };
  const accountList = await composio.connectedAccounts.list({ entityId: connectedAccountId }) as { items: AccountItem[] };
  const active = accountList.items.filter(a => a.status === "ACTIVE");

  // Pick the most recently created ACTIVE account per toolkit
  const pick = (slug: string) =>
    active
      .filter(a => a.toolkit?.slug === slug)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.id ?? connectedAccountId;

  const gmailAccountId    = pick("gmail");
  const calendarAccountId = pick("googlecalendar");

  console.log(`  Gmail account:    ${gmailAccountId}`);
  console.log(`  Calendar account: ${calendarAccountId}`);

  // Determine which connected account to use based on endpoint path
  const accountFor = (path: string) =>
    path.startsWith("/calendar/") || path.startsWith("/calendar") ? calendarAccountId : gmailAccountId;

  // Composio's Google Calendar connected account already has /calendar/v3 as its
  // base path, so strip that prefix to avoid doubling (e.g. /calendar/v3/calendar/v3/...)
  const normalizeEndpoint = (path: string) =>
    path.startsWith("/calendar/v3") ? path.slice("/calendar/v3".length) : path;

  const proxy = (endpoint: string, method: string, opts: {
    parameters?: Array<{ in: string; name: string; value: unknown }>;
    body?: unknown;
  } = {}) =>
    composio.tools.proxyExecute({
      endpoint: normalizeEndpoint(endpoint),
      method: method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
      connectedAccountId: accountFor(endpoint),
      ...(opts.parameters?.length ? { parameters: opts.parameters } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });

  // ── Phase 1: Gather context needed for dependency resolution ──────────────
  let messageId: string | null = null;
  let eventId: string | null = null;    // from list (pre-existing)
  let testEventId: string | null = null; // from our own CREATE (safe to DELETE)
  let userEmail: string | null = null;

  console.log("Phase 1: gathering context (profile, messageId, eventId)...");

  try {
    const r = await proxy("/gmail/v1/users/me/profile", "GET");
    const d = extractResponseData(r) as Record<string, unknown>;
    userEmail = (d?.emailAddress as string) ?? null;
    console.log(`  Gmail profile OK, email: ${userEmail ? "[found]" : "[not found]"}`);
  } catch (e) {
    console.log(`  Gmail profile failed: ${e}`);
  }

  try {
    const r = await proxy("/gmail/v1/users/me/messages", "GET", {
      parameters: [{ in: "query", name: "maxResults", value: 1 }],
    });
    const d = extractResponseData(r) as Record<string, unknown>;
    const messages = (d?.messages ?? []) as Array<{ id: string }>;
    if (messages.length) {
      messageId = messages[0].id;
      console.log(`  Got messageId: ${messageId}`);
    }
  } catch (e) {
    console.log(`  List messages failed: ${e}`);
  }

  try {
    const r = await proxy("/calendar/v3/calendars/primary/events", "GET", {
      parameters: [{ in: "query", name: "maxResults", value: 1 }],
    });
    const d = extractResponseData(r) as Record<string, unknown>;
    const items = (d?.items ?? []) as Array<{ id: string }>;
    if (items.length) {
      eventId = items[0].id;
      console.log(`  Got eventId: ${eventId}`);
    }
  } catch (e) {
    console.log(`  List events failed: ${e}`);
  }

  // ── Phase 2: Test each endpoint ───────────────────────────────────────────
  console.log("\nPhase 2: testing all endpoints...");
  const results: EndpointReport[] = [];

  for (const ep of endpoints) {
    console.log(`  Testing ${ep.method} ${ep.path} ...`);

    let resolvedPath = ep.path;
    let pathResolutionError: string | null = null;

    // Resolve path parameters
    for (const pp of ep.parameters.path) {
      if (pp.name === "messageId") {
        if (messageId) {
          resolvedPath = resolvedPath.replace(`{${pp.name}}`, messageId);
        } else {
          pathResolutionError = "No messageId available — could not resolve path parameter (list messages may have failed or returned empty)";
        }
      } else if (pp.name === "eventId") {
        // Prefer test event we created so DELETE doesn't remove real data
        const id = testEventId ?? eventId;
        if (id) {
          resolvedPath = resolvedPath.replace(`{${pp.name}}`, id);
        } else {
          pathResolutionError = "No eventId available — could not resolve path parameter (list events may have failed or returned empty)";
        }
      } else {
        pathResolutionError = `Unknown path parameter: ${pp.name}`;
      }
    }

    if (pathResolutionError) {
      results.push({
        tool_slug: ep.tool_slug,
        method: ep.method,
        path: ep.path,
        status: "error",
        http_status_code: null,
        response_summary: pathResolutionError,
        response_body: null,
        required_scopes: ep.required_scopes,
        available_scopes: [],
      });
      continue;
    }

    const body = buildBody(ep, { userEmail });

    let httpStatus: number | null = null;
    let status: EndpointStatus = "error";
    let rawResult: unknown = null;

    try {
      rawResult = await proxy(resolvedPath, ep.method, { body });
      httpStatus = extractHttpStatus(rawResult);
      status = classify(httpStatus, rawResult);

      // If we just created a calendar event, save its ID for DELETE
      if (ep.tool_slug === "GOOGLECALENDAR_CREATE_EVENT" && status === "valid") {
        try {
          const d = extractResponseData(rawResult) as Record<string, unknown>;
          const newId = d?.id as string | undefined;
          if (newId) {
            testEventId = newId;
            console.log(`    Created test eventId: ${testEventId}`);
          }
        } catch { /* ignore */ }
      }
    } catch (err: unknown) {
      status = "error";
      rawResult = { error: err instanceof Error ? err.message : String(err) };
    }

    results.push({
      tool_slug: ep.tool_slug,
      method: ep.method,
      path: ep.path,
      status,
      http_status_code: httpStatus,
      response_summary: summarize(status, httpStatus),
      response_body: sanitize(rawResult),
      required_scopes: ep.required_scopes,
      available_scopes: [],
    });
  }

  const summary = {
    valid: results.filter(r => r.status === "valid").length,
    invalid_endpoint: results.filter(r => r.status === "invalid_endpoint").length,
    insufficient_scopes: results.filter(r => r.status === "insufficient_scopes").length,
    error: results.filter(r => r.status === "error").length,
  };

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: endpoints.length,
    results,
    summary,
  };
}
