export const CANONICAL_OMO_SOURCE_PREFIX = "omo:"

const FOREIGN_HARNESS_PREFIX = /^(?:pi|omp|opencode):/

export function canonicalOmoSourceId(nativeSessionId: string): string {
  if (FOREIGN_HARNESS_PREFIX.test(nativeSessionId)) {
    throw new Error("OMO source identity cannot be derived from another harness prefix")
  }
  if (nativeSessionId.startsWith(CANONICAL_OMO_SOURCE_PREFIX)) return nativeSessionId
  return `${CANONICAL_OMO_SOURCE_PREFIX}${nativeSessionId}`
}
