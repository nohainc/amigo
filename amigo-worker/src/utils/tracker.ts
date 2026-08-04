let subrequestsCount = 0;
const SUBREQUESTS_LIMIT = 42; // Safety margin (Cloudflare limit is 50)

export function resetSubrequestsCount(): void {
  subrequestsCount = 0;
}

export function getSubrequestsCount(): number {
  return subrequestsCount;
}

export function checkSubrequestsCapacity(required = 1): void {
  if (subrequestsCount + required > SUBREQUESTS_LIMIT) {
    throw new Error("SUBREQUESTS_LIMIT_EXCEEDED");
  }
}

export async function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  checkSubrequestsCapacity(1);
  subrequestsCount++;
  console.log(`[Subrequest Tracker] Fetch #${subrequestsCount}: ${typeof input === "string" ? input.substring(0, 80) : input.toString().substring(0, 80)}`);
  return fetch(input, init);
}
