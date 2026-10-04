import { afterEach, describe, expect, test } from "bun:test"
import { getSdkAllSessions, getSdkMainSessions, sdkSessionExists } from "./sdk-storage"
import { _setGlobalSessionFetchForTesting, setGlobalSessionServerUrl } from "./global-session-list"
import { canonicalOmoSourceId } from "./source-identity"
import type { PluginInput } from "@opencode-ai/plugin"

const SERVER = "http://127.0.0.1:4096"
const NONGIT = "/tmp/nongit"
const OTHER = "/tmp/other-project"

type Page = {
  sessions: Array<{
    id: string
    directory: string
    parentID?: string
    time: { created: number; updated: number }
  }>
  nextCursor?: string
}

function clientWith(pages: Page[], scoped: Array<{ id: string; directory: string; time: { created: number; updated: number }; parentID?: string }> = []) {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(`${url.pathname}${url.search}`)
    const cursor = url.searchParams.get("cursor")
    const selected = pages[cursor ? indexOfCursor(pages, cursor) : 0]
    if (!selected) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify(selected.sessions), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(selected.nextCursor ? { "x-next-cursor": selected.nextCursor } : {}),
      },
    })
  }) as typeof fetch
  const client = {
    session: {
      list: async () => ({ data: scoped }),
      get: async ({ path }: { path: { id: string } }) => {
        const found = pages.flatMap((item) => item.sessions).find((session) => session.id === path.id)
        if (!found) throw { name: "NotFoundError", message: `Session not found: ${path.id}` }
        return { data: found }
      },
      messages: async () => ({ data: [] }),
    },
  }
  setGlobalSessionServerUrl(client, SERVER)
  _setGlobalSessionFetchForTesting(fetchImpl)
  return { client: client as unknown as PluginInput["client"], calls }
}

function indexOfCursor(pages: Page[], cursor: string): number {
  const previous = pages.findIndex((page) => page.nextCursor === cursor)
  return previous + 1
}

afterEach(() => {
  _setGlobalSessionFetchForTesting(undefined)
})

describe("global session enumeration", () => {
  test("lists non-git history outside the scoped session.list result", async () => {
    const historical = {
      id: "ses_historical",
      directory: NONGIT,
      time: { created: 10, updated: 30 },
    }
    const foreign = {
      id: "ses_other",
      directory: OTHER,
      time: { created: 9, updated: 20 },
    }
    const { client, calls } = clientWith(
      [{ sessions: [historical, foreign] }],
      [{ id: "ses_scoped_only", directory: NONGIT, time: { created: 1, updated: 1 } }],
    )

    const ids = await getSdkAllSessions(client)

    expect(ids).toEqual(["ses_historical", "ses_other"])
    expect(calls.some((call) => call.startsWith("/experimental/session"))).toBe(true)
    expect(calls.some((call) => call.includes("directory="))).toBe(false)
    expect(ids).not.toContain("ses_scoped_only")
  })

  test("reads a session by id when it is absent from the scoped list", async () => {
    const historical = {
      id: "ses_direct",
      directory: OTHER,
      time: { created: 10, updated: 30 },
    }
    const { client } = clientWith([{ sessions: [historical] }], [])

    await expect(sdkSessionExists(client, "ses_direct")).resolves.toBe(true)
    await expect(sdkSessionExists(client, "ses_missing")).resolves.toBe(false)
  })

  test("pages the global list and drops duplicate ids", async () => {
    const newer = { id: "ses_new", directory: NONGIT, time: { created: 3, updated: 30 } }
    const overlap = { id: "ses_mid", directory: NONGIT, time: { created: 2, updated: 20 } }
    const older = { id: "ses_old", directory: OTHER, time: { created: 1, updated: 10 } }
    const { client, calls } = clientWith([
      { sessions: [newer, overlap], nextCursor: "20" },
      { sessions: [overlap, older], nextCursor: "10" },
      { sessions: [older] },
    ])

    const ids = await getSdkAllSessions(client)

    expect(ids).toEqual(["ses_new", "ses_mid", "ses_old"])
    expect(new Set(ids).size).toBe(ids.length)
    expect(calls.filter((call) => call.includes("cursor=")).length).toBe(2)
  })

  test("keeps directory filtering after unscoped enumeration", async () => {
    const local = { id: "ses_local", directory: `${NONGIT}/`, time: { created: 2, updated: 20 } }
    const child = { id: "ses_child", directory: NONGIT, parentID: "ses_local", time: { created: 3, updated: 30 } }
    const foreign = { id: "ses_foreign", directory: OTHER, time: { created: 1, updated: 10 } }
    const { client, calls } = clientWith([{ sessions: [child, local, foreign] }])

    const sessions = await getSdkMainSessions(client, NONGIT)

    expect(sessions.map((session) => session.id)).toEqual(["ses_local"])
    expect(calls.some((call) => call.includes("roots=true"))).toBe(true)
  })

  test("keeps native OMO source ids stable and refuses a Pi prefix", () => {
    expect(canonicalOmoSourceId("8f1c")).toBe("omo:8f1c")
    expect(canonicalOmoSourceId("omo:8f1c")).toBe("omo:8f1c")
    expect(() => canonicalOmoSourceId("pi:8f1c")).toThrow("another harness prefix")
  })
})
