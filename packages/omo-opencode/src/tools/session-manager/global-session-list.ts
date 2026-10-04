import { log } from "../../shared"
import { getServerBasicAuthHeader } from "../../shared/opencode-server-auth"
import { getServerBaseUrl } from "../../shared/opencode-http-api"
import { normalizeSDKResponse } from "../../shared/normalize-sdk-response"
import type { SessionMetadata } from "./types"

const PAGE_LIMIT = 100

type FetchLike = typeof fetch

let fetchImplementation: FetchLike | undefined
const serverUrls = new WeakMap<object, string>()

export function setGlobalSessionServerUrl(client: object, serverUrl: URL | string | undefined): void {
  if (!serverUrl) {
    serverUrls.delete(client)
    return
  }
  serverUrls.set(client, serverUrl instanceof URL ? serverUrl.toString() : serverUrl)
}

export function _setGlobalSessionFetchForTesting(fetchImpl: FetchLike | undefined): void {
  fetchImplementation = fetchImpl
}

function getFetch(): FetchLike {
  return fetchImplementation ?? fetch
}

type ExperimentalList = (parameters?: {
  roots?: boolean | "true" | "false"
  cursor?: number
  limit?: number
}) => Promise<unknown>

type GlobalListClient = {
  experimental?: {
    session?: {
      list?: ExperimentalList
    }
  }
}

export class GlobalSessionListUnavailable extends Error {
  constructor() {
    super("experimental session list is unavailable")
    this.name = "GlobalSessionListUnavailable"
  }
}

function isMetadata(value: unknown): value is SessionMetadata {
  if (!value || typeof value !== "object") return false
  const record = value as { id?: unknown; time?: { updated?: unknown } }
  return typeof record.id === "string" && typeof record.time?.updated === "number"
}

function readNextCursor(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const headers = (value as { headers?: unknown; response?: { headers?: unknown } }).headers
    ?? (value as { response?: { headers?: { get?: unknown } } }).response?.headers
  if (!headers || typeof headers !== "object" || typeof (headers as { get?: unknown }).get !== "function") {
    return undefined
  }
  const raw = (headers as { get: (name: string) => string | null }).get("x-next-cursor")
  if (!raw) return undefined
  const cursor = Number(raw)
  return Number.isFinite(cursor) ? cursor : undefined
}

function resolveBaseUrl(client: unknown): string | null {
  if (client && typeof client === "object") {
    const bound = serverUrls.get(client)
    if (bound) return bound
  }
  return getServerBaseUrl(client)
}

async function fetchGlobalPage(
  baseUrl: string,
  input: { roots: boolean; cursor?: number },
): Promise<{ sessions: SessionMetadata[]; nextCursor?: number }> {
  const url = new URL("/experimental/session", baseUrl)
  url.searchParams.set("limit", String(PAGE_LIMIT))
  if (input.roots) url.searchParams.set("roots", "true")
  if (input.cursor !== undefined) url.searchParams.set("cursor", String(input.cursor))

  const headers: Record<string, string> = {}
  const auth = getServerBasicAuthHeader()
  if (auth) headers.Authorization = auth

  const response = await getFetch()(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (response.status === 404) throw new GlobalSessionListUnavailable()
  if (!response.ok) {
    throw new Error(`experimental session list failed: ${response.status}`)
  }

  const body: unknown = await response.json()
  const sessions = normalizeSDKResponse(body, [] as SessionMetadata[]).filter(isMetadata)
  const rawCursor = response.headers.get("x-next-cursor")
  const nextCursor = rawCursor ? Number(rawCursor) : undefined
  return {
    sessions,
    nextCursor: nextCursor !== undefined && Number.isFinite(nextCursor) ? nextCursor : undefined,
  }
}

async function pageExperimentalList(
  list: ExperimentalList,
  input: { roots: boolean },
): Promise<SessionMetadata[]> {
  return collectPages(async (cursor) => {
    const response = await list({
      roots: input.roots ? true : undefined,
      limit: PAGE_LIMIT,
      cursor,
    })
    const sessions = normalizeSDKResponse(response, [] as SessionMetadata[]).filter(isMetadata)
    return { sessions, nextCursor: readNextCursor(response) }
  })
}

async function collectPages(
  load: (cursor?: number) => Promise<{ sessions: SessionMetadata[]; nextCursor?: number }>,
): Promise<SessionMetadata[]> {
  const seen = new Set<string>()
  const sessions: SessionMetadata[] = []
  let cursor: number | undefined

  for (;;) {
    const page = await load(cursor)
    let added = 0
    for (const session of page.sessions) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
      added += 1
    }

    if (added === 0 || page.nextCursor === undefined || page.nextCursor === cursor) break
    cursor = page.nextCursor
  }

  return sessions.sort((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
}

export async function listGlobalSessions(
  client: unknown,
  input: { roots: boolean },
): Promise<SessionMetadata[]> {
  const experimental = (client as GlobalListClient).experimental?.session?.list
  if (typeof experimental === "function" && !resolveBaseUrl(client)) {
    return pageExperimentalList(experimental, input)
  }

  const baseUrl = resolveBaseUrl(client)
  if (!baseUrl) {
    log("[session-manager] global session list unavailable", { reason: "no-base-url" })
    throw new GlobalSessionListUnavailable()
  }

  try {
    const sessions = await collectPages((cursor) => fetchGlobalPage(baseUrl, { roots: input.roots, cursor }))
    log("[session-manager] global session list", { count: sessions.length, roots: input.roots })
    return sessions
  } catch (error) {
    log("[session-manager] global session list failed", { error: String(error) })
    if (error instanceof GlobalSessionListUnavailable) throw error
    throw error
  }
}
